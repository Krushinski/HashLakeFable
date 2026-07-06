import * as THREE from 'three/webgpu'
import { WaterSystem, Sky as WaterProSky, getPresetParams } from '../threejs-water-pro'
import { SkySystem, PRESETS as SKY_PRESETS } from '../threejs-sky-pro'
import type { BoatSystem } from './boatSystem'

/**
 * Water Pro + Sky Pro integration — the licensed FFT ocean and volumetric
 * sky, tuned down to an alpine lake and driven by the Bitcoin weather
 * engine. Replaces the hand-rolled water/sky/wake stack:
 *
 *  - WaterSystem (FFT waves, SSR, foam, wake field, buoyancy, spray)
 *  - SkySystem (volumetric clouds, atmosphere, god-ray-capable, time of day)
 *  - the sky feeds the water's reflections via asSkyProvider({envMap})
 *  - bow + stern wake generators ride the hull; amplitude follows speed
 *  - the boat floats on a hidden buoyancy proxy: Water Pro resolves the
 *    proxy's heave/pitch/roll each frame and BoatSystem copies the pose
 *
 * The terrain bounds the "ocean": everywhere outside the lake basin the
 * land is above waterline and simply occludes it, so the infinite FFT
 * plane reads as our lake with zero masking.
 */

/**
 * Storm-tier anchors, lake-scaled. Hard constraint: shore elevations are
 * only 1-4 m above waterline, so TOTAL surface displacement (FFT + Gerstner
 * swell) must stay well under ~1 m even at full storm or the water visually
 * crests over the beaches. Wind speeds are fetch-limited (~2 km basin):
 * JONSWAP peak wavelength at 12 m/s is already ~90 m — beyond that the
 * spectrum wants open-ocean rollers.
 */
const WATER_TIERS = {
  windSpeed: [3, 4.5, 7, 9.5, 12],
  amplitude: [0.15, 0.22, 0.32, 0.45, 0.6],
  choppiness: [1.0, 1.15, 1.3, 1.45, 1.6],
  // Gerstner is Water Pro's analytic large-swell layer, SEPARATE from the
  // FFT. Presets ship it at ocean scale (dusk: 1.76 m × 451 m) — that was
  // the "water floods the land" bug. Lake swell: a long low breathing of
  // the surface, never a wall.
  swellAmp: [0.03, 0.05, 0.09, 0.15, 0.22],
  swellLen: [18, 22, 28, 34, 42],
}

/** FFT cascade tiles, lake-scaled (dusk ships 2642 m / 241 m — ocean fetch).
 *  Order invariant: cascade 0 (waves) must stay larger than 1 (ripples).
 *  NOTE (verified in lib): effective world tile = scale * resolution/256,
 *  so at medium (cascade0 res 128) a config of 840 tiles the world every
 *  420 m — the value below is pre-compensated. Ripples (res 256) are 1:1. */
const CASCADES = {
  waves: { scale: 840, amplitudeScale: 0.2 },
  ripples: { scale: 90, amplitudeScale: 0.083 },
}

/** Sky preset per tier band. */
const SKY_TIERS = ['partlyCloudy', 'partlyCloudy', 'hazy', 'stormyEvening', 'thunderstorm'] as const

function lerpA(arr: number[], t: number): number {
  const i = Math.min(arr.length - 2, Math.floor(t))
  const f = Math.min(1, t - i)
  return arr[i] + (arr[i + 1] - arr[i]) * f
}

export class ProWater {
  water!: WaterSystem
  sky!: SkySystem
  wpSky: WaterProSky | null = null
  private renderer!: THREE.WebGPURenderer
  private envRefresh = 0
  /** Hidden buoyancy proxy — Water Pro writes its pose, the boat reads it. */
  readonly boatProxy: THREE.Mesh
  private bowWakeId = -1
  private sternWakeId = -1
  private lastSkyBand = -1
  private lastWaveBand = -1
  /** Wake-field anchor: stand-in Object3D fed to WakeSystem so the 700 m
   *  wake window centers on the BOAT, not the orbiting/teleporting camera.
   *  The lib's anchor resolver sees forward.y = 0 and uses this position
   *  verbatim; boat motion is always < 175 m/frame, so the field can never
   *  hard-clear from camera pitch swings or C-preset teleports again. */
  private readonly wakeAnchor = new THREE.Object3D()
  private boatRef: BoatSystem | null = null
  private envBaker: { enabled: boolean; bakeAll(): void } | null = null

