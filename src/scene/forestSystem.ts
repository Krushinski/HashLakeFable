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
        // 3.46 m ring spacing — crowns overlap at the waterline like
        // grasspass_cam125, not a picket fence
        if (d2 < (hero ? 36 : 12)) return false
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
    // REAL trees to 400 m (correction pass): with the fake-LOD bark
    // dropped (see the far-ring build below) a distant tree costs ~400
    // tris, so the ring affords 4,000 of them — the picket-fence era's
    // entire budget bought 720. Cards begin where geometry stops
    // resolving instead of 150 m from the sand.
    for (let i = 0; i < 30000 && slots.length < 4000; i++) {
      const ang = rand() * Math.PI * 2
      const rad = (500 + rand() * 700) * S
      const cx = Math.sin(ang) * rad
      const cz = Math.cos(ang) * rad * 0.92 + 40
      const n = 2 + Math.floor(rand() * 5)
      for (let j = 0; j < n && slots.length < 4000; j++) {
        const a = rand() * Math.PI * 2
        const r = 3.5 + rand() * 13
        tryPlace(cx + Math.sin(a) * r, cz + Math.cos(a) * r, 10, 400)
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

    // far ring TRUE-LOD (correction pass): hl-spruce-lod1's bark prim is
    // a FAKE LOD — the full 10,652-tri hero trunk — which is what capped
    // the old ring at 720 trees. A distant spruce is 90% canopy: instance
    // ONLY the 386-tri foliage prim over a 10-tri cone trunk. (A proper
    // Blender rebake of the bark stays on the backlog; at 150 m+ this is
    // visually identical and 27× cheaper.)
    const m4 = new THREE.Matrix4()
    const q4 = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const pos = new THREE.Vector3()
    const sc = new THREE.Vector3()
    const foliage = lod1.prims.reduce((a, b) =>
      (a.geometry.index?.count ?? Infinity) <=
      (b.geometry.index?.count ?? Infinity)
        ? a
        : b,
    )
    foliage.geometry.computeBoundingBox()
    const treeTop = foliage.geometry.boundingBox!.max.y
    const trunkH = treeTop * 0.62
    const trunkGeo = new THREE.CylinderGeometry(0.06, 0.24, trunkH, 5)
    trunkGeo.translate(0, trunkH / 2, 0)
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x4a3a2a,
      roughness: 1,
    })
    // foliage-only trees read as bare antenna tiers up close (the "bark"
    // prim carries the whole branch silhouette) — so the ring splits: the
    // ~700 nearest-to-shore trees keep FULL geometry (the entire old
    // ring's budget, front and center), everything beyond gets the lite
    // build where distance hides the sparsity
    const byShore = farSlots
      .map((s) => ({ s, sd: shoreSdf(s.x, s.z) }))
      .sort((a, b) => a.sd - b.sd)
      .map((e) => e.s)
    const FULL_N = Math.min(700, byShore.length)
    const fullSlots = byShore.slice(0, FULL_N)
    const liteSlots = byShore.slice(FULL_N)
    const buildRing = (
      ringSlots: typeof farSlots,
      prims: { geometry: THREE.BufferGeometry; material: THREE.Material }[],
    ) => {
      for (const p of prims) {
        const inst = new THREE.InstancedMesh(
          p.geometry,
          p.material,
          ringSlots.length,
        )
        ringSlots.forEach((s, i) => {
          q4.setFromAxisAngle(up, s.rot)
          sc.setScalar(s.scale)
          pos.set(s.x, terrainHeight(s.x, s.z) - 0.15, s.z)
          m4.compose(pos, q4, sc)
          inst.setMatrixAt(i, m4)
        })
        inst.instanceMatrix.needsUpdate = true
        // matrices span the whole lake — default bounds would cull it
        inst.frustumCulled = false
        this.group.add(inst)
      }
    }
    buildRing(fullSlots, lod1.prims)
    buildRing(liteSlots, [
      { geometry: foliage.geometry, material: foliage.material },
      { geometry: trunkGeo, material: trunkMat },
    ])

    // ---- far-field impostor band: crossed alpha cards climbing the
    // foothills — 4 triangles per tree, so the upslope forest reads as
    // forest instead of green velvet (brief §3.5.3 far ring) ----
    // RENAISSANCE REWRITE (hero_03 is the bar): the reference render's
    // shores carry a CONTINUOUS forest — thousands of slender spires
    // massed at the waterline, thinning upslope, in mixed green/olive/
    // dead-brown tones. Two card populations (slender Cycles hero sheet +
    // the proven full-crown atlas), shore-biased placement on a spatial
    // hash (the old O(n²) scan can't seed 38k), per-instance tint.
    const q = new URLSearchParams(location.search)
    // ?hdimp = all-slender, ?oldimp = all-crown, default mixes like the
    // render; ?forest=N scales density (0.25 ≈ the pre-Renaissance look)
    const mixSlender = q.has('hdimp') ? 1 : q.has('oldimp') ? 0 : 0.55
    const densityProbe = Number(q.get('forest'))
    const density =
      Number.isFinite(densityProbe) && densityProbe > 0
        ? Math.min(3, densityProbe)
        : 1

    const SHEETS = [
      // slender Cycles hero tree (content-bbox UV crop from prep-bakes)
      { url: 'hl-spruce-side-hd.webp', u0: 0.328, u1: 0.664, v0: 0.037, v1: 0.961, w: 6.0 },
      // full-crown atlas — holds mass at distance where thin spires mip away
      { url: 'hl-spruce-impostor.webp', u0: 0, u1: 1, v0: 0, v1: 1, w: 9 },
    ] as const
    const IH = 16.5
    const impMats = SHEETS.map((s) => {
      const tex = new THREE.TextureLoader().load(`${base}assets/textures/${s.url}`)
      tex.colorSpace = THREE.SRGBColorSpace
      return new THREE.MeshStandardMaterial({
        map: tex,
        alphaTest: 0.28,
        side: THREE.DoubleSide,
        roughness: 1,
        metalness: 0,
        // knock the far cards down a step — full-brightness sprites against
        // the meadow read as high-contrast confetti; distant conifers sit
        // darker and cooler than near ones (cheap aerial perspective)
        color: 0xb4bfae,
      })
    })
    const impGeos = SHEETS.map((s) => {
      const IW = s.w
      const g = new THREE.BufferGeometry()
      g.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          [
            -IW / 2, 0, 0, IW / 2, 0, 0, IW / 2, IH, 0, -IW / 2, IH, 0,
            0, 0, -IW / 2, 0, 0, IW / 2, 0, IH, IW / 2, 0, IH, -IW / 2,
          ],
          3,
        ),
      )
      g.setAttribute(
        'uv',
        new THREE.Float32BufferAttribute(
          [s.u0, s.v0, s.u1, s.v0, s.u1, s.v1, s.u0, s.v1,
           s.u0, s.v0, s.u1, s.v0, s.u1, s.v1, s.u0, s.v1],
          2,
        ),
      )
      g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
      g.computeVertexNormals()
      return g
    })

    // canopy card (Renaissance bake): the HD top sheet on a horizontal
    // quad at the crown's widest point — from the orbit/preset cameras the
    // far forest used to read as bare X-crosses; the top card closes each
    // tree from above. ?notop reverts.
    let topGeo: THREE.PlaneGeometry | null = null
    let topMat: THREE.MeshStandardMaterial | null = null
    if (!q.has('notop')) {
      const topTex = new THREE.TextureLoader().load(
        `${base}assets/textures/hl-spruce-top.webp`,
      )
      topTex.colorSpace = THREE.SRGBColorSpace
      topMat = new THREE.MeshStandardMaterial({
        map: topTex,
        alphaTest: 0.28,
        side: THREE.DoubleSide,
        roughness: 1,
        metalness: 0,
        // the HD sheet bakes darker than the side atlas — lift it onto the
        // same aerial-perspective step so oblique views read as one tree
        color: 0xc8d2c0,
      })
      // CORRECTION (user, live): at 5.8 m the horizontal card bisected
      // every tree mid-crown — a hard line across the side cards from any
      // raised view. It now caps the thin apex zone (~75% height, where
      // the side sheets are mostly transparent) and shrinks to match the
      // upper cone; from above it still closes the silhouette.
      const TOP_D = 5.6
      const TOP_H = 12.4
      topGeo = new THREE.PlaneGeometry(TOP_D, TOP_D)
      topGeo.rotateX(-Math.PI / 2)
      topGeo.translate(0, TOP_H, 0)
      // crop UVs to the canopy content bbox (from tools/prep-bakes.mjs)
      const tuv = topGeo.attributes.uv as THREE.BufferAttribute
      for (let i = 0; i < tuv.count; i++) {
        tuv.setXY(
          i,
          0.064 + tuv.getX(i) * (0.911 - 0.064),
          0.082 + tuv.getY(i) * (0.908 - 0.082),
        )
      }
    }

    interface ImpSlot {
      x: number
      z: number
      scale: number
      rot: number
      variant: number
      tone: readonly [number, number, number]
    }
    const impSlots: ImpSlot[] = []
    const TARGET = Math.round(38000 * density)

    // spatial hash for min-spacing — cell ≥ the largest spacing radius so
    // a 3×3 neighborhood always covers it
    const CELL = 6
    const grid = new Map<string, ImpSlot[]>()
    const fits = (x: number, z: number, minD: number) => {
      const cx = Math.floor(x / CELL)
      const cz = Math.floor(z / CELL)
      const d2 = minD * minD
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          const cell = grid.get(`${gx},${gz}`)
          if (!cell) continue
          for (const p of cell) {
            if ((p.x - x) ** 2 + (p.z - z) ** 2 < d2) return false
          }
        }
      }
      return true
    }
    const put = (slot: ImpSlot) => {
      const key = `${Math.floor(slot.x / CELL)},${Math.floor(slot.z / CELL)}`
      const cell = grid.get(key)
      if (cell) cell.push(slot)
      else grid.set(key, [slot])
      impSlots.push(slot)
    }

    // mixed stand tones straight off hero_03: living green, dry olive,
    // standing-dead brown, deep conifer shadow (multiplies the material's
    // aerial-perspective base)
    const TONES = [
      [0.93, 1.0, 0.93],
      [1.08, 1.0, 0.74],
      [1.16, 0.9, 0.66],
      [0.74, 0.82, 0.78],
    ] as const
    const pickTone = () => {
      const t = rand()
      return t < 0.46 ? TONES[0] : t < 0.68 ? TONES[1] : t < 0.8 ? TONES[2] : TONES[3]
    }

    // shore-massed stands: the render's forest is DENSEST at the waterline
    // and thins with distance inland — acceptance probability and spacing
    // both follow the shore band
    for (let i = 0; i < TARGET * 2 && impSlots.length < TARGET; i++) {
      const ang = rand() * Math.PI * 2
      const rad = (520 + rand() * 1620) * S
      const cx = Math.sin(ang) * rad
      const cz = Math.cos(ang) * rad * 0.92 + 40 * S
      const n = 4 + Math.floor(rand() * 6)
      for (let j = 0; j < n && impSlots.length < TARGET; j++) {
        const a = rand() * Math.PI * 2
        const r = 3 + rand() * 9
        const x = cx + Math.sin(a) * r
        const z = cz + Math.cos(a) * r
        const s = shoreSdf(x, z)
        if (s < 26 || s > 1200 * S) continue
        const band = s < 250 ? 0 : s < 600 ? 1 : 2
        // real geometry fills the shore to 400 m; cards still carry the
        // canopy MASS between the lite trees (0.55 read too airy)
        if (band === 0 && rand() > 0.8) continue
        if (band === 1 && rand() > 0.5) continue
        if (band === 2 && rand() > 0.2) continue
        const h = terrainHeight(x, z)
        if (h > 140) continue // hug the lake bowl — high trees read as ants
        const minD = band === 0 ? 3.0 : band === 1 ? 4.2 : 5.5
        if (!fits(x, z, minD)) continue
        put({
          x,
          z,
          scale: (band === 0 ? 0.85 : 0.7) + rand() * 0.6,
          rot: rand() * Math.PI,
          variant: rand() < mixSlender ? 0 : 1,
          tone: pickTone(),
        })
      }
    }

    // two side-card populations + one shared canopy layer
    const col = new THREE.Color()
    const setSlotMatrix = (s: ImpSlot) => {
      q4.setFromAxisAngle(up, s.rot)
      sc.setScalar(s.scale)
      pos.set(s.x, terrainHeight(s.x, s.z) - 0.3, s.z)
      m4.compose(pos, q4, sc)
    }
    const byVariant: ImpSlot[][] = [[], []]
    for (const s of impSlots) byVariant[s.variant].push(s)
    let sideCards = 0
    byVariant.forEach((slots, v) => {
      if (slots.length === 0) return
      const inst = new THREE.InstancedMesh(impGeos[v], impMats[v], slots.length)
      slots.forEach((s, i) => {
        setSlotMatrix(s)
        inst.setMatrixAt(i, m4)
        inst.setColorAt(i, col.setRGB(s.tone[0], s.tone[1], s.tone[2]))
      })
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      inst.frustumCulled = false
      this.group.add(inst)
      sideCards += slots.length
    })
    if (topGeo && topMat) {
      const topInst = new THREE.InstancedMesh(topGeo, topMat, impSlots.length)
      impSlots.forEach((s, i) => {
        setSlotMatrix(s)
        topInst.setMatrixAt(i, m4)
        topInst.setColorAt(i, col.setRGB(s.tone[0], s.tone[1], s.tone[2]))
      })
      topInst.instanceMatrix.needsUpdate = true
      if (topInst.instanceColor) topInst.instanceColor.needsUpdate = true
      topInst.frustumCulled = false
      this.group.add(topInst)
    }
    this.ready = true
    console.info(
      `forest: ${heroSlots.length} hero + ${farSlots.length} instanced + ` +
        `${sideCards} impostor spruces (${byVariant[0].length} slender / ` +
        `${byVariant[1].length} crown, density ×${density}), ` +
        `${lod0.prims.length}+${lod1.prims.length} prims`,
    )
  }

  get isReady(): boolean {
    return this.ready
  }
}
