/**
 * ONE evaluation of "is it night?" shared by main.ts (bloom/fog rigs)
 * and proWater.ts (moonlit sky/water) — the two must never disagree.
 *
 * The lake lives on Eastern Time (§user: "night sky with our EST
 * daylight tracker"): night = 20:00–05:59 America/New_York. Formerly a
 * boot-time constant; now a small service that re-reads the clock every
 * 60 s, exposes a dusk/dawn factor (0 = day, 1 = night, a 30-minute
 * linear ramp centered on each boundary), and notifies listeners when
 * the boolean flips so an open page can re-rig live instead of waiting
 * for a reload. ?night forces it on, ?day forces it off — the probes
 * outrank the clock and freeze it entirely.
 *
 * Deliberately boolean-first: every consumer is a boot-shaped rig, and
 * main.ts covers a live flip with a short fade-to-black while the rigs
 * swap. When a real continuous day/night cycle lands, `factor` is the
 * per-frame crossfade input and the flip listeners simply go quiet.
 */

/** Minutes past midnight, Eastern Time. */
function estMinutes(): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date())
    let h = NaN
    let m = NaN
    for (const p of parts) {
      if (p.type === 'hour') h = parseInt(p.value, 10)
      else if (p.type === 'minute') m = parseInt(p.value, 10)
    }
    // some engines render midnight as "24"
    if (Number.isFinite(h) && Number.isFinite(m)) return (h % 24) * 60 + m
  } catch {
    /* Intl timezone data unavailable — fall back to the local clock */
  }
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

const DUSK_MIN = 20 * 60 // 20:00 EST
const DAWN_MIN = 6 * 60 // 06:00 EST
/** Full crossfade width in minutes, centered on each boundary — so the
 *  boolean (factor ≥ 0.5) still flips exactly at 20:00 / 06:00. */
const RAMP_MIN = 30

/** 0 = full day, 1 = full night; linear across the dusk/dawn windows. */
function nightFactor(m: number): number {
  const dusk = (m - (DUSK_MIN - RAMP_MIN / 2)) / RAMP_MIN
  if (dusk >= 0 && dusk <= 1) return dusk
  const dawn = (m - (DAWN_MIN - RAMP_MIN / 2)) / RAMP_MIN
  if (dawn >= 0 && dawn <= 1) return 1 - dawn
  return m >= DUSK_MIN || m < DAWN_MIN ? 1 : 0
}

type FlipListener = (night: boolean) => void

class NightWatch {
  /** Current verdict — flips exactly at 20:00 / 06:00 EST (or pinned by
   *  the ?night/?day probes). */
  night: boolean
  /** Dusk/dawn crossfade factor 0..1; equals the boolean outside the
   *  30-minute ramps. Nobody blends on it yet — it exists so the future
   *  continuous cycle replaces the flip listeners, not this service. */
  factor: number

  private readonly listeners: FlipListener[] = []

  constructor() {
    const flags = new URLSearchParams(location.search)
    const override = flags.has('day') ? false : flags.has('night') ? true : null
    if (override !== null) {
      this.night = override
      this.factor = override ? 1 : 0
      return // probes outrank the clock — never tick, never flip
    }
    // single sample — two clock reads could straddle a boundary mid-eval
    const m = estMinutes()
    this.factor = nightFactor(m)
    this.night = this.factor >= 0.5
    window.setInterval(() => this.evaluate(), 60_000)
  }

  /** Register for live day/night flips. Fires AFTER `night` updates;
   *  the listener owns its own transition theater (main.ts fades to
   *  black and swaps the rigs under the covers). */
  onFlip(fn: FlipListener): void {
    this.listeners.push(fn)
  }

  private evaluate(): void {
    const m = estMinutes()
    this.factor = nightFactor(m)
    const night = this.factor >= 0.5
    if (night === this.night) return
    this.night = night
    for (const fn of this.listeners) fn(night)
  }
}

export const nightWatch = new NightWatch()
