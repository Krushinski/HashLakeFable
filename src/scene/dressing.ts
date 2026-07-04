import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { seededRandom } from '../core/noise'
import { ISLAND, bedHeight, shoreSdf } from './lakeMap'
import { terrainHeight } from './terrainSystem'
import type { WaveField } from './waveField'

/**
 * Lake dressing — the destination spots made physical (§10.2 + user):
 * palms and boulders on the island, weathered granite along the shores,
 * a timber dock at the west inlet, mooring buoys riding the waves at the
 * named spots. Everything deterministic, everything cheap.
 */

interface Prim {
  geometry: THREE.BufferGeometry
  material: THREE.Material
}

async function loadPrims(
  loader: GLTFLoader,
  url: string,
): Promise<Map<string, Prim[]>> {
  const gltf = await loader.loadAsync(url)
  const roots = new Map<string, Prim[]>()
  gltf.scene.updateMatrixWorld(true)
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    // find the top-level root this mesh belongs to
    let root: THREE.Object3D = mesh
    while (root.parent && root.parent !== gltf.scene) root = root.parent
    const geo = mesh.geometry.clone()
    geo.applyMatrix4(mesh.matrixWorld)
    const mat = (
      Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    ) as THREE.MeshStandardMaterial
    mat.roughness = Math.max(mat.roughness ?? 1, 0.7)
    if (mat.transparent || mat.alphaTest > 0) {
      mat.transparent = false
      mat.alphaTest = 0.32
      mat.side = THREE.DoubleSide
    }
    if (!roots.has(root.name)) roots.set(root.name, [])
    roots.get(root.name)!.push({ geometry: geo, material: mat })
  })
  return roots
}

interface Buoy {
  mesh: THREE.Group
  x: number
  z: number
  phase: number
}

export class LakeDressing {
  readonly group = new THREE.Group()
  private buoys: Buoy[] = []

  constructor(
    scene: THREE.Scene,
    private readonly waveField: WaveField,
  ) {
    scene.add(this.group)
    this.buildDock()
    this.buildBuoys()
  }

  async load(): Promise<void> {
    const base = import.meta.env.BASE_URL
    const draco = new DRACOLoader()
    draco.setDecoderPath(`${base}assets/draco/`)
    const loader = new GLTFLoader()
    loader.setDRACOLoader(draco)
    const v = import.meta.env.DEV ? Date.now().toString(36) : __BUILD_COMMIT__

    const [palms, rocks] = await Promise.all([
      loadPrims(loader, `${base}assets/models/hl-palm.glb?v=${v}`),
      loadPrims(loader, `${base}assets/models/hl-rocks.glb?v=${v}`),
    ])
    const palmVariants = [...palms.values()]
    const rockVariants = [...rocks.values()]
    const rand = seededRandom(90210)

    // ---- palms crown the island plateau ----
    const palmSlots: { x: number; z: number }[] = []
    for (let i = 0; i < 90 && palmSlots.length < 8; i++) {
      const ang = rand() * Math.PI * 2
      const rad = ISLAND.landR * (0.15 + rand() * 0.62)
      const x = ISLAND.cx + Math.sin(ang) * rad
      const z = ISLAND.cz + Math.cos(ang) * rad
      if (bedHeight(x, z) < 0.8) continue
      if (palmSlots.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 80)) continue
      palmSlots.push({ x, z })
    }
    palmSlots.forEach((s, i) => {
      const variant = palmVariants[i % palmVariants.length]
      const holder = new THREE.Group()
      for (const p of variant) {
        const m = new THREE.Mesh(p.geometry, p.material)
        m.castShadow = true
        holder.add(m)
      }
      holder.position.set(s.x, bedHeight(s.x, s.z) - 0.25, s.z)
      holder.rotation.y = rand() * Math.PI * 2
      holder.rotation.x = (rand() - 0.5) * 0.09
      holder.scale.setScalar(0.8 + rand() * 0.5)
      this.group.add(holder)
    })

