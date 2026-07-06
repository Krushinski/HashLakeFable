import * as THREE from 'three/webgpu'
import { fbm2 } from '../core/noise'

/**
 * The single source of truth for HashLake's geography.
 *
 * Everything that needs to know where water, shore, sandbar, island, cove,
 * or dock live — the water shader, terrain, boat boundaries, land-aware
 * ripples, the minimap — reads from this one analytic model, so land and
 * water can never disagree (the root cause of the old build's gray-triangle
 * shore artifacts was two systems with two opinions).
 *
 * Convention: world units are meters, origin at lake center, +X east,
 * -Z north (toward the hero mountains), water surface at y = 0.
 */

export const WATER_LEVEL = 0

/**
 * World scale. The ghost-in-a-sheet silhouette below is CANON — a nod to
 * Satoshi; the debugger minimap must always show this exact low-poly
 * ghost. Scaling happens HERE and only here: the raw GHOST_* definitions
 * are the canonical proportions, and every export is uniformly scaled,
 * so the world grows without the shape ever changing.
 *
 * 0.75x — THIRD VERDICT (user, driving the deployed 2.2 build): "far
 * too huge... it could be 1/3 of this size and honestly we should try
 * that." 0.75 IS a third of 2.2 — main body ~960 m across, every shore
 * a short cruise, the mountains loom (heights stay absolute), and the
 * terrain mesh tightens to 6 m vertices (smoother island edges free).
 * A 150 mph pass still crosses the basin in ~15 s — a rip, not a slog.
 *
 * ?scale=1.0 / ?scale=1.3 override for A/B laps — every consumer
 * derives from this at module init; the world rebuilds on reload.
 */
const SCALE_PROBE = Number(new URLSearchParams(location.search).get('scale'))
export const LAKE_SCALE =
  SCALE_PROBE >= 0.5 && SCALE_PROBE <= 3 ? SCALE_PROBE : 0.75

/** World-space square covered by the lake data texture, centered on origin. */
export const LAKE_TEX_WORLD_SIZE = Math.ceil(2048 * LAKE_SCALE)

// 11 m (§user, third depth verdict: "no hard cutoffs anywhere"): with
// the shelf stretched to 380·S the whole basin is ONE long gradient —
// turquoise shelf into deep teal with no perceptual cliff. Caustics
// and bed shapes stay readable across most of the lake.
export const MAX_LAKE_DEPTH = 11

interface Blob {
  cx: number
  cz: number
  rx: number
  rz: number
}

/** THE GHOST (canonical proportions — never edit scale here, edit LAKE_SCALE). */
const GHOST_BLOBS: Blob[] = [
  { cx: 0, cz: 40, rx: 640, rz: 460 }, // main body
  { cx: -140, cz: -430, rx: 260, rz: 240 }, // north bay toward the mountain gateway
  { cx: 560, cz: 190, rx: 250, rz: 200 }, // east cove
  { cx: -580, cz: 110, rx: 200, rz: 180 }, // west dock inlet
  { cx: 190, cz: 470, rx: 380, rz: 230 }, // south shallows reach
  // island back-channel: keeps the water behind the island deep enough
  // to thread at full speed (§user)
  { cx: -430, cz: 360, rx: 200, rz: 150 },
]

/** Organic lake body = smooth union of overlapping rounded shapes (scaled). */
const LAKE_BLOBS: Blob[] = GHOST_BLOBS.map((b) => ({
  cx: b.cx * LAKE_SCALE,
  cz: b.cz * LAKE_SCALE,
  rx: b.rx * LAKE_SCALE,
  rz: b.rz * LAKE_SCALE,
}))

/** Landmark features that shape the lake bed. */
// island: cubic-falloff plateau (a peaked gaussian left it a 38 m
// marshmallow) — landR is where the bed crosses the waterline.
// crest heights stay in absolute meters: the world grows sideways,
// not upward.
export const ISLAND = {
  cx: -235 * LAKE_SCALE,
  cz: 305 * LAKE_SCALE,
  r: 155 * LAKE_SCALE,
  // 2.6 not 3.6 (§user, turquoise pass): a lower, rounder dome gives a
  // gentler shore slope — the waterline contour wanders smoothly across
  // the 6 m terrain triangles instead of zigzagging, and the beach ring
  // widens
  crest: 2.6,
  landR: 74 * LAKE_SCALE,
}
// sandbar tightened (§user: the old 160×60 footprint sprawled a huge
// underwater shadow across the south shallows — a bar should read as a
// slim bright ribbon, not a submerged continent)
export const SANDBAR = {
  cx: 230 * LAKE_SCALE,
  cz: 360 * LAKE_SCALE,
  rx: 105 * LAKE_SCALE,
  rz: 42 * LAKE_SCALE,
  rot: -0.35,
  crest: 0.7,
}

function blobSdf(x: number, z: number, b: Blob): number {
  // Approximate ellipse SDF: distance in normalized space rescaled by the
  // smaller radius. Exact enough for organic shapes with noise on top.
  const dx = (x - b.cx) / b.rx
  const dz = (z - b.cz) / b.rz
  const d = Math.hypot(dx, dz) - 1
  return d * Math.min(b.rx, b.rz)
}

function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k))
  return b + (a - b) * h - k * h * (1 - h)
}

/**
 * Signed distance to the lake shoreline in meters.
 * Negative inside the water, positive on land.
 * The island and the exposed sandbar crest are LAND here too — one
 * source of truth for water trim, terrain color, foam, minimap, boat.
 */
