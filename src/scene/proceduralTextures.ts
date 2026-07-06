import * as THREE from 'three/webgpu'
import { seededRandom } from '../core/noise'

/**
 * Boot-time procedural textures — deterministic, tileable, zero external
 * assets. Built from sums of integer-frequency sinusoids (inherently
 * seamless when tiled), then post-processed per use.
 */

interface SineOctave {
  fx: number
  fz: number
  amp: number
  phase: number
}

function makeOctaves(
  count: number,
  minCycles: number,
  maxCycles: number,
  seed: number,
): SineOctave[] {
  const rand = seededRandom(seed)
  const octs: SineOctave[] = []
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1)
    const cycles = Math.round(
      minCycles * Math.pow(maxCycles / minCycles, t),
    )
    const angle = rand() * Math.PI * 2
    // Integer frequency vector => perfect tiling over [0,1)².
    const fx = Math.round(Math.cos(angle) * cycles)
    const fz = Math.round(Math.sin(angle) * cycles)
    octs.push({
      fx,
      fz,
      amp: Math.pow(0.72, i) * (0.7 + rand() * 0.6),
      phase: rand() * Math.PI * 2,
    })
  }
  return octs
}

function tileableHeight(u: number, v: number, octs: SineOctave[]): number {
  let h = 0
  let norm = 0
  for (const o of octs) {
    h += Math.sin((u * o.fx + v * o.fz) * Math.PI * 2 + o.phase) * o.amp
    norm += o.amp
  }
  return h / norm // [-1, 1]
}

/** Tileable ripple normal map for high-frequency water surface detail. */
export function makeDetailNormalTexture(size = 256): THREE.DataTexture {
  const octs = makeOctaves(14, 3, 46, 911)
  const heights = new Float32Array(size * size)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      heights[j * size + i] = tileableHeight(i / size, j / size, octs)
    }
  }

  const data = new Uint8Array(size * size * 4)
  const strength = 2.1
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const l = heights[j * size + ((i - 1 + size) % size)]
      const r = heights[j * size + ((i + 1) % size)]
      const d = heights[((j - 1 + size) % size) * size + i]
      const u = heights[((j + 1) % size) * size + i]
      let nx = (l - r) * strength
      let nz = (d - u) * strength
      const ny = 1
      const len = Math.hypot(nx, ny, nz)
      nx /= len
      nz /= len
      const idx = (j * size + i) * 4
      data[idx] = Math.round((nx * 0.5 + 0.5) * 255)
      data[idx + 1] = Math.round((nz * 0.5 + 0.5) * 255)
      data[idx + 2] = Math.round(((ny / len) * 0.5 + 0.5) * 255)
      data[idx + 3] = 255
    }
  }

  const tex = new THREE.DataTexture(data, size, size)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

/**
 * Tileable WHITE-SAND set: neutral speckle albedo (multiplier around 1.0
 * so the palette hues stay authoritative) + a matching tangent-space
 * normal map from the same height field — soft dune ripples with fine
 * grain on top. Deterministic, seamless, zero assets (§user: "real sand
 * albedo and normal textures").
 */
export function makeSandTextures(size = 512): {
  albedo: THREE.DataTexture
  normal: THREE.DataTexture
} {
  const dunes = makeOctaves(7, 2, 11, 313)
  const grains = makeOctaves(10, 23, 96, 727)
  // deterministic per-texel hash for the sub-texel grain speckle
  const hash = (i: number, j: number): number => {
    let h = (i * 374761393 + j * 668265263) ^ 0x5bf03635
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295
  }

  const heights = new Float32Array(size * size)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size
      const v = j / size
      const dune = tileableHeight(u, v, dunes)
      const rip = tileableHeight(u, v, grains)
      const g = hash(i, j) * 2 - 1
      heights[j * size + i] = dune * 0.52 + rip * 0.33 + g * 0.15
    }
  }

  // albedo: luminance multiplier ~0.84..1.06, sparse darker grains
  const alb = new Uint8Array(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const idx = (j * size + i) * 4
      const h01 = heights[j * size + i] * 0.5 + 0.5
      const g = hash(i + 7919, j + 104729)
      let lum = 0.86 + h01 * 0.16 + (g - 0.5) * 0.08
      if (g > 0.975) lum -= 0.22 // scattered dark grains / tiny pebbles
      const b = Math.round(Math.min(255, Math.max(0, lum * 255)))
      alb[idx] = b
      alb[idx + 1] = b
      alb[idx + 2] = Math.min(255, b + 2)
      alb[idx + 3] = 255
    }
  }
  const albedo = new THREE.DataTexture(alb, size, size)
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping
  albedo.magFilter = THREE.LinearFilter
  albedo.minFilter = THREE.LinearMipmapLinearFilter
  albedo.generateMipmaps = true
  albedo.anisotropy = 8
  albedo.needsUpdate = true

  // tangent-space normal from the same heights (standard RGB encoding)
  const nrm = new Uint8Array(size * size * 4)
  const strength = 2.4
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const l = heights[j * size + ((i - 1 + size) % size)]
      const r = heights[j * size + ((i + 1) % size)]
      const d = heights[((j - 1 + size) % size) * size + i]
      const u2 = heights[((j + 1) % size) * size + i]
      let nx = (l - r) * strength
      let ny = (d - u2) * strength
      let nz = 1
      const len = Math.hypot(nx, ny, nz)
      nx /= len
      ny /= len
      nz /= len
      const idx = (j * size + i) * 4
      nrm[idx] = Math.round((nx * 0.5 + 0.5) * 255)
      nrm[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      nrm[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      nrm[idx + 3] = 255
    }
  }
  const normal = new THREE.DataTexture(nrm, size, size)
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping
  normal.magFilter = THREE.LinearFilter
  normal.minFilter = THREE.LinearMipmapLinearFilter
  normal.generateMipmaps = true
  normal.anisotropy = 8
  normal.needsUpdate = true

  return { albedo, normal }
}

/**
 * Tileable foam pattern — ridged, lacy structure in R, softer coverage in G.
 */
export function makeFoamTexture(size = 256): THREE.DataTexture {
  const lacy = makeOctaves(12, 4, 60, 1733)
  const soft = makeOctaves(6, 2, 12, 4111)

  const data = new Uint8Array(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size
      const v = j / size
      // Ridged transform: bright filaments where the field crosses zero.
      const h = tileableHeight(u, v, lacy)
      const ridge = Math.pow(1 - Math.abs(h), 5)
      const cover = tileableHeight(u, v, soft) * 0.5 + 0.5
      const idx = (j * size + i) * 4
      data[idx] = Math.round(Math.min(1, ridge * (0.5 + cover)) * 255)
      data[idx + 1] = Math.round(cover * 255)
      data[idx + 2] = 0
      data[idx + 3] = 255
    }
  }

  const tex = new THREE.DataTexture(data, size, size)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}
