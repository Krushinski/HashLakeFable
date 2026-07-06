import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { seededRandom } from '../core/noise'
import { ISLAND, LAKE_SCALE, bedHeight, shoreSdf } from './lakeMap'
import { terrainHeight } from './terrainSystem'
import type { WaveField } from './waveField'

const S = LAKE_SCALE

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
    // photoscan meshes arrive with holes and flipped faces — render both
    // sides, fully opaque, or they read grainy/see-through
    mat.side = THREE.DoubleSide
    mat.transparent = false
    mat.depthWrite = true
    if (mat.alphaTest > 0) mat.alphaTest = 0.32
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

    // ---- palms: a GIANT clustered grove at the island's heart ----
    const palmSlots: { x: number; z: number }[] = []
    for (let i = 0; i < 120 && palmSlots.length < 9; i++) {
      const ang = rand() * Math.PI * 2
      const rad = ISLAND.landR * (0.04 + rand() * 0.3)
      const x = ISLAND.cx + Math.sin(ang) * rad
      const z = ISLAND.cz + Math.cos(ang) * rad
      if (bedHeight(x, z) < 0.7) continue
      if (palmSlots.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 42)) continue
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
      holder.position.set(s.x, bedHeight(s.x, s.z) - 0.3, s.z)
      holder.rotation.y = rand() * Math.PI * 2
      holder.rotation.x = (rand() - 0.5) * 0.12
      // landmark scale — the grove should read from across the lake
      holder.scale.setScalar(1.7 + rand() * 0.9)
      this.group.add(holder)
    })

    // ---- boulders: rocky ring HALF IN THE WATER (the reference island
    // look — rocks guarding the beach with foam working around them) ----
    interface RockSlot { x: number; z: number; s: number; rot: number }
    const heroRocks: RockSlot[] = []
    const shoreRocks: RockSlot[] = []
    for (let i = 0; i < 120 && heroRocks.length < 14; i++) {
      const ang = rand() * Math.PI * 2
      const rad = ISLAND.landR * (0.85 + rand() * 0.45)
      const x = ISLAND.cx + Math.sin(ang) * rad
      const z = ISLAND.cz + Math.cos(ang) * rad
      if (heroRocks.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 90)) continue
      // bigger: these are the island's guardian stones
      heroRocks.push({ x, z, s: 2.6 + rand() * 3.2, rot: rand() * Math.PI * 2 })
    }
    for (let i = 0; i < 1500 && shoreRocks.length < 68; i++) {
      const ang = rand() * Math.PI * 2
      const rad = (480 + rand() * 520) * S
      const x = Math.sin(ang) * rad
      const z = Math.cos(ang) * rad * 0.92 + 40
      const s = shoreSdf(x, z)
      // half on the beach, half standing IN the shallows (§inspiration:
      // rocks in the water with foam working around their feet)
      if (s < -16 || s > 24) continue
      if (terrainHeight(x, z) > 14) continue
      if (shoreRocks.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 700)) continue
      shoreRocks.push({ x, z, s: 1.4 + rand() * 2.6, rot: rand() * Math.PI * 2 })
    }
    // both pools use the CLEAN scan (variant 0 decimated badly — grainy
    // and see-through on the island; the light variant reads solid)
    const hero = rockVariants[1] ?? rockVariants[0]
    for (const r of heroRocks) {
      for (const p of hero) {
        const m = new THREE.Mesh(p.geometry, p.material)
        // seat on the actual bed — outside the shoreline that means the
        // rock breaks the surface with water working around it
        m.position.set(r.x, bedHeight(r.x, r.z) - 0.35 * r.s, r.z)
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
        pos.set(r.x, terrainHeight(r.x, r.z) - 0.3 * r.s, r.z)
        m4.compose(pos, q, sc)
        inst.setMatrixAt(i, m4)
      })
      inst.instanceMatrix.needsUpdate = true
      inst.frustumCulled = false
      this.group.add(inst)
    }

    // ---- bush mounds: soft dark-green shrubs pocketing the shoreline ----
    const bushGeo = new THREE.IcosahedronGeometry(1, 2)
    {
      const bp = bushGeo.attributes.position as THREE.BufferAttribute
      const brand = seededRandom(4242)
      for (let i = 0; i < bp.count; i++) {
        const k = 0.72 + brand() * 0.5
        bp.setXYZ(i, bp.getX(i) * k, bp.getY(i) * k * 0.52, bp.getZ(i) * k)
      }
      bushGeo.computeVertexNormals()
    }
    const bushMat = new THREE.MeshStandardMaterial({
      color: 0x2c4d24,
      roughness: 0.95,
    })
    const bushSlots: { x: number; z: number; s: number }[] = []
    for (let i = 0; i < 3200 && bushSlots.length < 250; i++) {
      const ang = rand() * Math.PI * 2
      const rad = (470 + rand() * 560) * S
      const x = Math.sin(ang) * rad
      const z = Math.cos(ang) * rad * 0.92 + 40
      const s = shoreSdf(x, z)
      if (s < 3 || s > 46) continue
      if (terrainHeight(x, z) > 12) continue
      if (bushSlots.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 34)) continue
      bushSlots.push({ x, z, s: 0.9 + rand() * 1.7 })
    }
    const bushInst = new THREE.InstancedMesh(bushGeo, bushMat, bushSlots.length)
    bushSlots.forEach((b2, i) => {
      q.setFromAxisAngle(up, (i * 2.39996) % 6.283)
      sc.setScalar(b2.s)
      pos.set(b2.x, terrainHeight(b2.x, b2.z) + 0.15 * b2.s, b2.z)
      m4.compose(pos, q, sc)
      bushInst.setMatrixAt(i, m4)
    })
    bushInst.instanceMatrix.needsUpdate = true
    bushInst.frustumCulled = false
    this.group.add(bushInst)
    console.info(
      `dressing: ${palmSlots.length} palms, ${heroRocks.length}+${shoreRocks.length} rocks`,
    )
  }

  /**
   * Timber dock at the west inlet — anchored ON the shoreline (found by
   * marching the SDF to its zero crossing), weathered wood-grain planks
   * with jitter, framed stringers, piles down to the bed, corner cleats.
   */
  private buildDock(): void {
    const sz = 110
    // walk from open water toward land; stop at the water's edge, then
    // pull back so the first plank starts ON the beach. The inlet plus
    // shoreline wobble can run past -800 — march until we truly exit.
    let sx = -585
    for (let i = 0; i < 200 && shoreSdf(sx, sz) < 0; i++) sx -= 2
    if (shoreSdf(sx, sz) < 0) sx = -760 // safety anchor
    const startX = sx + 3 // slightly inland of the waterline
    const LEN = 22
    const deckY = 0.72
    const rand = seededRandom(777333)

    const base = import.meta.env.BASE_URL
    const woodTex = new THREE.TextureLoader().load(
      `${base}assets/textures/hl-wood.png`,
    )
    woodTex.colorSpace = THREE.SRGBColorSpace
    woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping
    const wood = new THREE.MeshStandardMaterial({
      map: woodTex,
      color: 0xa08a70, // weathers the grain toward silver-gray
      roughness: 0.88,
    })
    const woodDark = new THREE.MeshStandardMaterial({
      map: woodTex,
      color: 0x5c4a38,
      roughness: 0.92,
    })
    const dock = new THREE.Group()

    // planks laid ACROSS the walkway, tiny jitter so it reads hand-built
    const plankGeo = new THREE.BoxGeometry(0.62, 0.07, 2.4)
    for (let d = 0; d < LEN; d += 0.7) {
      const plank = new THREE.Mesh(plankGeo, wood)
      plank.position.set(
        startX + 2 + d,
        deckY + (rand() - 0.5) * 0.016,
        sz + (rand() - 0.5) * 0.03,
      )
      plank.rotation.y = (rand() - 0.5) * 0.02
      dock.add(plank)
    }
    // stringers under the planks
    const strGeo = new THREE.BoxGeometry(LEN + 1.4, 0.12, 0.16)
    for (const side of [-1, 0.98]) {
      const str = new THREE.Mesh(strGeo, woodDark)
      str.position.set(startX + 2 + LEN / 2 - 0.35, deckY - 0.1, sz + side)
      dock.add(str)
    }
    // piles down into the bed, with a little rake
    const pileGeo = new THREE.CylinderGeometry(0.11, 0.135, 3.6, 9)
    for (let d = 0.5; d < LEN + 1; d += 4.2) {
      for (const side of [-1.05, 1.05]) {
        const pile = new THREE.Mesh(pileGeo, woodDark)
        pile.position.set(startX + 2 + d, deckY - 1.55, sz + side)
        pile.rotation.z = (rand() - 0.5) * 0.04
        pile.rotation.x = (rand() - 0.5) * 0.04
        dock.add(pile)
      }
    }
    // end cleats — somewhere to tie the runabout
    const cleatGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.34, 8)
    for (const side of [-0.9, 0.9]) {
      const cleat = new THREE.Mesh(
        cleatGeo,
        new THREE.MeshStandardMaterial({
          color: 0x8d9296,
          metalness: 0.9,
          roughness: 0.35,
        }),
      )
      cleat.rotation.z = Math.PI / 2
      cleat.position.set(startX + 2 + LEN - 0.6, deckY + 0.1, sz + side)
      dock.add(cleat)
    }
    this.group.add(dock)
  }

  /** Mooring buoys at the named destinations — they ride the real waves. */
  private buildBuoys(): void {
    const spots = [
      { x: 560 * S, z: 190 * S }, // cove
      { x: -140 * S, z: -430 * S }, // north bay
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
