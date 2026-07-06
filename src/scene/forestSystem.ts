import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { seededRandom } from '../core/noise'
import { LAKE_SCALE, shoreSdf } from './lakeMap'
import { terrainHeight } from './terrainSystem'

const S = LAKE_SCALE

/**
 * The forest — hero baked-GLB trees near the camera, instanced LOD variants
 * beyond (brief §3.5.3). Assets come from the Blender source-forge pipeline:
 * procedural high-poly spruce → foliage atlas + baked bark → card-canopy
 * LODs → draco GLB.
 *
 * A GLB "tree" arrives as one mesh per glTF primitive (bark, foliage) — the
 * loader keeps ALL of them: heroes clone the whole hierarchy, the far ring
 * gets one InstancedMesh per primitive sharing a matrix set.
 */

interface TreePrims {
  prims: { geometry: THREE.BufferGeometry; material: THREE.Material }[]
}

function fixMaterial(m: THREE.Material): void {
  const std = m as THREE.MeshStandardMaterial
  if (std.transparent || std.alphaTest > 0) {
    std.transparent = false
    // lower cutout threshold fights alpha-test mip erosion at distance
    std.alphaTest = 0.22
    std.side = THREE.DoubleSide
    std.depthWrite = true
  }
  if (typeof std.roughness === 'number') {
    std.roughness = Math.max(std.roughness, 0.75)
  }
}

async function loadTree(loader: GLTFLoader, url: string): Promise<TreePrims> {
  const gltf = await loader.loadAsync(url)
  const prims: TreePrims['prims'] = []
  gltf.scene.updateMatrixWorld(true)
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    mats.forEach(fixMaterial)
    // bake any node transform into the geometry so primitives can be
    // instanced with a single matrix
    const geo = mesh.geometry.clone()
    geo.applyMatrix4(mesh.matrixWorld)
    prims.push({ geometry: geo, material: mats[0] })
  })
  if (prims.length === 0) throw new Error(`no meshes in ${url}`)
  return { prims }
}

export class ForestSystem {
  readonly group = new THREE.Group()
  private ready = false

  constructor(scene: THREE.Scene) {
    scene.add(this.group)
  }

