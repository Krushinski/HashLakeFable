import * as THREE from 'three/webgpu'
import { cos, exp, float, sin, uniform, uniformArray, vec3 } from 'three/tsl'
import { seededRandom } from '../core/noise'
import { waterDepth } from './lakeMap'

/**
 * The analytic wave field — one spectrum, two evaluators.
 *
 * A bank of Gerstner (trochoidal) waves is sampled once, deterministically,
 * from a lake-scaled spectrum: a few long art-directed swells plus a spread
 * of wind chop. The SAME bank is evaluated two ways:
 *
 *   1. GPU — unrolled into the water material's vertex stage as TSL nodes
 *      (closed-form displacement, normal, and crest-fold for foam).
 *   2. CPU — `heightAt`/`normalAt` for boat buoyancy, splash seating, and
 *      anything else physics needs.
 *
 * Because both sides evaluate identical math with identical parameters, the
 * boat rides the *actual* rendered surface with zero GPU readback and zero
 * latency — the contract §6.2.2 demands.
 *
 * Weather drives the field through two band scales (swell / chop) plus a
 * global choppiness, all uniforms — no shader recompiles as storms build.
 */

const G = 9.81

export interface GerstnerWave {
  dirX: number
  dirZ: number
  k: number // wavenumber 2π/λ
  omega: number // angular frequency
  amp: number // base amplitude (m)
  steep: number // Gerstner Q (0..1 share of max safe steepness)
  phase: number
  band: 0 | 1 // 0 = swell, 1 = chop
}

/** Wind blows from the NW → waves travel SE (toward the default hero view). */
const WIND_HEADING = Math.PI * 0.28

function makeWave(
  lambda: number,
  amp: number,
  steep: number,
  angle: number,
  phase: number,
  band: 0 | 1,
): GerstnerWave {
  const k = (2 * Math.PI) / lambda
  return {
    dirX: Math.sin(angle),
    dirZ: Math.cos(angle),
    k,
    omega: Math.sqrt(G * k),
    amp,
    steep,
    phase,
    band,
  }
}

export function makeWaveBank(chopCount = 26): GerstnerWave[] {
  const rand = seededRandom(20260703)
  const waves: GerstnerWave[] = []

  // Three long swells — the slow, rolling life of the lake.
  waves.push(makeWave(63, 0.16, 0.28, WIND_HEADING - 0.32, rand() * 6.28, 0))
  waves.push(makeWave(41, 0.12, 0.34, WIND_HEADING + 0.18, rand() * 6.28, 0))
  waves.push(makeWave(27, 0.08, 0.38, WIND_HEADING - 0.07, rand() * 6.28, 0))

  // Wind chop — wavelengths log-spaced 16 m → 1.8 m, amplitudes following a
  // fetch-limited slope (short lake fetch keeps them modest), directions
  // fanned around the wind.
  for (let i = 0; i < chopCount; i++) {
    const t = i / (chopCount - 1)
    const lambda = 16 * Math.pow(1.8 / 16, t) // geometric spacing
    const amp = 0.055 * Math.pow(lambda / 16, 0.92) * (0.75 + rand() * 0.5)
    const spread = (rand() * 2 - 1) * 0.95
    waves.push(
      makeWave(
        lambda,
        amp,
        0.55 + rand() * 0.3,
        WIND_HEADING + spread,
        rand() * Math.PI * 2,
        1,
      ),
    )
  }
  return waves
}

/** Live weather-facing parameters (mirrored into uniforms once per frame). */
export interface WaveFieldParams {
  swellScale: number
  chopScale: number
  choppiness: number
  timeScale: number
}

export class WaveField {
  readonly waves: GerstnerWave[]
  readonly params: WaveFieldParams = {
    swellScale: 1.0,
    chopScale: 1.0,
    choppiness: 1.0,
    timeScale: 1.0,
  }

  // TSL uniforms — the GPU view of `params` plus simulation time.
  readonly uTime = uniform(0)
  readonly uSwell = uniform(1)
  readonly uChop = uniform(1)
  readonly uChoppiness = uniform(1)

  // Boat-wake sources: a ring buffer of recent disturbance points, each
  // vec4(x, z, birthTime, amplitude). The water's vertex stage grows an
  // expanding, decaying ring packet from every source — superposed along
  // the boat's path they become the REAL displaced wedge of a wake, and
  // their crest-fold feeds the same whitecap-foam channel the storms use.
  static readonly WAKE_N = 24
  readonly uWakeSources = uniformArray(
    Array.from({ length: WaveField.WAKE_N }, () => new THREE.Vector4(0, 0, -1e3, 0)),
  )
  private wakeCursor = 0

  private simTime = 0

  constructor(chopCount = 26) {
    this.waves = makeWaveBank(chopCount)
  }

  /** Advance simulation time and mirror params into GPU uniforms. */
  update(dt: number): void {
    this.simTime += dt * this.params.timeScale
    this.uTime.value = this.simTime
    this.uSwell.value = this.params.swellScale
    this.uChop.value = this.params.chopScale
    this.uChoppiness.value = this.params.choppiness
  }

  get time(): number {
    return this.simTime
  }

  /** Drop a wake disturbance at (x, z); amp ≈ 0..0.24 with boat speed. */
  pushWakeSource(x: number, z: number, amp: number): void {
    const v = this.uWakeSources.array[this.wakeCursor] as THREE.Vector4
    v.set(x, z, this.simTime, amp)
    this.wakeCursor = (this.wakeCursor + 1) % WaveField.WAKE_N
  }

