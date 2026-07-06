import * as THREE from 'three/webgpu'
import {
  WaterSystem,
  Sky as WaterProSky,
  getPresetParams,
  QUALITY_LEVELS,
} from '../threejs-water-pro'
import { SkySystem, PRESETS as SKY_PRESETS } from '../threejs-sky-pro'
import { LAKE_SCALE, waterDepth } from './lakeMap'
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

/** Water quality tier. HIGH is the demo look: domain-warped foam + screen
 *  refraction + 256/256 FFT — the two features that make the vendor
 *  demo's surface lacework. ?wqmedium falls back for the fps A/B. */
const WATER_QUALITY = new URLSearchParams(location.search).has('wqmedium')
  ? ('medium' as const)
  : ('high' as const)

/** FFT cascade tiles, lake-scaled (dusk ships 2642 m / 241 m — ocean fetch).
 *  Order invariant: cascade 0 (waves) must stay larger than 1 (ripples).
 *  NOTE (verified in lib): effective world tile = scale * resolution/256,
 *  so the waves cascade config is tier-compensated (res 128 at medium,
 *  256 at high) to hold the same 420 m world tile. Ripples (256) are 1:1. */
const CASCADES = {
  waves: {
    scale: WATER_QUALITY === 'medium' ? 840 : 420,
    amplitudeScale: 0.2,
  },
  ripples: { scale: 90, amplitudeScale: 0.083 },
}

/** Sky preset per tier band. Serene gets the FABLE GLOW — bright sunny
 *  stylized cumulus (§user: "absolutely stunning and sunny"), not gray
 *  partly-cloudy. */
