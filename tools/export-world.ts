// HashLake world -> Blender export.
// Samples the analytic terrain/lake model and replays every seeded placement
// stream verbatim, so Blender rebuilds the exact world the web app renders.
//
// Run:
//   node_modules/.bin/esbuild tools/export-world.ts --bundle --format=esm \
//     --platform=node --banner:js="globalThis.location={search:''};" \
//     --outfile=assets-src/blender-export/export-world.mjs
//   node assets-src/blender-export/export-world.mjs
//
// Frame: meters, origin at lake center, +X east, -Z north, water surface y=0.
// Blender mapping: bl.x = x, bl.y = -z, bl.z = y.

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  LAKE_SCALE,
  LAKE_TEX_WORLD_SIZE,
  WATER_LEVEL,
  MAX_LAKE_DEPTH,
  ISLAND,
  shoreSdf,
  bedHeight,
} from '../src/scene/lakeMap'
import { terrainHeight } from '../src/scene/terrainSystem'
import { seededRandom } from '../src/core/noise'

const OUT = join(process.cwd(), 'assets-src', 'blender-export')
mkdirSync(OUT, { recursive: true })
const S = LAKE_SCALE

// ---------------------------------------------------------------- heightfield
// Unified ground: lake bed inside the shoreline, land outside.
const N = 1537
const EXTENT = 3840 // full terrain domain (matches runtime 641x641 @ 6m); the
// lake tex only spans LAKE_TEX_WORLD_SIZE=1536 but the hero range sits at
// z=-1410 and impostor spruces reach ~1600m out — we need all of it.
void LAKE_TEX_WORLD_SIZE
const heights = new Float32Array(N * N)
const sdf = new Float32Array(N * N)
let hMin = Infinity
let hMax = -Infinity
for (let j = 0; j < N; j++) {
  const z = (j / (N - 1) - 0.5) * EXTENT
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1) - 0.5) * EXTENT
    const s = shoreSdf(x, z)
    const h = s < 0 ? bedHeight(x, z) : terrainHeight(x, z)
    heights[j * N + i] = h
    sdf[j * N + i] = s
    if (h < hMin) hMin = h
    if (h > hMax) hMax = h
  }
}
writeFileSync(join(OUT, 'heightfield.f32'), Buffer.from(heights.buffer))
writeFileSync(join(OUT, 'shoresdf.f32'), Buffer.from(sdf.buffer))
console.log(`heightfield ${N}x${N} over ${EXTENT}m, h in [${hMin.toFixed(1)}, ${hMax.toFixed(1)}]`)

