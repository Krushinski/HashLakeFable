import * as THREE from 'three/webgpu'
import { positionGeometry, vec4 } from 'three/tsl'
import {
  WaterSystem,
  Sky as WaterProSky,
  getPresetParams,
  QUALITY_LEVELS,
} from '../threejs-water-pro'
import { SkySystem, PRESETS as SKY_PRESETS } from '../threejs-sky-pro'
import { LAKE_SCALE, waterDepth } from './lakeMap'
import { NIGHT_ACTIVE } from '../core/nightWatch'
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

/** Night — moonlit lake under procedural stars (swarm-verified recipe:
 *  moonlitNight sky preset + anti-solar moon lighting the water + a
 *  canvas starfield; weather bands keep driving waves/rain, but sky
 *  presets are frozen so no daylight preset can clobber the night).
 *  Auto-engages on EST night (20:00–06:00); ?night / ?day override. */
const NIGHT = NIGHT_ACTIVE

/** Tileable equirect starfield, drawn once at boot — the night panorama
 *  samples UV-mapped sRGB and multiplies by intensity × skyDarkness, so
 *  a plain 8-bit canvas is exactly the expected input. Equal-area star
 *  scatter (uniform UV over-densifies the poles) + a tilted Milky Way
 *  ribbon + temperature-tinted bright stars. */
