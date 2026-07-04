import * as THREE from 'three/webgpu'
import { color, float, mix, normalWorld, uniform } from 'three/tsl'
import { seededRandom } from '../core/noise'

/**
 * The Apocalyptic fire sky (§14.3 tier 5): a translucent dome graded from
 * ember-orange horizon to black-red zenith that fades in over the Preetham
 * sky, plus drifting embers around the viewer. Preetham can't produce
 * end-times — this layer can.
 */

const EMBER_COUNT = 700

export class FireSkySystem {
  private readonly dome: THREE.Mesh
  private readonly uFire = uniform(0)
  private readonly embers: THREE.Points
  private readonly emberMat: THREE.PointsMaterial
  private readonly emberVel: Float32Array
  private rand = seededRandom(66600)

  constructor(scene: THREE.Scene) {
    // ---- dome ----
    const mat = new THREE.MeshBasicNodeMaterial()
    mat.side = THREE.BackSide
    mat.transparent = true
    mat.depthWrite = false
    mat.fog = false
    const up = normalWorld.y.clamp(0, 1)
    mat.colorNode = mix(
      color(0x812908), // molten horizon
      color(0x12020a), // black-red zenith
      up.pow(0.55),
    ).add(color(0xff5a1a).mul(float(1).sub(up).pow(6).mul(0.5)))
    mat.opacityNode = this.uFire
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(5400, 32, 18), mat)
    this.dome.visible = false
    scene.add(this.dome)

    // ---- embers ----
    const pos = new Float32Array(EMBER_COUNT * 3)
    this.emberVel = new Float32Array(EMBER_COUNT * 3)
    for (let i = 0; i < EMBER_COUNT; i++) {
      this.resetEmber(pos, i, true)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.emberMat = new THREE.PointsMaterial({
      color: 0xff7a28,
      size: 0.55,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.embers = new THREE.Points(geo, this.emberMat)
    this.embers.frustumCulled = false
    this.embers.visible = false
    this.embers.renderOrder = 28
    scene.add(this.embers)
  }

  private resetEmber(pos: Float32Array, i: number, scatterY = false): void {
    pos[i * 3] = (this.rand() * 2 - 1) * 160
    pos[i * 3 + 1] = scatterY ? this.rand() * 60 : -2 + this.rand() * 4
    pos[i * 3 + 2] = (this.rand() * 2 - 1) * 160
    this.emberVel[i * 3] = (this.rand() * 2 - 1) * 1.6
    this.emberVel[i * 3 + 1] = 2.5 + this.rand() * 4.5
    this.emberVel[i * 3 + 2] = (this.rand() * 2 - 1) * 1.6
  }

  update(dt: number, fire: number, focus: THREE.Vector3): void {
    const active = fire > 0.02
    this.dome.visible = active
    this.embers.visible = active
    if (!active) return

    this.uFire.value = fire * 0.88
    this.emberMat.opacity = fire * 0.9

    const pos = this.embers.geometry.attributes
      .position as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    for (let i = 0; i < EMBER_COUNT; i++) {
      arr[i * 3] += this.emberVel[i * 3] * dt
      arr[i * 3 + 1] += this.emberVel[i * 3 + 1] * dt
      arr[i * 3 + 2] += this.emberVel[i * 3 + 2] * dt
      if (arr[i * 3 + 1] > 65) this.resetEmber(arr as Float32Array, i)
    }
    pos.needsUpdate = true
    this.embers.position.set(focus.x, 0, focus.z)
  }
}
