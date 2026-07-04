/**
 * Deterministic, seeded 2D value noise + FBM.
 * Used anywhere the CPU needs reproducible organic variation (lake shore
 * wobble, terrain, placement scattering). Deterministic output is a brief
 * contract (§3.5.3): identical scenes on every load, every machine.
 */

function hash2(ix: number, iz: number, seed: number): number {
  // Integer hash → [0, 1). Stable across JS engines (all int32 ops).
  let h = (ix * 374761393 + iz * 668265263 + seed * 1442695040888963407) | 0
  h = (h ^ (h >> 13)) | 0
  h = Math.imul(h, 1274126177)
  h = (h ^ (h >> 16)) | 0
  return (h >>> 0) / 4294967296
}

function smoothstep01(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Single octave of 2D value noise in [-1, 1]. */
export function valueNoise2(x: number, z: number, seed = 1): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz

  const a = hash2(ix, iz, seed)
  const b = hash2(ix + 1, iz, seed)
  const c = hash2(ix, iz + 1, seed)
  const d = hash2(ix + 1, iz + 1, seed)

  const ux = smoothstep01(fx)
  const uz = smoothstep01(fz)

  const ab = a + (b - a) * ux
  const cd = c + (d - c) * ux
  return (ab + (cd - ab) * uz) * 2 - 1
}

export interface FbmOptions {
  octaves?: number
  lacunarity?: number
  gain?: number
  seed?: number
}

/** Fractal Brownian motion over value noise, output roughly in [-1, 1]. */
export function fbm2(x: number, z: number, opts: FbmOptions = {}): number {
  const { octaves = 4, lacunarity = 2.0, gain = 0.5, seed = 1 } = opts
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, z * freq, seed + i * 101) * amp
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}

/** Deterministic pseudo-random stream for placement scattering. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}