export function shoreSdf(x: number, z: number): number {
  let d = Infinity
  for (const b of LAKE_BLOBS) {
    d =
      d === Infinity
        ? blobSdf(x, z, b)
        : smoothMin(d, blobSdf(x, z, b), 110 * LAKE_SCALE)
  }
  // Organic shoreline wobble — large slow undulation + finer nibbling.
  const wobble =
    fbm2(x * 0.0016, z * 0.0016, { octaves: 3, seed: 7 }) * 46 +
    fbm2(x * 0.008, z * 0.008, { octaves: 2, seed: 23 }) * 9
  let s = d + wobble

  // island landmass (own gentle wobble — the lake-scale one would
  // swallow a 74 m shoreline whole)
  const di = Math.hypot(x - ISLAND.cx, z - ISLAND.cz)
  const islandLand =
    ISLAND.landR - di + fbm2(x * 0.01, z * 0.01, { octaves: 2, seed: 71 }) * 8
  s = Math.max(s, islandLand)

  // exposed sandbar crest — a slim ellipse of dry sand
  const c = Math.cos(SANDBAR.rot)
  const sn = Math.sin(SANDBAR.rot)
  const dx = x - SANDBAR.cx
  const dz = z - SANDBAR.cz
  const lx = (dx * c - dz * sn) / SANDBAR.rx
  const lz = (dx * sn + dz * c) / SANDBAR.rz
  const barLand = (0.125 - Math.hypot(lx, lz)) * 70
  s = Math.max(s, barLand)

  return s
}

function gaussianBump(
  x: number,
  z: number,
  cx: number,
  cz: number,
  rx: number,
  rz: number,
  rot = 0,
): number {
  const dx = x - cx
  const dz = z - cz
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const lx = (dx * c - dz * s) / rx
  const lz = (dx * s + dz * c) / rz
  return Math.exp(-(lx * lx + lz * lz) * 2.2)
}

/**
 * Lake bed height (y, meters). Water depth at a point is
 * WATER_LEVEL - bedHeight when positive.
 */
export function bedHeight(x: number, z: number): number {
  const sdf = shoreSdf(x, z)

  // Base basin: bed drops from the shoreline toward max depth mid-lake
  // (shelf width scales with the world so beach grading stays
  // proportional). 380·S: the long shelf is what makes the depth read
  // as one continuous turquoise-to-teal gradient, never a cliff.
  const t = Math.min(1, Math.max(0, -sdf / (380 * LAKE_SCALE)))
  let bed = -MAX_LAKE_DEPTH * Math.pow(t, 1.2)

  // Gentle bed relief so the shallows aren't a perfect ramp.
  bed += fbm2(x * 0.003, z * 0.003, { octaves: 3, seed: 41 }) * 1.6 * t

  // Island: rounded plateau — softer falloff exponent than the old
  // cubic so the rim slope is gentle where it crosses the waterline
  // (smooth sand contour, not triangle zigzag); relief noise still
  // breaks the marshmallow dome but scaled to the lower crest
  const du = Math.hypot(x - ISLAND.cx, z - ISLAND.cz) / ISLAND.r
  const islandG = Math.exp(-Math.pow(du, 2.4) * 1.4)
  bed = Math.max(
    bed,
    -MAX_LAKE_DEPTH + (ISLAND.crest + MAX_LAKE_DEPTH) * islandG,
  )
  if (islandG > 0.5) {
    // dune-and-hollow relief — the dome must never read as a
    // marshmallow (§user, twice)
    bed += (islandG - 0.5) * 2 *
      fbm2(x * 0.02, z * 0.02, { octaves: 3, seed: 91 }) * 2.2
    bed += (islandG - 0.5) * 2 *
      Math.max(0, fbm2(x * 0.045, z * 0.045, { octaves: 2, seed: 17 })) * 1.1
  }

  const bar = gaussianBump(
    x,
    z,
    SANDBAR.cx,
    SANDBAR.cz,
    SANDBAR.rx,
    SANDBAR.rz,
    SANDBAR.rot,
  )
  bed = Math.max(bed, -MAX_LAKE_DEPTH + (SANDBAR.crest + MAX_LAKE_DEPTH) * bar)

  return bed
}

/** Water depth in meters (0 on land / above water). */
export function waterDepth(x: number, z: number): number {
  return Math.max(0, WATER_LEVEL - bedHeight(x, z))
}

export function isInLake(x: number, z: number): boolean {
  return waterDepth(x, z) > 0.02
}

export interface LakeTextures {
  /** RG float texture: R = water depth (m), G = shore SDF (m, signed). */
  data: THREE.DataTexture
  worldSize: number
}

/**
 * Bakes depth + shore-distance into a texture the water shader samples.
 * Generated once at boot; deterministic.
 */
export function buildLakeTextures(size = 1024): LakeTextures {
  const data = new Float32Array(size * size * 2)
  const half = LAKE_TEX_WORLD_SIZE / 2
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1)) * LAKE_TEX_WORLD_SIZE - half
      const z = (j / (size - 1)) * LAKE_TEX_WORLD_SIZE - half
      const idx = (j * size + i) * 2
      data[idx] = waterDepth(x, z)
      data[idx + 1] = shoreSdf(x, z)
    }
  }
  const tex = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGFormat,
    THREE.FloatType,
  )
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return { data: tex, worldSize: LAKE_TEX_WORLD_SIZE }
}