function makeStarfieldTexture(): THREE.CanvasTexture {
  const W = 2048
  const H = 1024
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  let s = 0x9e3779b9
  const rnd = () =>
    ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000)
  const bandV = (u: number) => 0.5 + 0.1 * Math.sin(u * Math.PI * 2 + 1.7)
  for (let i = 0; i < 900; i++) {
    // milky way ribbon: soft overlapping glow blobs along a sine band
    const u = rnd()
    const v = bandV(u) + (rnd() + rnd() + rnd() - 1.5) * 0.06
    const x = u * W
    const y = v * H
    const r = 8 + rnd() * 32
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(150,170,210,${(0.02 + rnd() * 0.03).toFixed(3)})`)
    g.addColorStop(1, 'rgba(150,170,210,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  const star = (inBand: boolean) => {
    const u = rnd()
    let v = rnd()
    if (inBand) v = bandV(u) + (rnd() + rnd() + rnd() - 1.5) * 0.05
    else while (rnd() > Math.cos((v - 0.5) * Math.PI)) v = rnd()
    const x = u * W
    const y = v * H
    const b = rnd() ** 3
    if (b < 0.7) {
      ctx.fillStyle = `rgba(255,255,255,${((0.25 + b) * (inBand ? 0.55 : 1)).toFixed(3)})`
      ctx.fillRect(x, y, 1, 1)
    } else {
      const t = rnd()
      const cr = (180 + t * 75) | 0
      const cg = (195 + t * 45) | 0
      const cb = (255 - t * 65) | 0
      const r = b > 0.94 ? 2.5 : 1.5
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(${cr},${cg},${cb},1)`)
      g.addColorStop(0.4, `rgba(${cr},${cg},${cb},0.5)`)
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`)
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
  }
  for (let i = 0; i < 3500; i++) star(false)
  for (let i = 0; i < 1200; i++) star(true)
  return new THREE.CanvasTexture(cv)
}

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
  private lastFricBand = 0
  private rainAllowed = true
  private lastRainOn = false
  private readonly nightMode = NIGHT
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
      // mid-afternoon alpine light — high, bright sun (0.2 = deep night)
      timeOfDay: { time: NIGHT ? 0.2 : 0.58 },
      // stars: the panorama's default 100 km sphere clips beyond our
      // 24 km camera.far and silently never renders — 15 km is inside;
      // occlusion is safe (its fragment depth is forced to the far
      // plane). Passing nightSky ALSO activates the bundled moon texture.
      ...(NIGHT && {
        nightSky: { texture: makeStarfieldTexture(), radius: 15000, intensity: 0.8 },
      }),
    })
    console.log('[boot] sky:preset')
    await p.sky.applyPreset(NIGHT ? SKY_PRESETS.moonlitNight : SKY_PRESETS.pixar)
    if (NIGHT) {
      // the preset clobbers star intensity to 0.05 (calibrated for HDR
      // starmaps, not our 8-bit canvas) and ships coverage 0.6 (cloudy
      // night hides the stars) — re-assert both
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sk = p.sky as any
      if (sk.nightSky?.intensity) sk.nightSky.intensity.value = 0.8
      const cov = sk.clouds?.coverage ?? sk.clouds?.shape?.coverage
      if (cov?.value !== undefined) cov.value = 0.35
      // moon disc at HALF brightness (blinding-light autopsy: the disc
      // term bypasses atmosphere exposure entirely — dim the SOURCE;
      // moonIntensity stays 2.5 so clouds/ambient keep their moonlight)
      if (sk.timeOfDay?.moonDiscBrightness?.value !== undefined) {
        sk.timeOfDay.moonDiscBrightness.value = 0.5
      }
    } else {
      p.liftCloudDeck(0)
    }

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
    // SSR at medium's march budget: our strength is 0.3 (speed-fading to
    // 0.18) — 16 steps × 100 m buys nothing visible over 8 × 60 at that
    // strength, and the march runs full-res every frame
    QUALITY_LEVELS.high.ssrStepCount = 8
    QUALITY_LEVELS.high.ssrMaxDistance = 60
    // NOTE: deterministic fixed-substep mode measured 1 fps here (its
    // per-substep sync points serialize the GPU) — stability comes from
    // the dt clamp in update() instead: one sim step per frame, never
    // fed more than 33ms. Uncapped 50-70ms steps at low fps blew past
    // the wake solver's stability limit — the field amplified its own
    // energy into jagged peaks no friction could damp (the "nightmare
    // physics" / hurricane-shake session).
    p.water = await WaterSystem.create(renderer, scene, camera, WATER_QUALITY)
    p.water.loadPreset(getPresetParams('dusk'))
    // SSS to blackFlag's SUNNY values (sunset council): our lighting rig
    // is already blackFlag's daylight, but SSS still ran dusk's narrow
    // lobe (0.6 @ power 2.3) — the wide low-power glow (0.35 @ 0.85) is
    // the backlit-turquoise crest light the demo's sunny water is known
    // for. Night re-asserts its own 0.2 later.
    p.water.sss.intensity = 0.35
    p.water.sss.power = 0.85
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
    // CLOUDS BEHIND MOUNTAINS, once and for all: the cloud composite is
    // a fullscreen triangle whose vertexNode emits clip z = 0 — under
    // three's DEFAULT (non-reversed) WebGPU depth that is the NEAR
    // plane, so a depth test passes everywhere and the overlay paints
    // cloud sheets across the range regardless (measured: the earlier
    // depthTest-only fix changed nothing — reversedDepthBuffer defaults
    // false in r185). Re-emit the triangle at the FAR plane and test:
    // terrain now occludes clouds; open sky (cleared depth 1.0) still
    // passes. ?cloudoverlay restores the vendor overlay.
    if (!flags.has('cloudoverlay')) {
      for (const m of provider.getMeshes()) {
        const mesh = m as THREE.Mesh
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mat = mesh.material as any
        if (mat && mat.depthTest === false && mesh.renderOrder === -5) {
          mat.vertexNode = vec4(
            positionGeometry.x,
            positionGeometry.y,
            0.9999,
            1,
          )
          mat.depthTest = true
          mat.needsUpdate = true
        }
      }
    }

    // night stars: the provider mesh list excludes the panorama — add it
    // ourselves, keep scene fog off the 15 km sphere (the historic
    // fog-on-sky bug on a new mesh), and keep it out of the water's aux
    // passes like every other animated/transparent overlay
    if (NIGHT && p.sky.nightSkyMesh) {
      const nm = p.sky.nightSkyMesh
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(nm.material as any).fog = false
      scene.add(nm)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rpmN = (p.water as any).renderPassManager
      rpmN?.depthPass?.excludeObject?.(nm)
      rpmN?.sceneColorPass?.excludeObject?.(nm)
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
    // white sand carries caustics; moonlight doesn't burn them in
    p.water.floor.caustics.intensity = NIGHT ? 0.4 : 1.15
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

    // ?night: moonlit water slices (vendor moonlit preset values, applied
    // AFTER the daylight rig so they win; the per-frame lighting sync
    // reads these sources). Waves/wake/foam/fresnel/SSR keep OUR tune.
    if (NIGHT) {
      p.water.color.absorptionColor = '#161313'
      p.water.color.transmissionColor = '#ffffff'
      p.water.color.waterColor = '#182325'
      p.water.sss.intensity = 0.2
      p.water.fog.color = '#474343'
      lighting.ambient.skyColor.set('#5a6a85')
      lighting.ambient.groundColor.set('#1b2238')
      lighting.ambient.intensity = 0.9
      lighting.sun.color.set('#cdd8ff') // cool moonlight
      if (lighting.sun.intensity?.value !== undefined) {
        lighting.sun.intensity.value = 0.45 // glint trail, not a flare
      }
    }

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
    // day haze only — the night rig set '#474343' above and this line
    // was silently clobbering it (final-swarm catch)
    if (!NIGHT) p.water.fog.color = '#c4d2d8'
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
    // night re-assert: the teal day-tune above must not win at night
    // (caught live: absorption read the day value under ?night)
    if (NIGHT) {
      p.water.color.absorptionColor = '#161313'
      p.water.color.transmissionColor = '#ffffff'
      p.water.color.waterColor = '#182325'
    }

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

  /** Drop an object from the water's scene-color re-render (refraction/
   *  SSR source). Distant dressing — impostor forests, far ranges —
   *  contributes nothing visible there but pays full vertex cost. */
  excludeFromSceneColor(obj: THREE.Object3D): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpm = (this.water as any).renderPassManager
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) rpm?.sceneColorPass?.excludeObject?.(o)
    })
  }

  /** Register the hull with the buoyancy + wake systems (after boat load). */
  attachBoat(boat: BoatSystem): void {
    this.boatRef = boat
    this.wakeAnchor.position.set(boat.group.position.x, 0, boat.group.position.z)

    // THE THREE BOATS (swarm-verified): image 1 = the real render;
    // image 2 = the boat in the scene-color texture sampled by water
    // REFRACTION (1-3 frames stale under the async latch); image 3 =
    // SSR, whose ray-hit color fetch reads the SAME scene-color texture.
    // One exclusion kills both ghosts. The boat STAYS in the depth pass
    // (separate exclusion set) so fog/foam/waterline occlusion around
    // the hull keep working. Cost: no parked mirror reflection of the
    // boat and no submerged-hull see-through — near-invisible at our
    // absorption, and ghosting requires motion anyway.
    this.excludeFromSceneColor(boat.group)

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
    // WORM-MONSTER TUNE (final swarm, decoded in-bundle): the vendor's
    // injection is depth × RAW SPEED — 2.9× cruise energy at 150 mph
    // into a fixed-friction field = the towering stern ridge. Fix is
    // hyper-band-only so the CRUISE wake is byte-identical: friction
    // 1.05 below 25 m/s rising to 1.65 at top speed (unconditionally
    // stable — damped leapfrog, gamma·dt ≈ 0.028), stern depth sheds
    // half its top-end, stamp widens to flatten the peak (~1/radius,
    // stays >2 field texels).
    const hyper = Math.min(1, Math.max(0, (speedMps - 25) / 42))
    const fricBand = Math.round(hyper * 6)
    if (fricBand !== this.lastFricBand) {
      this.lastFricBand = fricBand
      this.water.wake.friction = 1.05 + (fricBand / 6) * 0.6
    }
    this.water.wake.updateGenerator(this.sternWakeId, {
      depth: (0.62 + k * 0.33) * idle * shallow * (1 - 0.5 * hyper),
      radius: 4.5 + k * 3.0,
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

      // STORM LIGHT RIG (swarm audit): the create()-time blackFlag
      // daylight otherwise persists through Apocalyptic — a 1.3
      // pale-cyan ambient kept the whole lake lit at alpine noon under
      // a thunderstorm ("sky tries but stays bright white", cause #2).
      // Tier-0 values are byte-identical to the create rig. At NIGHT the
      // moonlit rig owns the lights — storms still drive the waves.
      if (!this.nightMode) {
        const stormMix = Math.max(0, Math.min(1, (tierT - 1.5) / 2.5))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lighting = this.water.lighting as any
        if (lighting.sun.intensity?.value !== undefined) {
          lighting.sun.intensity.value = lerpA(
            [2.5, 2.3, 1.7, 1.0, 0.6],
            tierT,
          )
        }
        lighting.ambient.intensity = lerpA([1.3, 1.2, 0.9, 0.55, 0.35], tierT)
        lighting.sun.color
          .set(0xfffef5)
          .lerp(new THREE.Color(0xb8c4d4), stormMix)
        lighting.ambient.skyColor
          .set(0xd2e3f9)
          .lerp(new THREE.Color(0x5f6a76), stormMix)
        lighting.ambient.groundColor
          .set(0xabe0f2)
          .lerp(new THREE.Color(0x4c5a60), stormMix)

        // storm fog: the water post-fog reaches FULL strength at fadeEnd
        // and repainted the far shores bright alpine-haze white through
        // any storm (cause #3) — slate it down and crush the distances
        const FOG_S2 = Math.max(0.55, LAKE_SCALE / 2.2)
        this.water.fog.color = new THREE.Color(0xc4d2d8).lerp(
          new THREE.Color(0x4a4f55),
          stormMix,
        )
        this.water.fog.fadeStart = 1400 * FOG_S2 * (1 - 0.5 * stormMix)
        this.water.fog.fadeEnd = 9000 * FOG_S2 * (1 - 0.5 * stormMix)
      }
    }

    const skyBand = Math.min(4, Math.floor(tierT + skyDark))
    if (!this.nightMode && skyBand !== this.lastSkyBand) {
      this.lastSkyBand = skyBand
      void this.sky
        .applyPreset(SKY_PRESETS[SKY_TIERS[skyBand]])
        .then(() => {
          this.liftCloudDeck(skyBand)
          // WHITE STORM SKY, cause #1 (swarm audit): the vendor storm
          // presets ship full DAYLIGHT source radiance (thunderstorm:
          // sun 6.49 @ 50.5° elevation, atmosphere exposure 1.0) — and
          // renderer-exposure cuts land on the ACES SHOULDER, mapping
          // the dome right back to ~0.9 white. Dim the SOURCE, pre-ACES.
          // peakIntensity, not intensity.value — the SunDriver rewrites
          // intensity.value from peakIntensity every frame.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const s = this.sky as any
          s.atmosphere.exposure.value *= [1, 1, 0.85, 0.55, 0.35][skyBand]
          s.sun.peakIntensity *= [1, 1, 0.92, 0.72, 0.5][skyBand]
          // rebake reflections NEXT frame — not up to 6 s of sunny water
          // under a black sky
          this.envRefresh = 7
        })
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
    // altitude lives on clouds.SHAPE (swarm audit: the old clouds.altitude
    // path was undefined — this lift had NEVER actually run)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape = (this.sky as any).clouds?.shape
    if (shape?.altitude?.value !== undefined) {
      shape.altitude.value = Math.max(shape.altitude.value, 2700)
    }
  }

  /** Per-frame sky tick — MUST run on every PRESENTED frame. The cloud
   *  temporal reprojection accumulates history against the live camera;
   *  when the async-water latch ran the sky at water cadence instead,
   *  extreme camera moves left stale history stamped across the frame
   *  ("seeing triple", §user). main.ts calls this synchronously each
   *  rAF; the water sim below stays behind the latch. */
  updateSky(dt: number): void {
    dt = Math.min(dt, 1 / 30)
    this.sky.update(dt)
    // keep the water's light in step with the sky: the SUN by day, the
    // MOON at night (the SunDriver holds the anti-solar moon direction
    // and gates the sun's intensity to zero below the horizon — pointing
    // the water's speculars at the moon is what makes the glint trail)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const skySun = (this.sky.sun as any)
    if (this.nightMode) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const moonDir = (this.sky as any).timeOfDay?.moonDirection?.value
      if (moonDir) this.water.lighting.sun.direction.value.copy(moonDir)
    } else if (skySun?.direction?.value) {
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
  }

  /** Advance the water simulation. Async (GPU readbacks) — runs behind
   *  the main loop's latch; the sky ticks separately in updateSky(). */
  async update(dt: number): Promise<void> {
    const rawDt = Math.min(dt, 0.1) // wall-clock dt, clamped only vs tab-switch spikes
    // clamp the sim step to 60Hz-sized: 33ms steps STILL let the wake
    // field self-amplify at 18 fps (user's mountain-trail screenshots).
    // Below 60 fps the water runs proportionally slow-motion — stable
    // and calm beats realtime and exploding.
    dt = Math.min(dt, 1 / 60)
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
    // stern'); the speed-banded friction (1.05-1.65) is the stability backstop.
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