  private constructor() {
    this.boatProxy = new THREE.Mesh(
      new THREE.BoxGeometry(5.9, 1.1, 1.8),
      new THREE.MeshBasicMaterial(),
    )
    this.boatProxy.visible = false
  }

  static async create(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ): Promise<ProWater> {
    // r183→r185 shim: PassNode.setPixelRatio became setResolutionScale;
    // Sky Pro was built against the older name
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passProto = (THREE as any).PassNode?.prototype
    if (passProto && !passProto.setPixelRatio) {
      passProto.setPixelRatio = function (r: number) {
        return this.setResolutionScale(r)
      }
    }

    const p = new ProWater()
    p.renderer = renderer
    const flags = new URLSearchParams(location.search)

    console.log('[boot] sky:create')
    p.sky = await SkySystem.create({
      renderer,
      camera,
      // 'high' on both libs pinned the RTX 3050 at ~18 fps — and low fps
      // is upstream of everything: solver stability margins, cloud
      // reprojection swim, input feel. Medium buys the headroom back.
      quality: 'medium',
      // mid-afternoon alpine light — high, bright sun
      timeOfDay: { time: 0.58 },
    })
    console.log('[boot] sky:preset')
    await p.sky.applyPreset(SKY_PRESETS.partlyCloudy)

    console.log('[boot] water:create')
    // NOTE: deterministic fixed-substep mode measured 1 fps here (its
    // per-substep sync points serialize the GPU) — stability comes from
    // the dt clamp in update() instead: one sim step per frame, never
    // fed more than 33ms. Uncapped 50-70ms steps at low fps blew past
    // the wake solver's stability limit — the field amplified its own
    // energy into jagged peaks no friction could damp (the "nightmare
    // physics" / hurricane-shake session).
    p.water = await WaterSystem.create(renderer, scene, camera, 'medium')
    p.water.loadPreset(getPresetParams('dusk'))
    p.water.updateCascadeConfig(0, CASCADES.waves)
    p.water.updateCascadeConfig(1, CASCADES.ripples)

    // ---- sky → water reflection bridge ----
    // Sky Pro 1.0's provider adapter speaks Water Pro 2.x; v3.1's setSky
    // wants its own texture-backed Sky. Bridge: asSkyProvider({envMap})
    // spins up Sky Pro's equirect baker (ticked inside sky.update), and
    // we feed its texture — volumetric clouds included — to a Water Pro
    // Sky. PMREM refresh happens on a cadence in update().
    console.log('[boot] sky:provider')
    const provider = p.sky.asSkyProvider({ envMap: { width: 512 } })
    for (const m of provider.getMeshes()) scene.add(m)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baker = (p.sky as any)._providerEnvMap
    baker.bakeAll()
    // The provider baker defaults to re-raymarching the full cloud+sky
    // equirect EVERY frame (SkySystem.update ticks it, skipFrames 0)
    // while we only consume it on the 6s PMREM cadence — a whole cloud
    // raymarch per frame thrown away. Disable the per-frame tick;
    // bakeAll() on the cadence ignores `enabled` (documented API).
    // ?envbake restores per-frame baking for A/B.
    baker.enabled = flags.has('envbake')
    p.envBaker = baker
    const equirect: THREE.Texture = baker.texture
    equirect.mapping = THREE.EquirectangularReflectionMapping
    p.wpSky = new WaterProSky({
      equirect,
      sunDirection: p.water.lighting.sun.direction.value,
    })
    p.water.setSky(p.wpSky)

    // our real terrain is the lake bed — hide the procedural ocean floor
    p.water.floor.setVisible(false)

    // the dusk preset ships warm-amber lights that brown the alpine
    // meadows — neutralize toward clean daylight
    p.water.lighting.sunLight.color.set(0xfff4e2)
    p.water.lighting.sunLight.intensity = 3.4
    p.water.lighting.hemisphereLight.color.set(0xbdd5e4)
    p.water.lighting.hemisphereLight.groundColor.set(0x4d5a44)
    p.water.lighting.hemisphereLight.intensity = 0.85

    // dusk's warm-brown atmospheric fog repaints the whole basin — pull
    // it back to a thin alpine haze. (The old 'startDistance'/'start'
    // guards silently no-oped for a week: the real properties are
    // fadeStart/fadeEnd/fadePower.) Distances sized for the LAKE_SCALE
    // world — the far shore sits ~4.5 km out now.
    p.water.fog.color = '#c4d2d8'
    p.water.fog.fadeStart = 1400
    p.water.fog.fadeEnd = 9000
    p.water.fog.fadePower = 1.0
    p.water.fog.skyBlendDistance = 4200

    // ---- lake tuning pass 1 (verify live on pages.dev) ----
    // Wake field: dusk ships ocean physics — trail damping γ 0.25 and
    // foamBreakThreshold 0, i.e. foam at ANY surface steepness. Fast
    // laps inject energy faster than the field damps, so the basin
    // whips into permanent white peaks ("nightmare physics"). A lake
    // is stiffer and only foams on genuinely breaking crests.
    // Lake-scale wake tune for a HEALTHY solver (the old 1.4/0.4 values
    // were panic-damping against the r185-corrupted sim): moderately
    // damped trails, foam on real crests only.
    // 0.9 not 0.5: the dt clamp runs the sim at ~40% speed at 25fps, so
    // decay must be stiffer than real-lake values for trails to die on
    // a human timescale
    p.water.wake.friction = 0.9
    // Visible-wake tune (verified against the sim's gating math): the
    // dt-clamped sim runs ~40% speed at 25fps and rarely reaches 0.2
    // steepness, which is why the old trail was near-invisible.
    p.water.wake.foamStrength = 1.0
    p.water.wake.foamBreakThreshold = 0.08

    // Nobody dives in this game — and the underwater pass is what
    // painted the teal band across the screen bottom whenever a camera
    // dipped near the displaced surface ("chopped out" in C-angles).
    p.water.underwater.enabled = false

    // THE BANNER, actual root cause (survived every other fix): Water
    // Pro clips the water surface at a plane near the camera to draw
    // its underwater-transition meniscus — everything between camera
    // and that plane exposes the naked lakebed as a hard-edged band
    // across the frame bottom. We never cross the surface, so collapse
    // the clip to nothing and drop the meniscus with it.
    p.water.clipPlaneDistance = 0.05
    p.water.waterline.enabled = false

    // Wake stays default-ON (?nowake for A/B). NOTE: spray is compiled
    // out at medium tier (sprayMaxParticles 0) — the flag is kept for
    // future higher tiers only.
    p.water.wake.enabled = !flags.has('nowake')
    if (p.water.spray) p.water.spray.enabled = !flags.has('nospray')

    // MOBILE-PARADOX root cause (verified in lib): WakeSystem anchors
    // its 700 m field at the camera-forward/ground hit (±350 m) and
    // HARD-CLEARS the whole wake+foam field on any anchor jump >175 m.
    // Desktop orbit/pitch/teleports wiped the field on every swing;
    // mobile's fixed camera never did — hence mobile's pretty wake.
    // Anchor the window to the boat instead: the wake's camera ref is
    // read only inside its step() anchor resolver; buoyancy and foam
    // accumulation keep the real camera. WARNING: never call the
    // WaterSystem-level camera setter after this — it would re-propagate
    // the real camera into the wake. ?wakecam reverts for A/B.
    if (p.water.wake.enabled && !flags.has('wakecam')) {
      p.water.wake.setCamera(p.wakeAnchor as unknown as THREE.Camera)
    }

    // Crest-foam accumulation: EXONERATED (exact-texel bounds-checked
    // window copy — cannot smear; dusk even ships it disabled). ON now:
    // real whitecaps at storm tiers, richer wake interplay.
    p.water.foam.waves.enabled = !flags.has('nocrestfoam')

    // THE BANNER / NADIR VOID / STREAK-ZONE root cause (endgame sweep,
    // verified in-bundle): shoreline foam's zone mask multiplies water
    // COLOR AND ALPHA by (1 - mask), and dusk ships range 35 — water
    // went fully transparent wherever the view-depth column dropped
    // below ~17.5 m. Bottom-of-frame pixels ALWAYS have a thin column,
    // so a bed-colored band followed the camera everywhere; at nadir
    // the whole lake (< 17.5 m deep) rendered as naked bed with the
    // foam texture as pale streak lines. range 4 = the water only
    // clears in the last ~2 m of column at the true beach edge — a
    // legible waterline instead of a vanishing lake.
    p.water.foam.shoreline.range = 4

    // SSR: the medium-tier clamp only runs at create — a post-create
    // enable STICKS, and it also turns on the scene-color pass that
    // above-water refraction reads (it was sampling a never-rendered
    // BLACK texture: the second layer of near-field deadness, and why
    // refractionStrength appeared inert). Real refracted lakebed +
    // near-field reflections. ?nossr for the fps A/B.
    if (!flags.has('nossr')) p.water.ssr.enabled = true

    // ?nofog probe for the tan bottom-of-screen haze band (set at
    // create-time — post-build toggles black-screen)
    if (flags.has('nofog')) p.water.fog.enabled = false

    // Alpine water, not brown murk: dusk's absorption (~0.1/m) is so
    // clear our sand-colored lakebed shows through everywhere — water
    // and wet beach read as the same brown, hiding the shoreline.
    // Stronger red-first extinction sinks the bed into teal by ~2-3 m
    // depth, so the waterline becomes a legible color edge.
    // "Boat in a brown void" root cause: at steep view angles water
    // reflects ~nothing (Fresnel), so the frame shows pure transmitted
    // bed — flat tan, zero surface cues — and the eye reads NO WATER
    // (also the tan bottom-band at normal angles, and the "exposed
    // propeller": the submerged hull seen through clear water). Cures:
    // deeper extinction, darker body, visible refraction wobble, and
    // stronger normal response so the surface reads at nadir.
    p.water.color.absorptionColor = '#7d4526'
    p.water.color.transmissionColor = '#2e7b6e'
    p.water.color.waterColor = '#0f3540'
    p.water.fresnel.refractionStrength = 0.35
    p.water.fresnel.normalStrength = 1.25

    // X-ARTIFACT PRIME SUSPECT: rain is the only world-anchored system
    // that was ON in every X sighting (foam accumulation proven inert
    // under dusk; wake foam zeroed under ?nowake; caustics floor-only
    // and the floor is hidden; spray compiled out at medium). Default
    // OFF; ?rain re-enables for the attribution A/B.
    p.water.rain.particles.enabled = flags.has('rain')
    p.water.rain.ripples.enabled = flags.has('rain')

    // Sparkle exonerated for the streaks (they were the shoreline zone
    // + clipmap strips) — near-field glints restored to the dusk default.
    p.water.sparkle.enabled = !flags.has('nosparkle')
    p.water.sparkle.minDistance = 0
    if (flags.has('nosurfacefoam')) p.water.foam.surface.enabled = false
    if (flags.has('noshorefoam')) p.water.foam.shoreline.enabled = false

    // calm lake baseline
    console.log('[boot] water:baseline')
    p.applyWeatherRaw(0, 0)

    scene.add(p.boatProxy)
    return p
  }

