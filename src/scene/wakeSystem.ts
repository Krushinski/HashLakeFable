import * as THREE from 'three/webgpu'
import type { WaveField } from './waveField'
import type { BoatSystem } from './boatSystem'

/**
 * Hyper-real wake, tied to hull physics (§6.3 + user contract).
 *
 * Three components, all fed by the speed AT THE MOMENT each water parcel
 * was disturbed:
 *  - Kelvin V-arms: two crisp divergent lines leaving the bow at the
 *    classic ~19.5°, propagating outward at a rate set by boat speed
 *  - Turbulent stern wash: bright churned band directly aft, widening and
 *    dissolving; width/brightness/persistence all scale with speed
 *  - Displacement swell: a soft dark-water band under the wash that reads
 *    as the hull's pushed volume at planing speeds
 * Idle → glass. Trolling → thin pencil lines. Planing → broad white
 * churn inside a long spreading V.
 */

const MAX_POINTS = 130
const DROP_DISTANCE = 1.3
const LIFE = 9.5
const KELVIN_SIN = 0.3338 // sin(19.5°)

interface WakePoint {
  x: number
  z: number
  dirX: number
  dirZ: number
  age: number
  speed: number // boat speed when this parcel was disturbed
}

export class WakeSystem {
  private readonly mesh: THREE.Mesh
  private readonly geometry: THREE.BufferGeometry
  private readonly points: WakePoint[] = []
  private lastX = 0
  private lastZ = 0

  constructor(
    scene: THREE.Scene,
    private readonly waveField: WaveField,
    private readonly boat: BoatSystem,
  ) {
    this.geometry = new THREE.BufferGeometry()
    // 3 ribbons (wash + port arm + starboard arm), 2 verts per point each
    const maxVerts = MAX_POINTS * 6
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3),
    )
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(maxVerts * 4), 4),
    )
    this.geometry.setIndex(
      new THREE.BufferAttribute(new Uint16Array((MAX_POINTS - 1) * 18), 1),
    )

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(this.geometry, material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 15
    scene.add(this.mesh)
  }

  update(dt: number): void {
    const b = this.boat
    const speed = Math.abs(b.speed)

    for (const p of this.points) p.age += dt
    while (this.points.length && this.points[0].age > LIFE) this.points.shift()

    const dirX = Math.sin(b.heading)
    const dirZ = -Math.cos(b.heading)
    const sternX = b.x - dirX * 2.4
    const sternZ = b.z - dirZ * 2.4
    const moved = Math.hypot(sternX - this.lastX, sternZ - this.lastZ)
    if (speed > 1.6 && moved > DROP_DISTANCE) {
      this.lastX = sternX
      this.lastZ = sternZ
      this.points.push({ x: sternX, z: sternZ, dirX, dirZ, age: 0, speed })
      if (this.points.length > MAX_POINTS) this.points.shift()
    }

    const pos = this.geometry.attributes.position as THREE.BufferAttribute
    const col = this.geometry.attributes.color as THREE.BufferAttribute
    const idx = this.geometry.index as THREE.BufferAttribute
    const n = this.points.length
    const t = this.waveField.time
    const A = MAX_POINTS // vertex-block offsets: wash 0, port A*2, star A*4

    for (let i = 0; i < n; i++) {
      const p = this.points[i]
      const px = -p.dirZ
      const pz = p.dirX
      const y = this.waveField.heightAt(p.x, p.z, t) + 0.1
      const spdN = Math.min(1, p.speed / 24) // 0..1 across the speed range
      const fade = Math.max(0, 1 - p.age / LIFE)

      // ---- turbulent stern wash: churn width grows fast then relaxes ----
      const growth = 1 - Math.exp(-p.age * (0.55 + spdN * 0.5))
      const washW = (0.9 + spdN * 2.6) + growth * (2.2 + p.speed * 0.34)
      // brightness: violent white at planing, gentle at trolling; the
      // youngest water is the whitest (fresh churn), dissolving outward
      const washA =
        Math.pow(fade, 1.35) * (0.1 + spdN * 0.6) * (0.45 + 0.55 * Math.exp(-p.age * 0.8))
      pos.setXYZ(i * 2, p.x - px * washW, y, p.z - pz * washW)
      pos.setXYZ(i * 2 + 1, p.x + px * washW, y + 0.02, p.z + pz * washW)
      // slightly green-white foam over darker displaced water
      col.setXYZW(i * 2, 0.90, 0.96, 0.94, washA)
      col.setXYZW(i * 2 + 1, 0.90, 0.96, 0.94, washA)

      // ---- Kelvin arms: crisp lines propagating at 19.5° wave speed ----
      const armDist = 1.2 + p.age * p.speed * KELVIN_SIN
      const armW = 0.35 + p.age * 0.22 + spdN * 0.25
      const armA = Math.pow(fade, 1.9) * (0.05 + spdN * 0.42)
      const armY = this.waveField.heightAt(p.x - px * armDist, p.z - pz * armDist, t) + 0.09
      pos.setXYZ(A * 2 + i * 2, p.x - px * (armDist + armW), armY, p.z - pz * (armDist + armW))
      pos.setXYZ(A * 2 + i * 2 + 1, p.x - px * (armDist - armW), armY, p.z - pz * (armDist - armW))
      col.setXYZW(A * 2 + i * 2, 0.95, 0.99, 0.97, armA * 0.35)
      col.setXYZW(A * 2 + i * 2 + 1, 0.95, 0.99, 0.97, armA)
      const armY2 = this.waveField.heightAt(p.x + px * armDist, p.z + pz * armDist, t) + 0.09
      pos.setXYZ(A * 4 + i * 2, p.x + px * (armDist - armW), armY2, p.z + pz * (armDist - armW))
      pos.setXYZ(A * 4 + i * 2 + 1, p.x + px * (armDist + armW), armY2, p.z + pz * (armDist + armW))
      col.setXYZW(A * 4 + i * 2, 0.95, 0.99, 0.97, armA)
      col.setXYZW(A * 4 + i * 2 + 1, 0.95, 0.99, 0.97, armA * 0.35)
    }

    let ii = 0
    const strip = (base: number) => {
      for (let i = 0; i < Math.max(0, n - 1); i++) {
        const a = base + i * 2
        idx.setX(ii++, a)
        idx.setX(ii++, a + 1)
        idx.setX(ii++, a + 3)
        idx.setX(ii++, a)
        idx.setX(ii++, a + 3)
        idx.setX(ii++, a + 2)
      }
    }
    strip(0)
    strip(A * 2)
    strip(A * 4)
    this.geometry.setDrawRange(0, ii)
    pos.needsUpdate = true
    col.needsUpdate = true
    idx.needsUpdate = true
    this.mesh.visible = n > 1
  }
}
