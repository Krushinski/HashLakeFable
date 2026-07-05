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

/** Storm-tier anchors for the FFT spectrum (lake-scaled, not open ocean). */
const WATER_TIERS = {
  windSpeed: [4.5, 7, 11, 16, 22],
  amplitude: [0.32, 0.5, 0.75, 1.0, 1.2],
  choppiness: [1.0, 1.15, 1.35, 1.55, 1.7],
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

    p.sky = await SkySystem.create({
      renderer,
      camera,
      quality: 'high',
      // mid-afternoon alpine light — high, bright sun
      timeOfDay: { time: 0.58 },
    })
    await p.sky.applyPreset(SKY_PRESETS.partlyCloudy)

    p.water = await WaterSystem.create(renderer, scene, camera, 'high')
    p.water.loadPreset(getPresetParams('dusk'))

    // ---- sky → water reflection bridge ----
    // Sky Pro 1.0's provider adapter speaks Water Pro 2.x; v3.1's setSky
    // wants its own texture-backed Sky. Bridge: asSkyProvider({envMap})
    // spins up Sky Pro's equirect baker (ticked inside sky.update), and
    // we feed its texture — volumetric clouds included — to a Water Pro
    // Sky. PMREM refresh happens on a cadence in update().
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

    // calm lake baseline
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
    this.bowWakeId = this.water.wake.addGenerator(boat.group, {
      depth: 0.5,
      radius: 1.6,
      offset: new THREE.Vector3(0, 0, 2.3),
    })
    this.sternWakeId = this.water.wake.addGenerator(boat.group, {
      depth: 0.7,
      radius: 1.9,
      offset: new THREE.Vector3(0, 0, -2.5),
    })
    this.water.wake.foamPersistence = 0.988
  }

  /** Scale the wake with throttle — planing hulls dig harder. */
  setBoatSpeed(speedMps: number): void {
    if (this.sternWakeId < 0) return
    const k = Math.min(1, speedMps / 30)
    this.water.wake.updateGenerator(this.sternWakeId, {
      depth: 0.55 + k * 1.5,
      radius: 1.9 + k * 2.1,
    })
    this.water.wake.updateGenerator(this.bowWakeId, {
      depth: 0.4 + k * 0.7,
      radius: 1.5 + k * 1.0,
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
    }

    const skyBand = Math.min(4, Math.floor(tierT + skyDark))
    if (skyBand !== this.lastSkyBand) {
      this.lastSkyBand = skyBand
      void this.sky.applyPreset(SKY_PRESETS[SKY_TIERS[skyBand]])
    }
  }

  /** Advance both simulations. Water update is async (GPU readbacks). */
  async update(dt: number): Promise<void> {
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
