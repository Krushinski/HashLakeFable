import * as THREE from 'three/webgpu'
import { uniform } from 'three/tsl'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'

/**
 * Sky, sun, and image-based lighting.
 *
 * A Preetham SkyMesh drives both the visible dome and (via a PMREM bake of a
 * sky-only scene) `scene.environment`. The bake happens only when the sky
 * meaningfully changes (weather tier / sun move), never per frame.
 *
 * Phase 1 pins a warm golden-hour sun — the hero-light of 000_INSPIRATION —
 * so the water can be judged in its target lighting. The Eastern-Time
 * day/night engine and the five storm tiers take over these dials in later
 * phases.
 */

export class SkySystem {
  readonly sky: SkyMesh
  readonly sunLight: THREE.DirectionalLight
  readonly hemi: THREE.HemisphereLight

  /** TSL-facing uniforms other systems (water) shade against. */
  readonly uSunDirection = uniform(new THREE.Vector3(0, 1, 0))
  readonly uSunColor = uniform(new THREE.Color(0xfff1d6))

  private readonly pmrem: THREE.PMREMGenerator
  private readonly envScene = new THREE.Scene()
  private envTarget: THREE.RenderTarget | null = null
  private readonly sunDir = new THREE.Vector3()

  constructor(
    renderer: THREE.WebGPURenderer,
    private readonly scene: THREE.Scene,
  ) {
    this.sky = new SkyMesh()
    this.sky.scale.setScalar(9000) // safely inside the camera far plane
    // The dome sits beyond the fog's far distance — without this flag the
    // entire sky renders as flat fog color.
    ;(this.sky.material as { fog?: boolean }).fog = false
    scene.add(this.sky)

    // Live-tuned against the Serene reference: crisp late-afternoon blue.
    this.sky.turbidity.value = 8
    this.sky.rayleigh.value = 1.8
    this.sky.mieCoefficient.value = 0.004
    this.sky.mieDirectionalG.value = 0.8

    // SkyMesh's built-in procedural clouds alias badly at our sun angles —
    // keep them off; HashLake's clouds are a dedicated system (Phase 3/6).
    const skyAny = this.sky as unknown as Record<
      string,
      { value: number } | undefined
    >
    if (skyAny.cloudCoverage) skyAny.cloudCoverage.value = 0

    this.setSun(25, 205)

    this.sunLight = new THREE.DirectionalLight(0xffe6c0, 2.6)
    this.sunLight.position.copy(this.sunDir).multiplyScalar(1000)
    scene.add(this.sunLight)

    this.hemi = new THREE.HemisphereLight(0xbdd9e4, 0x3d4a35, 0.55)
    scene.add(this.hemi)

    this.pmrem = new THREE.PMREMGenerator(renderer)
  }

  /**
   * elevation/azimuth in degrees. Azimuth is COMPASS convention in HashLake
   * world space: 0 = north (-Z, toward the hero mountains), 90 = east (+X).
   */
  setSun(elevation: number, azimuth: number): void {
    const el = THREE.MathUtils.degToRad(elevation)
    const az = THREE.MathUtils.degToRad(azimuth)
    this.sunDir.set(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      -Math.cos(az) * Math.cos(el),
    )
    this.sky.sunPosition.value.copy(this.sunDir)
    this.uSunDirection.value.copy(this.sunDir)
    if (this.sunLight) {
      this.sunLight.position.copy(this.sunDir).multiplyScalar(1000)
    }
  }

  get sunDirection(): THREE.Vector3 {
    return this.sunDir
  }

  /**
   * Re-bake the environment map from the current sky. Call at boot and on
   * weather/sun changes — a few ms, so never per frame.
   */
  bakeEnvironment(): void {
    if (this.envTarget) this.envTarget.dispose()
    const showDisc = this.sky.showSunDisc?.value
    if (this.sky.showSunDisc) this.sky.showSunDisc.value = false
    this.envScene.add(this.sky)
    this.envTarget = this.pmrem.fromScene(this.envScene)
    this.scene.add(this.sky) // reclaim from the throwaway scene
    if (this.sky.showSunDisc && showDisc !== undefined) {
      this.sky.showSunDisc.value = showDisc
    }
    this.scene.environment = this.envTarget.texture
    this.scene.environmentIntensity = 0.9
  }
}
