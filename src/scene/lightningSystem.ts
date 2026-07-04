import * as THREE from 'three/webgpu'
import { seededRandom } from '../core/noise'

/**
 * Lightning — real bolt geometry, not a screen flash.
 *
 * Bolts are recursive midpoint-displaced polylines with branches, built as
 * camera-agnostic triangle ribbons and flashed with a double-strike
 * envelope. Lights are pre-added at intensity 0 and only modulated —
 * adding/removing lights at runtime breaks WebGPU pipelines.
 */

const BOLT_SEGMENTS = 9

interface Strike {
  t: number // elapsed since strike start
  duration: number
  x: number
  z: number
}

function buildBoltGeometry(
  rand: () => number,
  x: number,
  z: number,
  topY: number,
): THREE.BufferGeometry {
  const points: THREE.Vector3[][] = []

  const trunk: THREE.Vector3[] = []
  let px = x
  let pz = z
  for (let i = 0; i <= BOLT_SEGMENTS; i++) {
    const s = i / BOLT_SEGMENTS
    const y = topY * (1 - s)
    if (i > 0 && i < BOLT_SEGMENTS) {
      px += (rand() * 2 - 1) * 42 * (1 - s * 0.4)
      pz += (rand() * 2 - 1) * 42 * (1 - s * 0.4)
    }
    trunk.push(new THREE.Vector3(px, y, pz))
  }
  points.push(trunk)

  // 1-2 branches forking off mid-bolt
  const branches = 1 + Math.floor(rand() * 2)
  for (let b = 0; b < branches; b++) {
    const start = 2 + Math.floor(rand() * (BOLT_SEGMENTS - 4))
    const branch: THREE.Vector3[] = [trunk[start].clone()]
    let bx = trunk[start].x
    let bz = trunk[start].z
    let by = trunk[start].y
    const steps = 3 + Math.floor(rand() * 3)
    for (let i = 0; i < steps; i++) {
      bx += (rand() * 2 - 1) * 55
      bz += (rand() * 2 - 1) * 55
      by *= 0.55 + rand() * 0.2
      branch.push(new THREE.Vector3(bx, by, bz))
    }
    points.push(branch)
  }

  // ribbons: two triangles per segment, widening toward the sky
  const verts: number[] = []
  for (const line of points) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]
      const b = line[i + 1]
      const w = 1.1 + (a.y / topY) * 2.4
      verts.push(
        a.x - w, a.y, a.z, b.x - w, b.y, b.z, b.x + w, b.y, b.z,
        a.x - w, a.y, a.z, b.x + w, b.y, b.z, a.x + w, a.y, a.z,
      )
      // crossed ribbon so it reads from every angle
      verts.push(
        a.x, a.y, a.z - w, b.x, b.y, b.z - w, b.x, b.y, b.z + w,
        a.x, a.y, a.z - w, b.x, b.y, b.z + w, a.x, a.y, a.z + w,
      )
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  return geo
}

export class LightningSystem {
  private readonly flashLight: THREE.DirectionalLight
  private readonly boltLight: THREE.PointLight
  private readonly boltMesh: THREE.Mesh
  private readonly boltMaterial: THREE.MeshBasicMaterial
  private strike: Strike | null = null
  private nextIn = 6
  private rand = seededRandom(60660)
  /** Hook for thunder audio etc. — called with 0..1 apparent intensity. */
  onStrike: ((intensity: number) => void) | null = null

  constructor(scene: THREE.Scene) {
    this.flashLight = new THREE.DirectionalLight(0xb8c8ff, 0)
    this.flashLight.position.set(0, 900, -600)
    scene.add(this.flashLight)

    this.boltLight = new THREE.PointLight(0xcfdcff, 0, 2600, 1.2)
    scene.add(this.boltLight)

    this.boltMaterial = new THREE.MeshBasicMaterial({
      color: 0xe8eeff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
    this.boltMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.boltMaterial)
    this.boltMesh.visible = false
    this.boltMesh.frustumCulled = false
    this.boltMesh.renderOrder = 25
    scene.add(this.boltMesh)
  }

  /** Double-strike envelope: hit → dim → re-hit → decay. */
  private envelope(t: number, dur: number): number {
    const s = t / dur
    if (s < 0.08) return s / 0.08
    if (s < 0.3) return 1 - ((s - 0.08) / 0.22) * 0.85
    if (s < 0.38) return 0.15 + ((s - 0.3) / 0.08) * 0.85
    return Math.max(0, 1 - (s - 0.38) / 0.62)
  }

  update(dt: number, intensity: number, focusX: number, focusZ: number): void {
    if (this.strike) {
      this.strike.t += dt
      const e = this.envelope(this.strike.t, this.strike.duration)
      this.flashLight.intensity = e * 4.2
      this.boltLight.intensity = e * 900
      this.boltMaterial.opacity = Math.min(1, e * 1.4)
      this.boltMesh.visible = e > 0.02
      if (this.strike.t >= this.strike.duration) {
        this.strike = null
        this.boltMesh.visible = false
        this.flashLight.intensity = 0
        this.boltLight.intensity = 0
      }
      return
    }

    if (intensity <= 0.02) return
    this.nextIn -= dt * intensity
    if (this.nextIn > 0) return

    // fire a strike at a dramatic distance from the viewer
    this.nextIn = 3.5 + this.rand() * 9
    const ang = this.rand() * Math.PI * 2
    const dist = 500 + this.rand() * 1100
    const x = focusX + Math.sin(ang) * dist
    const z = focusZ + Math.cos(ang) * dist
    const topY = 550 + this.rand() * 260

    this.boltMesh.geometry.dispose()
    this.boltMesh.geometry = buildBoltGeometry(this.rand, x, z, topY)
    this.boltLight.position.set(x, topY * 0.4, z)
    this.flashLight.position.set(x, 900, z)
    this.strike = {
      t: 0,
      duration: 0.38 + this.rand() * 0.22,
      x,
      z,
    }
    // closer strike = louder thunder
    this.onStrike?.(Math.max(0.25, 1 - dist / 1800))
  }
}
