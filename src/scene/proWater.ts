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
 *  Order invariant: cascade 0 (waves) must stay larger than 1 (ripples). */
const CASCADES = {
  waves: { scale: 420, amplitudeScale: 0.2 },
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
    // it back to a thin alpine haze
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fog = p.water.fog as any
    fog.color = '#c4d2d8'
    if ('startDistance' in fog) fog.startDistance = 900
    if ('start' in fog) fog.start = 900
    if ('endDistance' in fog) fog.endDistance = 5200
    if ('end' in fog) fog.end = 5200
    fog.skyBlendDistance = 2600

    // ---- lake tuning pass 1 (verify live on pages.dev) ----
    // Wake field: dusk ships ocean physics — trail damping γ 0.25 and
    // foamBreakThreshold 0, i.e. foam at ANY surface steepness. Fast
    // laps inject energy faster than the field damps, so the basin
    // whips into permanent white peaks ("nightmare physics"). A lake
    // is stiffer and only foams on genuinely breaking crests.
    p.water.wake.friction = 1.4
    p.water.wake.foamStrength = 0.4
    p.water.wake.foamBreakThreshold = 0.35

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

    // ROOT-CAUSE A/B: the wake displacement field is the prime suspect
    // for every remaining horror — the churn zone that travels with the
    // boat (field is camera-centered), the world-aligned straight seams
    // ("brown banner" = field rim), the rest-glitch (buoyancy reads the
    // field under the hull), and the refusal to EVER calm down (a field
    // that ignores friction has gone NaN — NaN × damping = NaN forever;
    // possibly the wake compute misbehaving on r185 vs the r183 the lib
    // was built for). OFF by default until proven innocent; append
    // ?wake to the URL to re-enable for comparison.
    p.water.wake.enabled = new URLSearchParams(location.search).has('wake')

    // Alpine water, not brown murk: dusk's absorption (~0.1/m) is so
    // clear our sand-colored lakebed shows through everywhere — water
    // and wet beach read as the same brown, hiding the shoreline.
    // Stronger red-first extinction sinks the bed into teal by ~2-3 m
    // depth, so the waterline becomes a legible color edge.
    p.water.color.absorptionColor = '#6b3a22'
    p.water.color.transmissionColor = '#2e7b6e'
    p.water.color.waterColor = '#123f4a'

    // calm lake baseline
    console.log('[boot] water:baseline')
    p.applyWeatherRaw(0, 0)

    scene.add(p.boatProxy)
    return p
  }

  /** Register the hull with the buoyancy + wake systems (after boat load). */
  attachBoat(boat: BoatSystem): void {
    this.water.buoyancy.addObject(this.boatProxy, {
      multiPoint: true,
      useBoundingBox: false,
      sampleLength: 5.4,
      sampleWidth: 1.7,
      heightSmoothing: 0.12,
      rotationSmoothing: 0.16,
      rotationInfluence: 0.75,
    })
    // Injection depths QUARTERED from the ocean-ish first guesses: at
    // lake scale even 0.4m of continuously-injected displacement reads
    // as a churned mountain trail once the field integrates it.
    this.bowWakeId = this.water.wake.addGenerator(boat.group, {
      depth: 0.12,
      radius: 1.3,
      offset: new THREE.Vector3(0, 0, 2.3),
    })
    this.sternWakeId = this.water.wake.addGenerator(boat.group, {
      depth: 0.18,
      radius: 1.6,
      offset: new THREE.Vector3(0, 0, -2.5),
    })
    this.water.wake.foamPersistence = 0.94
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
      depth: (0.18 + k * 0.22) * idle,
      radius: 1.6 + k * 0.8,
    })
    this.water.wake.updateGenerator(this.bowWakeId, {
      depth: (0.12 + k * 0.12) * idle,
      radius: 1.3 + k * 0.5,
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
        windDirection: 130,
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
    // refresh the reflection PMREM from the re-baked sky at a low cadence
    this.envRefresh += dt
    if (this.wpSky && this.envRefresh > 1.5) {
      this.envRefresh = 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(this.wpSky as any).uploadSource(this.renderer)
    }
    await this.water.update(dt)
  }
}