  async load(): Promise<void> {
    const base = import.meta.env.BASE_URL
    const draco = new DRACOLoader()
    draco.setDecoderPath(`${base}assets/draco/`)
    const loader = new GLTFLoader()
    loader.setDRACOLoader(draco)

    // Cache-bust per build (per reload in dev) — stale cached GLBs cost an
    // hour of debugging once; never again.
    const v = import.meta.env.DEV ? Date.now().toString(36) : __BUILD_COMMIT__
    const [lod0, lod1] = await Promise.all([
      loadTree(loader, `${base}assets/models/hl-spruce-lod0.glb?v=${v}`),
      loadTree(loader, `${base}assets/models/hl-spruce-lod1.glb?v=${v}`),
    ])

    // ---- placement: deterministic shoreline-and-upslope scattering ----
    const rand = seededRandom(48151623)
    interface Slot {
      x: number
      z: number
      scale: number
      rot: number
      hero: boolean
    }
    const slots: Slot[] = []
    const tryPlace = (
      x: number,
      z: number,
      minShore: number,
      maxShore: number,
      hero = false,
    ): boolean => {
      const s = shoreSdf(x, z)
      if (s < minShore || s > maxShore) return false
      for (const p of slots) {
        const d2 = (p.x - x) ** 2 + (p.z - z) ** 2
        if (d2 < (hero ? 36 : 20)) return false
      }
      slots.push({
        x,
        z,
        scale: 0.85 + rand() * 0.6,
        rot: rand() * Math.PI * 2,
        hero,
      })
      return true
    }

    // hero specimens around the south shore (default tableau side) —
    // coords ride LAKE_SCALE (post-fork bug: three unscaled seeds fell
    // in open water at 2.2× and the shoreSdf gate silently dropped them)
    tryPlace(-80 * S, 762 * S, 4, 400 * S, true)
    tryPlace(-350 * S, 645 * S, 4, 400 * S, true)
    tryPlace(560 * S, 630 * S, 4, 400 * S, true)
    tryPlace(640 * S, 480 * S, 4, 400 * S, true)

    // clumped ring around the whole lake — forests grow in CLUSTERS, not
    // even speckle ("ants on a hill", §user last-day): each seed drops a
    // stand of 2-6 trees within ~4-16 m, so the shoreline reads as
    // coherent dark masses with gaps instead of uniform dots
    for (let i = 0; i < 3000 && slots.length < 840; i++) {
      const ang = rand() * Math.PI * 2
      const rad = (500 + rand() * 700) * S
      const cx = Math.sin(ang) * rad
      const cz = Math.cos(ang) * rad * 0.92 + 40
      const n = 2 + Math.floor(rand() * 5)
      for (let j = 0; j < n && slots.length < 840; j++) {
        const a = rand() * Math.PI * 2
        const r = 3.5 + rand() * 13
        tryPlace(cx + Math.sin(a) * r, cz + Math.cos(a) * r, 10, 320)
      }
    }

    const heroSlots = slots.filter((s) => s.hero)
    const farSlots = slots.filter((s) => !s.hero)

    // hero trees: real meshes, one per primitive
    for (const s of heroSlots) {
      const holder = new THREE.Group()
      for (const p of lod0.prims) {
        holder.add(new THREE.Mesh(p.geometry, p.material))
      }
      holder.position.set(s.x, terrainHeight(s.x, s.z) - 0.15, s.z)
      holder.rotation.y = s.rot
      holder.scale.setScalar(s.scale)
      this.group.add(holder)
    }

    // far ring: one InstancedMesh PER PRIMITIVE, sharing the matrix set
    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const pos = new THREE.Vector3()
    const sc = new THREE.Vector3()
    for (const p of lod1.prims) {
      const inst = new THREE.InstancedMesh(
        p.geometry,
        p.material,
        farSlots.length,
      )
      farSlots.forEach((s, i) => {
        q.setFromAxisAngle(up, s.rot)
        sc.setScalar(s.scale)
        pos.set(s.x, terrainHeight(s.x, s.z) - 0.15, s.z)
        m4.compose(pos, q, sc)
        inst.setMatrixAt(i, m4)
      })
      inst.instanceMatrix.needsUpdate = true
      // matrices span the whole lake — default geometry bounds would cull it
      inst.frustumCulled = false
      this.group.add(inst)
    }

    // ---- far-field impostor band: crossed alpha cards climbing the
    // foothills — 4 triangles per tree, so the upslope forest reads as
    // forest instead of green velvet (brief §3.5.3 far ring) ----
    const impostorTex = new THREE.TextureLoader().load(
      `${base}assets/textures/hl-spruce-impostor.png`,
    )
    impostorTex.colorSpace = THREE.SRGBColorSpace
    const impMat = new THREE.MeshStandardMaterial({
      map: impostorTex,
      alphaTest: 0.28,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      // knock the far cards down a step — full-brightness sprites against
      // the meadow read as high-contrast confetti; distant conifers sit
      // darker and cooler than near ones (cheap aerial perspective)
      color: 0xb4bfae,
    })
    const IW = 9
    const IH = 16.5
    const impGeo = new THREE.BufferGeometry()
    impGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          -IW / 2, 0, 0, IW / 2, 0, 0, IW / 2, IH, 0, -IW / 2, IH, 0,
          0, 0, -IW / 2, 0, 0, IW / 2, 0, IH, IW / 2, 0, IH, -IW / 2,
        ],
        3,
      ),
    )
    impGeo.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute(
        [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1],
        2,
      ),
    )
    impGeo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
    impGeo.computeVertexNormals()

    interface ImpSlot { x: number; z: number; scale: number; rot: number }
    const impSlots: ImpSlot[] = []
    // clumped like the near ring: stands of 3-8 cards, tighter packing —
    // distant forest reads as a closed dark canopy, not confetti
    for (let i = 0; i < 20000 && impSlots.length < 10000; i++) {
      const ang = rand() * Math.PI * 2
      const rad = (640 + rand() * 1500) * S
      const cx = Math.sin(ang) * rad
      const cz = Math.cos(ang) * rad * 0.92 + 40 * S
      const n = 3 + Math.floor(rand() * 6)
      for (let j = 0; j < n && impSlots.length < 10000; j++) {
        const a = rand() * Math.PI * 2
        const r = 2.5 + rand() * 8.5
        const x = cx + Math.sin(a) * r
        const z = cz + Math.cos(a) * r
        const s = shoreSdf(x, z)
        if (s < 50 || s > 1200 * S) continue
        const h = terrainHeight(x, z)
        if (h > 140) continue // hug the lake bowl — high trees read as ants
        let ok = true
        for (const p of impSlots) {
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < 16) { ok = false; break }
        }
        if (!ok) continue
        impSlots.push({ x, z, scale: 0.7 + rand() * 0.65, rot: rand() * Math.PI })
      }
    }
    const impInst = new THREE.InstancedMesh(impGeo, impMat, impSlots.length)
    impSlots.forEach((s, i) => {
      q.setFromAxisAngle(up, s.rot)
      sc.setScalar(s.scale)
      pos.set(s.x, terrainHeight(s.x, s.z) - 0.3, s.z)
      m4.compose(pos, q, sc)
      impInst.setMatrixAt(i, m4)
    })
    impInst.instanceMatrix.needsUpdate = true
    impInst.frustumCulled = false
    this.group.add(impInst)

    this.ready = true
    console.info(
      `forest: ${heroSlots.length} hero + ${farSlots.length} instanced + ` +
        `${impSlots.length} impostor spruces, ` +
        `${lod0.prims.length}+${lod1.prims.length} prims`,
    )
  }

  get isReady(): boolean {
    return this.ready
  }
}
