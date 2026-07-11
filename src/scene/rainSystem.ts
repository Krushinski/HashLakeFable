import * as THREE from 'three/webgpu'
import {
  Fn,
  If,
  deltaTime,
  float,
  hash,
  instanceIndex,
  instancedArray,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'

/**
 * Rain — GPU compute particles (§2.1 compute contract; pattern from the
 * first-party webgpu_compute_particles_rain example). Drops live in a
 * local box that follows the viewer; a compute pass integrates fall +
 * wind shear and recycles drops through the top. On the WebGL 2 backend
 * three runs the same kernel through transform feedback.
 */

const MAX_DROPS = 14000
const HALF = 120 // half-extent of the rain box (m)
const TOP = 55

export class RainSystem {
  private readonly mesh: THREE.Mesh
  private readonly positions = instancedArray(MAX_DROPS, 'vec3')
  private readonly computeInit: THREE.ComputeNode
  private readonly computeUpdate: THREE.ComputeNode
  /** XZ wind shear vector (heading × strength) — the weather engine's
   *  unified wind, not the old +X-only scalar. */
  private readonly uWind = uniform(new THREE.Vector2())
  private readonly uWindMag = uniform(0)
  private readonly uOpacity = uniform(0)
  private inited = false

  constructor(
    scene: THREE.Scene,
    private readonly renderer: THREE.WebGPURenderer,
  ) {
    this.computeInit = Fn(() => {
      const p = this.positions.element(instanceIndex)
      const i = instanceIndex.toFloat()
      p.assign(
        vec3(
          hash(i.add(1)).mul(HALF * 2).sub(HALF),
          hash(i.add(2)).mul(TOP),
          hash(i.add(3)).mul(HALF * 2).sub(HALF),
        ),
      )
    })().compute(MAX_DROPS) as unknown as THREE.ComputeNode

    this.computeUpdate = Fn(() => {
      const p = this.positions.element(instanceIndex)
      const i = instanceIndex.toFloat()
      const fall = float(34).add(hash(i.add(7)).mul(16))
      p.y.subAssign(deltaTime.mul(fall))
      p.x.addAssign(deltaTime.mul(this.uWind.x).mul(26))
      p.z.addAssign(deltaTime.mul(this.uWind.y).mul(26))

      // recycle through the top, rewrapping horizontally
      If(p.y.lessThan(0), () => {
        p.y.addAssign(TOP)
        p.x.assign(hash(i.add(p.y)).mul(HALF * 2).sub(HALF))
        p.z.assign(hash(i.add(p.y).add(9)).mul(HALF * 2).sub(HALF))
      })
      If(p.x.greaterThan(HALF), () => p.x.subAssign(HALF * 2))
      If(p.x.lessThan(-HALF), () => p.x.addAssign(HALF * 2))
      If(p.z.greaterThan(HALF), () => p.z.subAssign(HALF * 2))
      If(p.z.lessThan(-HALF), () => p.z.addAssign(HALF * 2))
    })().compute(MAX_DROPS) as unknown as THREE.ComputeNode

    const material = new THREE.SpriteNodeMaterial()
    material.transparent = true
    material.depthWrite = false
    material.positionNode = this.positions.toAttribute()
    // thin streak, tilted by wind shear magnitude (screen-space sprite
    // rotation can't track a world heading; the lean sells the speed)
    material.scaleNode = vec2(0.024, 0.5)
    material.rotationNode = this.uWindMag.mul(-0.35)
    material.colorNode = vec4(0.72, 0.79, 0.88, 1)
    material.opacityNode = this.uOpacity
    material.fog = false

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
    ;(this.mesh as unknown as { count: number }).count = MAX_DROPS
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.mesh.renderOrder = 30
    scene.add(this.mesh)
  }

  update(
    dt: number,
    focus: THREE.Vector3,
    rain: number,
    windX: number,
    windZ: number,
  ): void {
    const active = rain > 0.03
    this.mesh.visible = active
    if (!active) return
    if (!this.inited) {
      this.inited = true
      try {
        this.renderer.compute(this.computeInit)
      } catch (err) {
        console.warn('rain compute unavailable:', err)
        this.mesh.visible = false
        return
      }
    }
    ;(this.mesh as unknown as { count: number }).count = Math.max(
      64,
      Math.floor(MAX_DROPS * Math.min(1, rain)),
    )
    this.uWind.value.set(windX, windZ)
    this.uWindMag.value = Math.hypot(windX, windZ)
    this.uOpacity.value = 0.16 + 0.22 * Math.min(1, rain)
    this.mesh.position.set(focus.x, 0, focus.z)
    try {
      this.renderer.compute(this.computeUpdate)
    } catch {
      this.mesh.visible = false
    }
    void dt
  }
}