const SKY_TIERS = ['pixar', 'partlyCloudy', 'hazy', 'stormyEvening', 'thunderstorm'] as const

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
  private sprayTailId = -1
  private sprayCornersId = -1
  private lastSprayBand = -1
  private lastSkyBand = -1
  private lastWaveBand = -1
  /** Wake-field anchor: stand-in Object3D fed to WakeSystem so the 700 m
   *  wake window centers on the BOAT, not the orbiting/teleporting camera.
   *  The lib's anchor resolver sees forward.y = 0 and uses this position
   *  verbatim; boat motion is always < 175 m/frame, so the field can never
   *  hard-clear from camera pitch swings or C-preset teleports again. */
  private readonly wakeAnchor = new THREE.Object3D()
  /** Stern-spray mount: copies the boat pose each frame, then sweeps
   *  vertically through the displaced surface while planing. The spray
   *  gate only fires on a downward surface CROSSING — a planing hull on
   *  calm water never crosses on its own (verified live: 0-3% duty at
   *  Serene even with near-zero thresholds), so the rig manufactures
   *  the crossings at a cadence we own. Parked, it rides the pose
   *  exactly and stays silent. */
  private readonly sprayRig = new THREE.Object3D()
  private sprayPhase = 0
  private rainAllowed = true
  private lastRainOn = false
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
      // 'high' on BOTH libs pinned the 3050 at ~18 fps in the 2.2 world —
      // but the world has shrunk and the waste is gone since. Water runs
      // high now; ?skyhigh probes the volumetric-cloud tier on top.
      quality: flags.has('skyhigh') ? 'high' : 'medium',
      // mid-afternoon alpine light — high, bright sun
      timeOfDay: { time: 0.58 },
    })
    console.log('[boot] sky:preset')
    await p.sky.applyPreset(SKY_PRESETS.pixar)
    p.liftCloudDeck(0)

    // Sky Pro bakes a 256² cloud-shadow map EVERY frame (65k texels × 8
    // light steps of 3D noise) whose only consumers are god-rays and the
    // cloudShadowFactor TSL helper — we wire up neither, so the bake is
    // pure per-frame waste (~0.3-1 ms on the 3050). The setter's contract:
    // false skips the bake and drives the enabled uniform so any receiver
    // reads full sun. Re-enable if god rays ever land.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const skyPipeline = (p.sky as any).pipeline
    if (skyPipeline?.cloudShadow) skyPipeline.cloudShadow.enabled = false

    console.log('[boot] water:create')
    // Spray at medium: the tier ships sprayMaxParticles 0, which keeps
    // the whole system unallocated (tryCreate treats the count as a
    // boolean — the pool is a fixed 512 slots whenever it allocates, and
    // it is WebGPU-only, which we are). The quality config is read BY
    // REFERENCE at create time, so flipping the two spray fields here
    // buys the rooster tail without touching any other medium setting
    // (SSR steps, FFT res, mesh segments all stay medium).
    QUALITY_LEVELS.medium.sprayMaxParticles = 512
    QUALITY_LEVELS.medium.sprayEnabledByDefault = true
    // Full-res scene color at high (ultra's value): the half-res copy is
    // what refraction samples, and its edge texels bled the dark hull
    // one half-res step into the surrounding water — the last layer of
    // the "fuzz around the hero" (§user). Costs ~1 ms.
    QUALITY_LEVELS.high.sceneColorResolutionScale = 1.0
    // NOTE: deterministic fixed-substep mode measured 1 fps here (its
    // per-substep sync points serialize the GPU) — stability comes from
    // the dt clamp in update() instead: one sim step per frame, never
    // fed more than 33ms. Uncapped 50-70ms steps at low fps blew past
    // the wake solver's stability limit — the field amplified its own
    // energy into jagged peaks no friction could damp (the "nightmare
    // physics" / hurricane-shake session).
    p.water = await WaterSystem.create(renderer, scene, camera, WATER_QUALITY)
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
    // CLOUDS BEHIND MOUNTAINS (§user, turquoise pass): the cloud
    // composite quad ships depthTest=false — a pure screen overlay that
    // painted cloud sheets ACROSS the hero range's face. Its fullscreen
    // triangle sits at the far plane under WebGPU reverse-z, so enabling
    // the depth test clips clouds behind terrain while open sky (cleared
    // depth) still passes. Vendor default is fine over their flat ocean;
    // wrong under 900 m peaks. ?cloudoverlay restores the overlay.
    if (!flags.has('cloudoverlay')) {
      for (const m of provider.getMeshes()) {
        const mesh = m as THREE.Mesh
        const mat = mesh.material as THREE.Material | undefined
        if (mat && mat.depthTest === false && mesh.renderOrder === -5) {
          mat.depthTest = true
        }
      }
    }
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

    // our real terrain is the lake bed — hide the procedural ocean floor.
    // Its Caustics instance stays alive (wave-buffer-wired at create) and
    // main.ts weaves its pattern node into OUR terrain shader; tune the
    // pattern for a lake here: tighter cells than the 65 m ocean tile,
    // a touch brighter since our shallows are where the eye lives.
    p.water.floor.setVisible(false)
    p.water.floor.caustics.scale = 34
    p.water.floor.caustics.intensity = 1.15 // white sand carries caustics
    p.water.floor.caustics.waveDistortion = 0.28

    // THE PINK SUN (red-hunt, certainty-grade): the vendor's lighting
    // subsystem re-syncs the THREE lights from ITS OWN sources every
    // frame — the old writes to sunLight/hemisphereLight died within a
    // frame, leaving dusk's salmon-pink sun (#fdc4c9 @ 2.0) and dim warm
    // ambient painting every surface tan for WEEKS. This is why no bed
    // palette change could ever kill the red. Write the SOURCES. The rig
    // is blackFlag's daylight — near-white sun + bright pale-CYAN
    // ambient, the actual secret of the demo's white-sand look.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lighting = p.water.lighting as any
    lighting.sun.color.set(0xfffef5)
    if (lighting.sun.intensity?.value !== undefined) {
      lighting.sun.intensity.value = 2.5
    }
    lighting.ambient.skyColor.set(0xd2e3f9)
    lighting.ambient.groundColor.set(0xabe0f2)
    lighting.ambient.intensity = 1.3

    // dusk's warm-brown atmospheric fog repaints the whole basin — pull
    // it back to a thin alpine haze. (The old 'startDistance'/'start'
    // guards silently no-oped for a week: the real properties are
    // fadeStart/fadeEnd/fadePower.) Distances RIDE LAKE_SCALE — they
    // were tuned at 2.2 (far shore ~4.5 km) and must shrink with the
    // world or the haze never reaches the near shores.
    // FLOOR at 0.55: air doesn't shrink with the map — pure linear
    // scaling at 0.75x put fadeStart at ~480 m and muted the shore
    // treeline into gray soup (§user)
    const FOG_S = Math.max(0.55, LAKE_SCALE / 2.2)
    p.water.fog.color = '#c4d2d8'
    p.water.fog.fadeStart = 1400 * FOG_S
    p.water.fog.fadeEnd = 9000 * FOG_S
    p.water.fog.fadePower = 1.0
    p.water.fog.skyBlendDistance = 4200 * FOG_S

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
    // 1.05 (was 0.9): the accumulated field at 150 mph sloshed on as a
    // "seesaw" chasing the boat into shores (§user) — stiffer damping
    // kills the standing energy within a couple of seconds
    p.water.wake.friction = 1.05
    // Visible-wake tune (verified against the sim's gating math): the
    // dt-clamped sim runs ~40% speed at 25fps and rarely reaches 0.2
    // steepness, which is why the old trail was near-invisible.
    // trail richened for the smaller swell tune (§user: "where did my
    // beautiful wake go?" — less displacement means less steepness, so
    // foam must deposit a touch easier and harder to keep the ribbon)
    p.water.wake.foamStrength = 1.25
    p.water.wake.foamBreakThreshold = 0.06

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

    // Wake stays default-ON (?nowake for A/B). Spray is now allocated at
    // medium (see the QUALITY_LEVELS patch above create) — ?nospray
    // skips its two compute dispatches for the A/B.
    p.water.wake.enabled = !flags.has('nowake')
    if (p.water.spray) p.water.spray.enabled = !flags.has('nospray')

    // THE DARK-SMOKE PLUME root cause (decoded in-bundle): the vendor's
    // RenderPassManager excludes the clipmap and sky from its aux passes
    // but NEVER the spray mesh — every plume was baked into the
    // scene-color texture the water samples for refraction, so the
    // surface repainted a Beer-Lambert-tinted dark ghost of each plume
    // while the direct white draw was z-culled below the waterline
    // (water draws first at renderOrder -1 with depthWrite on). The
    // depth pass also re-renders transparent meshes with a replacement
    // material that lacks the spray's positionNode — 512 quads collapsed
    // at the origin, feeding garbage to the fog composite. Exclude the
    // spray mesh from both.
    if (p.water.spray) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rpm = (p.water as any).renderPassManager
      const sprayMesh = p.water.spray.getMesh()
      rpm?.depthPass?.excludeObject?.(sprayMesh)
      rpm?.sceneColorPass?.excludeObject?.(sprayMesh)
    }

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
    p.water.foam.shoreline.range = 7

    // SSR: the medium-tier clamp only runs at create — a post-create
    // enable STICKS, and it also turns on the scene-color pass that
    // above-water refraction reads (it was sampling a never-rendered
    // BLACK texture: the second layer of near-field deadness, and why
    // refractionStrength appeared inert). Real refracted lakebed +
    // near-field reflections. ?nossr for the fps A/B.
    // NOTE (measured): the dusk preset ships ssr.enabled=true and
    // loadPreset runs above, so the old `if (!nossr) enable` form left
    // SSR ON under ?nossr — every past ?nossr A/B measured nothing. The
    // flag must actively disable.
    p.water.ssr.enabled = !flags.has('nossr')
    // dusk ships SSR strength 0.9 — at near-grazing chase angles that
    // smears a dark screen-space ghost of the hull sideways across the
    // water ("reflection that shouldn't be there", §user). SSR is the
    // ONLY source of boat-on-water reflections (the env map is sky-only,
    // no hidden cameras) — 0.3 keeps the drifting mirror; setBoatSpeed
    // fades it further with throttle where the artifacts live.
    p.water.ssr.strength = 0.3

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
    // TEAL. Beautiful teal (§user, final verdict of the fork session):
    // the old red-leaning absorption was tuned blind against the
    // transparency bug; with honest refraction the bed showed through
    // red-brown. Stronger red-first extinction + brighter teal
    // transmission + deep alpine body.
    // ABSORPTION, corrected for sRGB→linear (red-hunt): '#8a4a26'
    // converts to only 0.25/m red extinction — 78% of red SURVIVED a
    // 1 m column, so the shore shelves never developed the turquoise
    // veil. '#ff5a2e' is 1.0/m linear red kill: pale turquoise by
    // 0.5 m over white sand, saturated by 3 m — the demo gradient.
    p.water.color.absorptionColor = '#ff5a2e'
    // brighter teal in-scatter — pushes the shoreline turquoise band
    // further out (§user: "more teals near the shorelines", twice)
    p.water.color.transmissionColor = '#3cb69c'
    // deep-body hue: a notch bluer than the fork tune — straight down
    // over the basin the old value read olive-gray instead of alpine
    p.water.color.waterColor = '#0d4554'
    // Beer-Lambert depth normalization: loadPreset silently set this to
    // the dusk OCEAN's 100 m — every depth-graded term (fallback columns,
    // deep-water saturation) was stretched 4× past our basin. This lake
    // bottoms out at MAX_LAKE_DEPTH (14 m post-turquoise verdict).
    p.water.color.waterDepth = 11
    // 0.35 was tuned while refraction sampled a broken black texture —
    // at high tier with honest full-res scene color it over-bent far
    // enough to stamp a pale hull-shaped phantom into the foam beside
    // the boat (verified live at the sandbar). 0.16 wobbles without
    // stealing hull pixels.
    p.water.fresnel.refractionStrength = 0.16
    p.water.fresnel.normalStrength = 1.25

    // Water Pro rain: WIRED TO THE STORM (final push) — ripple rings +
    // particles arrive with the network's rain, handled per-band in
    // applyWeatherRaw. The old X-artifact suspicion kept these behind
    // ?rain; tier-gating confines any recurrence to real storms where
    // rain belongs. ?norain kills them outright for attribution.
    p.rainAllowed = !flags.has('norain')
    p.water.rain.particles.enabled = false
    p.water.rain.ripples.enabled = false

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
    scene.add(p.sprayRig)
    return p
  }

  /** Register the hull with the buoyancy + wake systems (after boat load). */
  attachBoat(boat: BoatSystem): void {
    this.boatRef = boat
    this.wakeAnchor.position.set(boat.group.position.x, 0, boat.group.position.z)

    // The flag and scarf sway via TSL positionNode — but the water's
    // depth pass re-renders meshes with replacement materials that DON'T
    // carry the animation, so their aux-pass depth lies every frame and
    // every consumer (SSR, fog composite, refraction) speckles around
    // them (a big slice of the "fuzz around Satoshi", §user). Exclude
    // the animated cloth from the aux passes — thin waving cloth reads
    // fine as background there.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpm = (this.water as any).renderPassManager
    boat.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const name = mesh.name
      if (
        name.includes('Flag') ||
        name.includes('Scarf') ||
        o.parent?.name.includes('Flag')
      ) {
        rpm?.depthPass?.excludeObject?.(mesh)
        rpm?.sceneColorPass?.excludeObject?.(mesh)
      }
    })
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
    if (this.water.wake.enabled) {
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

    // ---- stern spray rig (rooster tail) ----
    // Three emitters, not one: updateEmitter never touches probe-authored
    // overrides, so the probes stay bare and ALL tuning lives per-emitter
    // — that's what lets updateSpray() retune each part with speed at
    // runtime. Vendor defaults are ship-bow-on-ocean (size 27.5 m!);
    // everything here is resized for a 6 m runabout. Probes sit at the
    // waterline (group origin ≈ water level), local +Z = bow.
    if (this.water.spray) {
      // PROBE HEIGHTS (measured live, 150 mph): the spray gate fires only
      // when a probe CROSSES the displaced surface from above. At planing
      // trim the bow-lift pitch drops the transom ~0.3 m, so probes at the
      // rest waterline ride permanently submerged — impact speeds read
      // 1-10 m/s (threshold 0.45!) yet nothing ever fired. The probes must
      // sit ABOVE the surface at speed, inside the band the waves + stern
      // hump sweep through. Two tail probes at different heights keep one
      // in the envelope across trim states.
      // VELOCITY-FACTOR MATH (decoded in-bundle): sizeScale and
      // heightScale are EACH `min(1 + factor·(impact − threshold), 2)`
      // and they MULTIPLY on the height axis — planing impacts run
      // 1-10 m/s with 14-47 m/s spikes, so factors ≥0.5 saturate both
      // caps and the first live tail rendered as a 100 m streak column.
      // heightFactor stays 0 (kills the double multiplication); tiny
      // scale factors let the 2× cap engage only on the hardest hits.
      // tall narrow plume off the transom center — THE rooster tail.
      // Tail + corners mount on the CHURN RIG (see sprayRig above);
      // probe heights sit so the rig's sweep carries them through the
      // waterline every cycle even with the planing squat (~-0.3 m at
      // the transom from bow-lift pitch).
      this.sprayTailId = this.water.spray.addEmitter(this.sprayRig, {
        active: false, // planing gate flips it on (updateSpray)
        probes: [
          { local: new THREE.Vector3(0, 0.35, -2.7) },
          { local: new THREE.Vector3(0, 0.55, -2.75) },
        ],
        size: 3.2,
        stretchX: 0.5,
        stretchY: 2.0,
        opacity: 0.5,
        duration: 1.1,
        fadeOutTime: 0.55,
        // thresholds LIVE-VERIFIED at speed: crossings of the displaced
        // surface are mostly gentle (0.05-0.4 m/s) — 0.45 rejected nearly
        // everything and the tail never lit. Near-zero threshold + short
        // respawn = continuous plume; the planing gate (updateSpray)
        // keeps it silent below 20 mph regardless.
        respawnTime: 0.12,
        spawnJitterTime: 0.1,
        submersionDepth: 0.15,
        velocityThreshold: 0.05,
        velocityScaleFactor: 0.08,
        velocityHeightFactor: 0,
      })
      // low wide fans off the transom corners
      this.sprayCornersId = this.water.spray.addEmitter(this.sprayRig, {
        active: false,
        probes: [
          { local: new THREE.Vector3(-0.75, 0.42, -2.45) },
          { local: new THREE.Vector3(0.75, 0.42, -2.45) },
        ],
        size: 2.6,
        stretchX: 1.9,
        stretchY: 0.9,
        opacity: 0.35,
        duration: 0.9,
        fadeOutTime: 0.45,
        respawnTime: 0.15,
        spawnJitterTime: 0.18,
        submersionDepth: 0.15,
        velocityThreshold: 0.08,
        velocityScaleFactor: 0.06,
        velocityHeightFactor: 0,
      })
      // bow cheeks: always armed but thresholded high — they only fire
      // on real wave slams, so storm chop buys bow spray for free
      this.water.spray.addEmitter(boat.group, {
        probes: [
          { local: new THREE.Vector3(-0.62, 0.05, 2.15) },
          { local: new THREE.Vector3(0.62, 0.05, 2.15) },
        ],
        size: 3.2,
        stretchX: 1.6,
        stretchY: 1.1,
        opacity: 0.5,
        duration: 1.0,
        fadeOutTime: 0.5,
        respawnTime: 0.4,
        spawnJitterTime: 0.15,
        submersionDepth: 0.15,
        velocityThreshold: 1.6,
        velocityScaleFactor: 0.15,
        velocityHeightFactor: 0,
      })
    }
  }

  /** Stern spray rides the throttle: off below planing (~20 mph), then
   *  the tail grows/steepens with speed. Patched in coarse bands so the
   *  per-frame cost is a comparison, not an emitter re-upload. */
  private updateSpray(speedMps: number): void {
    if (this.sprayTailId < 0 || !this.water.spray) return
    const planing = speedMps > 8.9
    const k = planing ? 1 - Math.exp(-(speedMps - 8.9) / 20) : 0
    const band = planing ? 1 + Math.round(k * 7) : 0
    if (band === this.lastSprayBand) return
    this.lastSprayBand = band
    // sized against the ~1.3-2× velocity sizeScale at planing impacts:
    // top-speed tail ≈ 5.6 × 2.6 × 1.3-2 ≈ 19-29 m — dramatic, not a
    // skyscraper (the first tune hit 100 m: see the factor note above)
    this.water.spray.updateEmitter(this.sprayTailId, {
      active: planing,
      size: 3.2 + k * 2.4,
      stretchY: 2.0 + k * 0.6,
      opacity: 0.5 + k * 0.2,
    })
    this.water.spray.updateEmitter(this.sprayCornersId, {
      active: planing,
      size: 2.6 + k * 1.6,
      opacity: 0.35 + k * 0.2,
    })
  }

  /** Scale the wake with throttle — planing hulls dig harder. Saturating
   *  curve, not linear: past ~25 m/s a planing hull rides OUT of the water,
   *  so displacement stops growing (the old linear ramp at 150 mph churned
   *  the whole basin into froth). Idle ramp: a parked hull displaces
   *  nothing worth simulating — without it the generators pump the field
   *  24/7 (endless rings + scratch streaks around a resting boat). */
  setBoatSpeed(speedMps: number): void {
    this.updateSpray(speedMps)
    if (this.sternWakeId < 0) return
    const idle = Math.min(1, Math.max(0, speedMps - 0.3) / 2.5)
    const k = 1 - Math.exp(-speedMps / 14)
    // shallow-water attenuation (§user): full-throttle swells near shore
    // dug the trough below the bed — naked lakebed flashing through the
    // surface. Displacement fades as the column thins; the hull grounds
    // at 0.7 m anyway.
    let shallow = 1
    if (this.boatRef) {
      const d = waterDepth(this.boatRef.x, this.boatRef.z)
      shallow = Math.min(1, Math.max(0.3, (d - 0.8) / 2.7))
    }
    // top-end swell trimmed (§user: 150 mph wake "slightly too big"):
    // stern peaks at 1.15 not 1.4 — still a real wall, no basin-churner
    this.water.wake.updateGenerator(this.sternWakeId, {
      depth: (0.62 + k * 0.33) * idle * shallow,
      radius: 4.5 + k * 1.5,
    })
    this.water.wake.updateGenerator(this.bowWakeId, {
      depth: (0.4 + k * 0.18) * idle * shallow,
      radius: 3.5 + k * 1.0,
    })
    // SSR fades with speed: screen-space reflections are where the
    // "impossible" displaced hull ghosts live, and they worsen with
    // motion — near-mirror when drifting, whisper at full throttle
    this.water.ssr.strength = 0.3 - k * 0.12
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
      void this.sky
        .applyPreset(SKY_PRESETS[SKY_TIERS[skyBand]])
        .then(() => this.liftCloudDeck(skyBand))
    }

    // Water Pro surface rain rides the storm: ripple rings + falling
    // streaks from Violent upward (tierT ≥ 2.4 tracks the network's
    // rain dial crossing ~0.4)
    const rainOn = this.rainAllowed && tierT >= 2.4
    if (rainOn !== this.lastRainOn) {
      this.lastRainOn = rainOn
      this.water.rain.particles.enabled = rainOn
      this.water.rain.ripples.enabled = rainOn
    }
  }

  /** Calm/mild skies ride a HIGHER cloud deck: preset bases (~1400 m)
   *  sit right at the summit line of the now-close hero range and read
   *  as a low gray lid chopping the peaks (§user, turquoise pass).
   *  Storm tiers keep their brooding preset altitude — presets reset
   *  the uniform, so this re-asserts after every calm-band switch. */
  private liftCloudDeck(band: number): void {
    if (band > 2) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clouds = (this.sky as any).clouds
    if (clouds?.altitude?.value !== undefined) {
      clouds.altitude.value = Math.max(clouds.altitude.value, 2300)
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
      // churn rig: ride the boat pose, then sweep the stern probes
      // through the waterline while planing — peak vertical sweep speed
      // ≈ 2π·2.2Hz·0.24m ≈ 3.3 m/s, well over the fire threshold, so
      // every downward pass births a plume (see sprayRig field note)
      const b = this.boatRef.group
      this.sprayRig.position.copy(b.position)
      this.sprayRig.quaternion.copy(b.quaternion)
      const spd = Math.abs(this.boatRef.speed)
      const churn = Math.min(1, Math.max(0, (spd - 8.9) / 18))
      if (churn > 0) {
        this.sprayPhase += rawDt * 2.2 * Math.PI * 2
        this.sprayRig.position.y +=
          (Math.sin(this.sprayPhase) * 0.24 - 0.18) * churn
      }
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
