import * as THREE from 'three/webgpu'
import type { WaveField } from './waveField'
import type { BoatSystem } from './boatSystem'

/**
 * Stern wake — a foam ribbon the hull drags across the lake. A ring
 * buffer of stern positions becomes a widening, fading triangle strip
 * that rides the real wave field. Cheap (one dynamic mesh), massive for
 * drive feel.
 */

const MAX_POINTS = 110
const DROP_DISTANCE = 1.4 // meters travelled between samples

interface WakePoint {
  x: number
  z: number
  dirX: number
  dirZ: number
  age: number
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
    const maxVerts = MAX_POINTS * 2
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3),
    )
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(maxVerts * 4), 4),
    )
    this.geometry.setIndex(
      new THREE.BufferAttribute(new Uint16Array((MAX_POINTS - 1) * 6), 1),
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

    // age everything; retire the tail
    for (const p of this.points) p.age += dt
    while (this.points.length && this.points[0].age > 7.5) {
      this.points.shift()
    }

    // drop a new sample when the stern has moved far enough
    const dirX = Math.sin(b.heading)
    const dirZ = -Math.cos(b.heading)
    const sternX = b.x - dirX * 2.3
    const sternZ = b.z - dirZ * 2.3
    const moved = Math.hypot(sternX - this.lastX, sternZ - this.lastZ)
    if (speed > 2.2 && moved > DROP_DISTANCE) {
      this.lastX = sternX
      this.lastZ = sternZ
      this.points.push({ x: sternX, z: sternZ, dirX, dirZ, age: 0 })
      if (this.points.length > MAX_POINTS) this.points.shift()
    }

    // rebuild the ribbon
    const pos = this.geometry.attributes.position as THREE.BufferAttribute
    const col = this.geometry.attributes.color as THREE.BufferAttribute
    const idx = this.geometry.index as THREE.BufferAttribute
    const n = this.points.length
    const t = this.waveField.time

    for (let i = 0; i < n; i++) {
      const p = this.points[i]
      // ribbon widens and fades with age
      const width = 1.3 + p.age * 2.1
      const alpha = Math.max(0, 0.42 * (1 - p.age / 7.5)) *
        Math.min(1, speed * 0.08 + 0.35)
      const px = -p.dirZ
      const pz = p.dirX
      const y = this.waveField.heightAt(p.x, p.z, t) + 0.12
      pos.setXYZ(i * 2, p.x - px * width, y, p.z - pz * width)
      pos.setXYZ(i * 2 + 1, p.x + px * width, y, p.z + pz * width)
      col.setXYZW(i * 2, 0.92, 0.97, 0.96, alpha)
      col.setXYZW(i * 2 + 1, 0.92, 0.97, 0.96, alpha)
    }
    let ii = 0
    for (let i = 0; i < Math.max(0, n - 1); i++) {
      const a = i * 2
      idx.setX(ii++, a)
      idx.setX(ii++, a + 1)
      idx.setX(ii++, a + 3)
      idx.setX(ii++, a)
      idx.setX(ii++, a + 3)
      idx.setX(ii++, a + 2)
    }
    this.geometry.setDrawRange(0, ii)
    pos.needsUpdate = true
    col.needsUpdate = true
    idx.needsUpdate = true
    this.mesh.visible = n > 1
  }
}