// ---------------------------------------------------------------- forest
// Verbatim replication of ForestSystem.load() (seed 48151623).
{
  const rand = seededRandom(48151623)
  interface Slot { x: number; z: number; scale: number; rot: number; hero: boolean }
  const slots: Slot[] = []
  const tryPlace = (x: number, z: number, minShore: number, maxShore: number, hero = false): boolean => {
    const s = shoreSdf(x, z)
    if (s < minShore || s > maxShore) return false
    for (const p of slots) {
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2
      if (d2 < (hero ? 36 : 20)) return false
    }
    slots.push({ x, z, scale: 0.85 + rand() * 0.6, rot: rand() * Math.PI * 2, hero })
    return true
  }
  tryPlace(-80 * S, 762 * S, 4, 400 * S, true)
  tryPlace(-350 * S, 645 * S, 4, 400 * S, true)
  tryPlace(560 * S, 630 * S, 4, 400 * S, true)
  tryPlace(640 * S, 480 * S, 4, 400 * S, true)
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
  interface ImpSlot { x: number; z: number; scale: number; rot: number }
  const impSlots: ImpSlot[] = []
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
      if (h > 140) continue
      let ok = true
      for (const p of impSlots) {
        if ((p.x - x) ** 2 + (p.z - z) ** 2 < 16) { ok = false; break }
      }
      if (!ok) continue
      impSlots.push({ x, z, scale: 0.7 + rand() * 0.65, rot: rand() * Math.PI })
    }
  }
  const seat = (s: { x: number; z: number }) => terrainHeight(s.x, s.z)
  const forest = {
    hero: slots.filter((s) => s.hero).map((s) => ({ ...s, y: seat(s) })),
    instanced: slots.filter((s) => !s.hero).map((s) => ({ ...s, y: seat(s) })),
    impostor: impSlots.map((s) => ({ ...s, y: seat(s) })),
  }
  console.log(`forest: ${forest.hero.length} hero + ${forest.instanced.length} instanced + ${forest.impostor.length} impostor`)

  // -------------------------------------------------------------- dressing
  // Verbatim replication of LakeDressing (seed 90210): palms -> hero rocks ->
  // shore rocks. Draw ORDER matters — do not reorder rand() calls.
  const drand = seededRandom(90210)
  const palmSlots: { x: number; z: number }[] = []
  for (let i = 0; i < 120 && palmSlots.length < 9; i++) {
    const ang = drand() * Math.PI * 2
    const rad = ISLAND.landR * (0.04 + drand() * 0.3)
    const x = ISLAND.cx + Math.sin(ang) * rad
    const z = ISLAND.cz + Math.cos(ang) * rad
    if (bedHeight(x, z) < 0.7) continue
    if (palmSlots.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 42)) continue
    palmSlots.push({ x, z })
  }
  const palms = palmSlots.map((s, i) => ({
    x: s.x,
    z: s.z,
    y: bedHeight(s.x, s.z) - 0.3,
    variantIndex: i, // app uses i % palmVariantCount (top-level roots of hl-palm.glb)
    rotY: drand() * Math.PI * 2,
    tiltX: (drand() - 0.5) * 0.12,
    scale: 1.7 + drand() * 0.9,
  }))

  interface RockSlot { x: number; z: number; s: number; rot: number }
  const heroRocks: RockSlot[] = []
  const shoreRocks: RockSlot[] = []
  for (let i = 0; i < 120 && heroRocks.length < 14; i++) {
    const ang = drand() * Math.PI * 2
    const rad = ISLAND.landR * (0.85 + drand() * 0.45)
    const x = ISLAND.cx + Math.sin(ang) * rad
    const z = ISLAND.cz + Math.cos(ang) * rad
    if (heroRocks.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 90)) continue
    heroRocks.push({ x, z, s: 2.6 + drand() * 3.2, rot: drand() * Math.PI * 2 })
  }
  for (let i = 0; i < 1500 && shoreRocks.length < 68; i++) {
    const ang = drand() * Math.PI * 2
    const rad = (480 + drand() * 520) * S
    const x = Math.sin(ang) * rad
    const z = Math.cos(ang) * rad * 0.92 + 40
    const s = shoreSdf(x, z)
    if (s < -16 || s > 24) continue
    if (terrainHeight(x, z) > 14) continue
    if (shoreRocks.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 700)) continue
    shoreRocks.push({ x, z, s: 1.4 + drand() * 2.6, rot: drand() * Math.PI * 2 })
  }
  const rocks = {
    hero: heroRocks.map((r) => ({ x: r.x, z: r.z, y: bedHeight(r.x, r.z) - 0.35 * r.s, scale: r.s, rotY: r.rot })),
    shore: shoreRocks.map((r) => ({ x: r.x, z: r.z, y: terrainHeight(r.x, r.z) - 0.3 * r.s, scale: r.s, rotY: r.rot })),
  }
  console.log(`dressing: ${palms.length} palms, ${rocks.hero.length}+${rocks.shore.length} rocks`)

  // -------------------------------------------------------------- dock
  // Verbatim from LakeDressing.buildDock() (seed 777333): plank/pile jitter.
  const sz = 110 * S
  let sx = -585 * S
  for (let i = 0; i < 400 && shoreSdf(sx, sz) < 0; i++) sx -= 2
  if (shoreSdf(sx, sz) < 0) sx = -760 * S
  const startX = sx + 3
  const LEN = 22
  const deckY = 0.72
  const dockRand = seededRandom(777333)
  const planks: { x: number; y: number; z: number; rotY: number }[] = []
  for (let d = 0; d < LEN; d += 0.7) {
    planks.push({
      x: startX + 2 + d,
      y: deckY + (dockRand() - 0.5) * 0.016,
      z: sz + (dockRand() - 0.5) * 0.03,
      rotY: (dockRand() - 0.5) * 0.02,
    })
  }
  const stringers = [-1, 0.98].map((side) => ({
    x: startX + 2 + LEN / 2 - 0.35, y: deckY - 0.1, z: sz + side, len: LEN + 1.4,
  }))
  const piles: { x: number; y: number; z: number; rotZ: number; rotX: number }[] = []
  for (let d = 0.5; d < LEN + 1; d += 4.2) {
    for (const side of [-1.05, 1.05]) {
      piles.push({
        x: startX + 2 + d, y: deckY - 1.55, z: sz + side,
        rotZ: (dockRand() - 0.5) * 0.04,
        rotX: (dockRand() - 0.5) * 0.04,
      })
    }
  }
  const cleats = [-0.9, 0.9].map((side) => ({
    x: startX + 2 + LEN - 0.6, y: deckY + 0.1, z: sz + side,
  }))
  const dock = {
    startX, z: sz, deckY, len: LEN,
    plankSize: [0.62, 0.07, 2.4], stringerSize: [LEN + 1.4, 0.12, 0.16],
    pile: { rTop: 0.11, rBot: 0.135, h: 3.6 },
    planks, stringers, piles, cleats,
  }
  console.log(`dock: startX=${startX.toFixed(2)} z=${sz} planks=${planks.length} piles=${piles.length}`)

  // -------------------------------------------------------------- buoys/boat
  const buoys = [
    { x: 560 * S, z: 190 * S, name: 'cove' },
    { x: -140 * S, z: -430 * S, name: 'north bay' },
    { x: ISLAND.cx + ISLAND.landR + 26, z: ISLAND.cz + 30, name: 'island mooring' },
  ]
  const boat = {
    x: 40 * S, z: 420 * S, y: 0,
    headingRad: 0, // 0 = facing north (-z)
    glbYawFixRad: Math.PI / 2, // runtime applies rotation.y = PI/2 to the GLB
    hiddenMeshPrefixes: ['Prop', 'Rudder'],
  }

  const meta = {
    frame: 'meters; origin lake center; +X east; -Z north; water y=0. Blender: (x, -z, y)',
    lakeScale: S,
    extent: EXTENT,
    gridN: N,
    waterLevel: WATER_LEVEL,
    maxLakeDepth: MAX_LAKE_DEPTH,
    heightRange: [hMin, hMax],
    island: ISLAND,
    heightfield: 'heightfield.f32 float32 little-endian, row-major, j=z rows i=x cols, [-extent/2..extent/2]',
    shoresdf: 'shoresdf.f32 same layout; negative = inside lake',
  }
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2))
  writeFileSync(
    join(OUT, 'placements.json'),
    JSON.stringify({ forest, palms, rocks, dock, buoys, boat }, null, 2),
  )
  console.log('wrote meta.json + placements.json ->', OUT)
}