  /** Register the hull with the buoyancy + wake systems (after boat load). */
  attachBoat(boat: BoatSystem): void {
    this.boatRef = boat
    this.wakeAnchor.position.set(boat.group.position.x, 0, boat.group.position.z)
    this.water.buoyancy.addObject(this.boatProxy, {
      multiPoint: true,
      useBoundingBox: false,
      sampleLength: 5.4,
      sampleWidth: 1.7,
      heightSmoothing: 0.12,
      rotationSmoothing: 0.16,
      rotationInfluence: 0.75,
    })
    // Generators only exist when the wake field runs (?nowake A/B).
    // Radii sized to the field: at medium the wake texture is 2.73 m per
    // texel — our old 1.6-1.9 m stamps were SUB-TEXEL (aliased injection,
    // broken-looking trail). Vendor default is radius 4 / depth 1.2.
    if (!this.water.wake.enabled) return
    this.bowWakeId = this.water.wake.addGenerator(boat.group, {
      depth: 0.45,
      radius: 3.5,
      offset: new THREE.Vector3(0, 0, 2.3),
    })
    this.sternWakeId = this.water.wake.addGenerator(boat.group, {
      depth: 0.9,
      radius: 4.5,
      offset: new THREE.Vector3(0, 0, -2.5),
    })
  }

