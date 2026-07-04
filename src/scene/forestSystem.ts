import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { seededRandom } from '../core/noise'
import { shoreSdf } from './lakeMap'
import { terrainHeight } from './terrainSystem'

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
        if (d2 < (hero ? 36 : 52)) return false
      }
      slots.push({
        x,
        z,
        scale: 0.75 + rand() * 0.55,
        rot: rand() * Math.PI * 2,
        hero,
      })
      return true
    }

    // hero specimens around the south shore (default tableau side)
    tryPlace(-80, 762, 4, 400, true)
    tryPlace(-350, 645, 4, 400, true)
    tryPlace(560, 630, 4, 400, true)
    tryPlace(640, 480, 4, 400, true)

    // scattered ring around the whole lake
    for (let i = 0; i < 2600 && slots.length < 240; i++) {
      const ang = rand() * Math.PI * 2
      const rad = 500 + rand() * 700
      tryPlace(Math.sin(ang) * rad, Math.cos(ang) * rad * 0.92 + 40, 10, 320)
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

    this.ready = true
    console.info(
      `forest: ${heroSlots.length} hero + ${farSlots.length} instanced spruces, ` +
        `${lod0.prims.length}+${lod1.prims.length} prims`,
    )
  }

  get isReady(): boolean {
    return this.ready
  }
}
