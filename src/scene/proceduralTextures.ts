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