  /** Scale the wake with throttle — planing hulls dig harder. Saturating
   *  curve, not linear: past ~25 m/s a planing hull rides OUT of the water,
   *  so displacement stops growing (the old linear ramp at 150 mph churned
   *  the whole basin into froth). Idle ramp: a parked hull displaces
   *  nothing worth simulating — without it the generators pump the field
   *  24/7 (endless rings + scratch streaks around a resting boat). */
  setBoatSpeed(speedMps: number): void {
    if (this.sternWakeId < 0) return
    const idle = Math.min(1, Math.max(0, speedMps - 0.3) / 2.5)
    const k = 1 - Math.exp(-speedMps / 14)
    this.water.wake.updateGenerator(this.sternWakeId, {
      depth: (0.7 + k * 0.7) * idle,
      radius: 4.5 + k * 1.5,
    })
    this.water.wake.updateGenerator(this.bowWakeId, {
      depth: (0.45 + k * 0.35) * idle,
      radius: 3.5 + k * 1.0,
    })
  }

  /** Bitcoin weather → spectrum + sky. Called from the tier applier. */
  applyWeatherRaw(tierT: number, skyDark: number): void {
    const waveBand = Math.round(tierT * 4)
    if (waveBand !== this.lastWaveBand) {
      this.lastWaveBand = waveBand
      const w = this.water.waves
      w.update({
        animationSpeed: 1,
        amplitude: lerpA(WATER_TIERS.amplitude, tierT),
        windSpeed: lerpA(WATER_TIERS.windSpeed, tierT),
        // RADIANS, not degrees (verified in lib: no degToRad on this
        // path) — the old literal 130 was ~20.7 full turns, i.e. an
        // effectively arbitrary wind heading every spectrum recompute
        windDirection: THREE.MathUtils.degToRad(130),
        choppiness: lerpA(WATER_TIERS.choppiness, tierT),
        gravity: 9.81,
        jonswapGamma: 3.3,
        spectralSharpness: 0.6 + tierT * 0.08,
        standingWaveRatio: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      this.water.gerstner.update({
        amplitude: lerpA(WATER_TIERS.swellAmp, tierT),
        wavelength: lerpA(WATER_TIERS.swellLen, tierT),
        wavelengthSpread: 1.6,
        directionalSpread: 0.9,
      })
    }

    const skyBand = Math.min(4, Math.floor(tierT + skyDark))
    if (skyBand !== this.lastSkyBand) {
      this.lastSkyBand = skyBand
      void this.sky.applyPreset(SKY_PRESETS[SKY_TIERS[skyBand]])
    }
  }

  /** Advance both simulations. Water update is async (GPU readbacks). */
  async update(dt: number): Promise<void> {
    const rawDt = Math.min(dt, 0.1) // wall-clock dt, clamped only vs tab-switch spikes
    // clamp the sim step to 60Hz-sized: 33ms steps STILL let the wake
    // field self-amplify at 18 fps (user's mountain-trail screenshots).
    // Below 60 fps the water runs proportionally slow-motion — stable
    // and calm beats realtime and exploding.
    dt = Math.min(dt, 1 / 60)
    this.sky.update(dt)
    // keep the water's sun/light in step with Sky Pro's sun
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const skySun = (this.sky.sun as any)
    if (skySun?.direction?.value) {
      this.water.lighting.sun.direction.value.copy(skySun.direction.value)
    }
    // refresh the reflection PMREM from the sky at a low cadence (6s —
    // at 1.5s the PMREM prefilter spiked the GPU like clockwork). The
    // equirect itself is also only re-raymarched HERE now (per-frame
    // baking disabled in create) — one cloud march per 6s, not per frame.
    this.envRefresh += dt
    if (this.wpSky && this.envRefresh > 6) {
      this.envRefresh = 0
      this.envBaker?.bakeAll()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(this.wpSky as any).uploadSource(this.renderer)
    }
    // keep the wake window riding the hull (see create(): wake anchor)
    if (this.boatRef) {
      this.wakeAnchor.position.set(
        this.boatRef.group.position.x,
        0,
        this.boatRef.group.position.z,
      )
    }
    // Wake foamPersistence is applied PER SIM STEP by the lib (raw
    // uniform multiply, one step per frame) — derive from RAW frame dt
    // for an fps-independent trail. 0.02^dt ≈ a ~4s visible foam wake
    // (the 0.0018 value killed the trail in ~2s: 'no foam off the
    // stern'); friction 0.9 remains the stability backstop.
    if (this.sternWakeId >= 0) {
      this.water.wake.foamPersistence = Math.pow(0.02, rawDt)
    }
    await this.water.update(dt)
  }

  /** Fan window resizes into both libs — neither watches the window
   *  itself, and skipping this leaves every screen-space buffer (and the
   *  sky's temporal history) on the wrong grid after a resize. */
  resize(width: number, height: number): void {
    this.water.resize(width, height)
    this.sky.resize(width, height)
  }
}