  private bandScaleCpu(band: 0 | 1): number {
    return band === 0 ? this.params.swellScale : this.params.chopScale
  }

  // ------------------------------------------------------------------ GPU

  /**
   * Builds the unrolled TSL displacement for a world-space XZ position node.
   * Returns nodes for the displaced offset, the surface normal, and a
   * crest-fold scalar (0 calm → 1 folding) used for whitecap foam.
   *
   * `ampFade` (0..1 node) flattens waves in shallow water so chop never
   * slices through the sand.
   */
  // TSL node types are too unwieldy to thread precisely — the shapes are
  // enforced by the shader compiler at build time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildTSL(posXZ: any, ampFade: any) {
    const offset = vec3(0, 0, 0).toVar('waveOffset')
    const nAccX = float(0).toVar('waveNx')
    const nAccZ = float(0).toVar('waveNz')
    const fold = float(0).toVar('waveFold')

    for (const w of this.waves) {
      const bandScale = w.band === 0 ? this.uSwell : this.uChop
      const amp = float(w.amp).mul(bandScale).mul(ampFade)
      const steep = float(w.steep).mul(this.uChoppiness)

      const theta = posXZ.x
        .mul(w.dirX * w.k)
        .add(posXZ.y.mul(w.dirZ * w.k))
        .sub(this.uTime.mul(w.omega))
        .add(w.phase)

      const s = sin(theta)
      const c = cos(theta)

      // Horizontal (choppy) displacement amplitude — steepness as a
      // fraction of the vertical amplitude, matching the CPU evaluator.
      const qa = steep.mul(amp)

      offset.x.addAssign(qa.mul(w.dirX).mul(c))
      offset.z.addAssign(qa.mul(w.dirZ).mul(c))
      offset.y.addAssign(amp.mul(s))

      const wa = amp.mul(w.k)
      nAccX.addAssign(wa.mul(w.dirX).mul(c))
      nAccZ.addAssign(wa.mul(w.dirZ).mul(c))
      fold.addAssign(qa.mul(w.k).mul(s))
    }

    // ---- boat wake: expanding ring packets from each disturbance ----
    const WAKE_C = 2.3 // ring propagation speed (m/s)
    for (let i = 0; i < WaveField.WAKE_N; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = this.uWakeSources.element(i) as any
      const dx = posXZ.x.sub(s.x)
      const dz = posXZ.y.sub(s.y)
      const r = dx.mul(dx).add(dz.mul(dz)).add(0.04).sqrt()
      const age = this.uTime.sub(s.z)
      const alive = age.greaterThan(0).select(float(1), float(0))
      const ringR = age.mul(WAKE_C).add(0.6)
      const band = r.sub(ringR).div(1.7)
      const env = exp(band.mul(band).negate())
        .mul(exp(age.mul(-0.5)))
        .mul(s.w)
        .mul(alive)
        .mul(ampFade)
      const phase = r.mul(2.6).sub(age.mul(5.6))
      offset.y.addAssign(sin(phase).mul(env))
      const slope = cos(phase).mul(env).mul(2.6)
      nAccX.addAssign(slope.mul(dx.div(r)))
      nAccZ.addAssign(slope.mul(dz.div(r)))
      // wake crests whitecap through the same foam channel as storms
      fold.addAssign(env.mul(2.4))
    }

    const normal = vec3(nAccX.negate(), float(1).sub(fold), nAccZ.negate())
    return { offset, normal, fold }
  }

  // ------------------------------------------------------------------ CPU

  /** Raw Gerstner displacement of the material point that starts at (x,z). */
  displacementAt(
    x: number,
    z: number,
    t = this.simTime,
  ): { dx: number; dy: number; dz: number } {
    let dx = 0
    let dy = 0
    let dz = 0
    const fade = Math.min(1, Math.max(0, waterDepth(x, z) / 2.2))
    const chopScale = this.params.choppiness
    for (const w of this.waves) {
      const amp = w.amp * this.bandScaleCpu(w.band) * fade
      const theta =
        (x * w.dirX + z * w.dirZ) * w.k -
        t * w.omega +
        w.phase
      const qa = w.steep * chopScale * amp
      const c = Math.cos(theta)
      dx += qa * w.dirX * c
      dz += qa * w.dirZ * c
      dy += amp * Math.sin(theta)
    }
    return { dx, dy, dz }
  }

  /**
   * Water surface height at a fixed world (x,z) — inverts the horizontal
   * Gerstner displacement with a couple of fixed-point iterations, exactly
   * as the boat's hull probes require.
   */
  heightAt(x: number, z: number, t = this.simTime): number {
    let px = x
    let pz = z
    for (let i = 0; i < 3; i++) {
      const d = this.displacementAt(px, pz, t)
      px = x - d.dx
      pz = z - d.dz
    }
    return this.displacementAt(px, pz, t).dy
  }

  /** Surface normal at a fixed world (x,z), via central differences. */
  normalAt(
    x: number,
    z: number,
    t = this.simTime,
    eps = 0.35,
  ): { x: number; y: number; z: number } {
    const hL = this.heightAt(x - eps, z, t)
    const hR = this.heightAt(x + eps, z, t)
    const hD = this.heightAt(x, z - eps, t)
    const hU = this.heightAt(x, z + eps, t)
    const nx = hL - hR
    const nz = hD - hU
    const ny = 2 * eps
    const len = Math.hypot(nx, ny, nz)
    return { x: nx / len, y: ny / len, z: nz / len }
  }
}
