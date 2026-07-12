import * as THREE from 'three/webgpu'
import { shoreSdf } from './lakeMap'
import { terrainHeight } from './terrainSystem'

/**
 * Near-camera grass — the web twin of the Blender 81k-instance biome
 * (grasspass_cam125_test is the look). Crossed alpha cards on a
 * camera-following toroidal grid: every world-space 2.2 m cell inside the
 * focus disc hashes to a deterministic tuft (jitter/rotation/scale), so
 * the field is STABLE as the focus moves — tufts never pop or crawl, they
 * only appear at the disc's leading edge and drop off the trailing edge.
 *
 * Refocus work is budgeted across frames (matrix + two terrain samples
 * per tuft — a full 24k re-seed would hitch the loop at driving speed).
 * ?nograss disables, ?grass=N scales density.
 */

const CELL = 2.2
const RADIUS = 130
const REFOCUS_DIST = 14
const PER_FRAME_BUDGET = 3500

/** Deterministic 0..1 hash per world cell (and salt). */
function cellHash(i: number, j: number, salt: number): number {
  let h = (i * 374761393 + j * 668265263 + salt * 1274126177) | 0
  h = (h ^ (h >> 13)) | 0
  h = Math.imul(h, 1274126177)
  h = (h ^ (h >> 16)) >>> 0
  return h / 4294967296
}

function makeGrassTexture(): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  // tapered blades fanning from the root line — olive family, a few dry
  // and a few deep so a tuft never reads as one flat green
  const palette = ['#6e7040', '#7d7c46', '#5c6636', '#8a8450', '#4f5a30']
  for (let b = 0; b < 26; b++) {
    const rootX = 18 + Math.random() * (size - 36)
    const tipX = rootX + (Math.random() - 0.5) * 70
    const tipY = 30 + Math.random() * 80
    const w = 2.5 + Math.random() * 4
    ctx.fillStyle = palette[Math.floor(Math.random() * palette.length)]
    ctx.beginPath()
    ctx.moveTo(rootX - w, size)
    ctx.quadraticCurveTo(rootX - w * 0.4, (size + tipY) / 2, tipX, tipY)
    ctx.quadraticCurveTo(rootX + w * 0.4, (size + tipY) / 2, rootX + w, size)
    ctx.closePath()
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export class GrassSystem {
  readonly mesh: THREE.InstancedMesh | null = null
  private readonly count: number = 0
  private readonly focus = new THREE.Vector3(Infinity, 0, Infinity)
  private cursor = 0
  private dirty = 0 // instances left to re-seed after a refocus

  private readonly m4 = new THREE.Matrix4()
  private readonly q4 = new THREE.Quaternion()
  private readonly up = new THREE.Vector3(0, 1, 0)
  private readonly pos = new THREE.Vector3()
  private readonly sc = new THREE.Vector3()

  constructor(scene: THREE.Scene) {
    const q = new URLSearchParams(location.search)
    if (q.has('nograss')) return
    const densityProbe = Number(q.get('grass'))
    const density =
      Number.isFinite(densityProbe) && densityProbe > 0
        ? Math.min(3, densityProbe)
        : 1
    this.count = Math.round(24000 * density)

    // crossed pair, root at y=0 — matrices carry position/rotation/scale
    const W = 0.62
    const H = 0.46
    const geo = new THREE.BufferGeometry()
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          -W / 2, 0, 0, W / 2, 0, 0, W / 2, H, 0, -W / 2, H, 0,
          0, 0, -W / 2, 0, 0, W / 2, 0, H, W / 2, 0, H, -W / 2,
        ],
        3,
      ),
    )
    geo.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute(
        [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1],
        2,
      ),
    )
    geo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
    geo.computeVertexNormals()

    const mat = new THREE.MeshStandardMaterial({
      map: makeGrassTexture(),
      alphaTest: 0.32,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
    })
    const mesh = new THREE.InstancedMesh(geo, mat, this.count)
    // instances re-seed around the moving focus — bounds can never keep up
    mesh.frustumCulled = false
    scene.add(mesh)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(this as any).mesh = mesh
  }

  /**
   * Track the view focus (boat when driving, camera target otherwise).
   * Instances re-seed lazily within the per-frame budget.
   */
  update(focusX: number, focusZ: number): void {
    if (!this.mesh) return
    const dx = focusX - this.focus.x
    const dz = focusZ - this.focus.z
    if (dx * dx + dz * dz > REFOCUS_DIST * REFOCUS_DIST) {
      this.focus.set(focusX, 0, focusZ)
      this.dirty = this.count
    }
    if (this.dirty <= 0) return

    const n = Math.min(PER_FRAME_BUDGET, this.dirty)
    // instance i owns grid slot i inside the focus disc: lay slots out on
    // a square that covers the disc, wrapped toroidally around the focus
    const side = Math.ceil((RADIUS * 2) / CELL)
    const originI = Math.floor((this.focus.x - RADIUS) / CELL)
    const originJ = Math.floor((this.focus.z - RADIUS) / CELL)
    for (let k = 0; k < n; k++) {
      const idx = this.cursor
      this.cursor = (this.cursor + 1) % this.count
      this.dirty--
      // map instance to a cell; skip cells beyond the tuft budget by
      // hashing presence so density stays even as side² > count
      const ci = originI + (idx % side)
      const cj = originJ + Math.floor(idx / side)
      const hPresent = cellHash(ci, cj, 1)
      const x = (ci + 0.2 + cellHash(ci, cj, 2) * 0.6) * CELL
      const z = (cj + 0.2 + cellHash(ci, cj, 3) * 0.6) * CELL
      const fdx = x - this.focus.x
      const fdz = z - this.focus.z
      const s = shoreSdf(x, z)
      const h = terrainHeight(x, z)
      // grass zone: past the wet band, below the timber slopes, inside
      // the disc; fade density toward the rim so the edge never draws a
      // circle on the meadow
      const r2 = (fdx * fdx + fdz * fdz) / (RADIUS * RADIUS)
      const ok =
        r2 < 1 &&
        s > 3.5 &&
        s < 900 &&
        h < 58 &&
        hPresent > 0.25 + 0.6 * r2
      if (!ok) {
        this.sc.setScalar(0)
        this.m4.makeScale(0, 0, 0)
        this.mesh.setMatrixAt(idx, this.m4)
        continue
      }
      this.q4.setFromAxisAngle(this.up, cellHash(ci, cj, 4) * Math.PI)
      this.sc.setScalar(0.65 + cellHash(ci, cj, 5) * 0.75)
      this.pos.set(x, h - 0.02, z)
      this.m4.compose(this.pos, this.q4, this.sc)
      this.mesh.setMatrixAt(idx, this.m4)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }
}