    // ---- boulders: island beach ring + scattered shorelines ----
    interface RockSlot { x: number; z: number; s: number; rot: number }
    const heroRocks: RockSlot[] = []
    const shoreRocks: RockSlot[] = []
    for (let i = 0; i < 40 && heroRocks.length < 5; i++) {
      const ang = rand() * Math.PI * 2
      const rad = ISLAND.landR * (0.7 + rand() * 0.4)
      const x = ISLAND.cx + Math.sin(ang) * rad
      const z = ISLAND.cz + Math.cos(ang) * rad
      if (heroRocks.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 120)) continue
      heroRocks.push({ x, z, s: 1.6 + rand() * 1.8, rot: rand() * Math.PI * 2 })
    }
    for (let i = 0; i < 600 && shoreRocks.length < 30; i++) {
      const ang = rand() * Math.PI * 2
      const rad = 480 + rand() * 520
      const x = Math.sin(ang) * rad
      const z = Math.cos(ang) * rad * 0.92 + 40
      const s = shoreSdf(x, z)
      if (s < 0.5 || s > 24) continue
      if (terrainHeight(x, z) > 14) continue
      if (shoreRocks.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 900)) continue
      shoreRocks.push({ x, z, s: 1.4 + rand() * 2.6, rot: rand() * Math.PI * 2 })
    }
    // hero rocks (detailed variant), shore rocks (light variant, instanced)
    const hero = rockVariants[0]
    for (const r of heroRocks) {
      for (const p of hero) {
        const m = new THREE.Mesh(p.geometry, p.material)
        m.position.set(r.x, Math.max(bedHeight(r.x, r.z), 0) - 0.3, r.z)
        m.rotation.y = r.rot
        m.scale.setScalar(r.s)
        this.group.add(m)
      }
    }
    const light = rockVariants[1] ?? rockVariants[0]
    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const pos = new THREE.Vector3()
    const sc = new THREE.Vector3()
    for (const p of light) {
      const inst = new THREE.InstancedMesh(p.geometry, p.material, shoreRocks.length)
      shoreRocks.forEach((r, i) => {
        q.setFromAxisAngle(up, r.rot)
        sc.setScalar(r.s)
        pos.set(r.x, terrainHeight(r.x, r.z) - 0.35, r.z)
        m4.compose(pos, q, sc)
        inst.setMatrixAt(i, m4)
      })
      inst.instanceMatrix.needsUpdate = true
      inst.frustumCulled = false
      this.group.add(inst)
    }
    console.info(
      `dressing: ${palmSlots.length} palms, ${heroRocks.length}+${shoreRocks.length} rocks`,
    )
  }

  /** Timber dock at the west inlet — planks on piles, reaching open water. */
  private buildDock(): void {
    // march west from the inlet center to find the shoreline
    let sx = -585
    const sz = 110
    for (let i = 0; i < 40 && shoreSdf(sx, sz) < 0; i++) sx -= 4
    const LEN = 20
    const deckY = 0.62

    const wood = new THREE.MeshStandardMaterial({
      color: 0x6e5137,
      roughness: 0.85,
    })
    const woodDark = new THREE.MeshStandardMaterial({
      color: 0x4c3826,
      roughness: 0.9,
    })
    // deck: individual planks read as a dock even from the air
    const dock = new THREE.Group()
    const plankGeo = new THREE.BoxGeometry(0.9, 0.08, 2.3)
    for (let d = 0; d < LEN; d += 1.0) {
      const plank = new THREE.Mesh(plankGeo, wood)
      plank.position.set(sx + 2 + d, deckY, sz + (d % 2) * 0.01)
      dock.add(plank)
    }
    // piles
    const pileGeo = new THREE.CylinderGeometry(0.12, 0.13, 3.2, 8)
    for (let d = 1; d < LEN; d += 4.5) {
      for (const side of [-1, 1]) {
        const pile = new THREE.Mesh(pileGeo, woodDark)
        pile.position.set(sx + 2 + d, deckY - 1.4, sz + side * 1.0)
        dock.add(pile)
      }
    }
    this.group.add(dock)
  }

  /** Mooring buoys at the named destinations — they ride the real waves. */
  private buildBuoys(): void {
    const spots = [
      { x: 560, z: 190 }, // cove
      { x: -140, z: -430 }, // north bay
      { x: ISLAND.cx + ISLAND.landR + 26, z: ISLAND.cz + 30 }, // island mooring
    ]
    const red = new THREE.MeshStandardMaterial({
      color: 0x9e1c22,
      roughness: 0.5,
    })
    const white = new THREE.MeshStandardMaterial({
      color: 0xe8e4da,
      roughness: 0.55,
    })
    for (const s of spots) {
      const g = new THREE.Group()
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 18, 14),
        red,
      )
      body.scale.y = 1.15
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.36, 0.3, 16),
        white,
      )
      band.position.y = 0.42
      const tip = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8),
        white,
      )
      tip.position.y = 0.75
      g.add(body, band, tip)
      g.position.set(s.x, 0, s.z)
      this.group.add(g)
      this.buoys.push({ mesh: g, x: s.x, z: s.z, phase: Math.random() * 6 })
    }
  }

  update(): void {
    const t = this.waveField.time
    for (const b of this.buoys) {
      const y = this.waveField.heightAt(b.x, b.z, t)
      b.mesh.position.y = y + 0.05
      b.mesh.rotation.x = Math.sin(t * 0.9 + b.phase) * 0.09
      b.mesh.rotation.z = Math.cos(t * 0.7 + b.phase) * 0.09
    }
  }
}
