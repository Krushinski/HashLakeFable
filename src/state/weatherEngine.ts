import { bus } from './eventBus'
import type { LiveBitcoinStore } from './liveBitcoinStore'

/**
 * The storm engine (§14): Bitcoin conditions → stormIndex 0–100 → world
 * dials. The 24h move dominates, the 7d trend weighs in behind it, network
 * signals color the rest. Whales never touch this (§24.6).
 */

export const TIER_NAMES = [
  'Serene',
  'Uneasy',
  'Volatile',
  'Storm',
  'Apocalyptic',
] as const

export interface WeatherDials {
  chop: number // 0..1
  wind: number
  rain: number
  lightning: number
  skyDark: number
  fog: number
  fireWeather: number
  boatInstability: number
  activity: number
}

export interface Contribution {
  label: string
  weight: number
  value: number // 0..100 pre-weight
}

export class WeatherEngine {
  /** Smoothed, displayed index. */
  stormIndex = 8
  /** Instant target from data + overrides. */
  private target = 8

  private crashBoost = 0
  private rallyDip = 0
  private gustUntil = 0
  private manualStale = false
  manualMode: 'live' | 'manual' = 'live'
  manualIndex = 0

  readonly dials: WeatherDials = {
    chop: 0,
    wind: 0,
    rain: 0,
    lightning: 0,
    skyDark: 0,
    fog: 0,
    fireWeather: 0,
    boatInstability: 0,
    activity: 0,
  }

  contributions: Contribution[] = []

  constructor(private readonly store: LiveBitcoinStore) {
    bus.on('crash', () => {
      this.crashBoost = Math.min(60, this.crashBoost + 45)
    })
    bus.on('rally', () => {
      this.rallyDip = Math.min(50, this.rallyDip + 35)
    })
    bus.on('gust', () => {
      this.gustUntil = performance.now() + 9000
    })
    bus.on('stale', () => {
      this.manualStale = true
    })
    bus.on('resumeLive', () => {
      this.manualStale = false
      this.crashBoost = 0
      this.rallyDip = 0
      this.manualMode = 'live'
    })
  }

  get tierIndex(): number {
    return Math.min(4, Math.floor(this.stormIndex / 20))
  }

  get tierName(): string {
    return TIER_NAMES[this.tierIndex]
  }

  /** Continuous tier coordinate 0..4 for visual interpolation. */
  get tierT(): number {
    return Math.min(4, this.stormIndex / 25)
  }

  get isGusting(): boolean {
    return performance.now() < this.gustUntil
  }

  get staleness(): number {
    return this.manualStale ? 1 : this.store.staleness
  }

  update(dt: number): void {
    const s = this.store

    // ---- contributions (each 0..100) ----
    // 24h: +5% calm, −5% or worse = full storm pressure
    const p24 = clamp(50 - s.chg24h * 10, 0, 100)
    // 7d: slower, wider band: −10% = full
    const p7 = clamp(50 - s.chg7d * 5, 0, 100)
    // fees: 1–3 sat/vB calm; 60+ severe
    const fee = clamp(((s.fastestFee || 1) - 2) * 1.8, 0, 100)
    // congestion: 5k calm → 250k severe
    const cong = clamp(((s.mempoolCount || 0) - 5000) / 2450, 0, 100)
    // freshness
    const fresh = this.staleness * 100

    this.contributions = [
      { label: 'price trend', weight: 0.35, value: p24 },
      { label: 'week trend', weight: 0.25, value: p7 },
      { label: 'fees', weight: 0.2, value: fee },
      { label: 'congestion', weight: 0.1, value: cong },
      { label: 'freshness', weight: 0.1, value: fresh },
    ]

    let idx = this.contributions.reduce(
      (sum, c) => sum + c.weight * c.value,
      0,
    )

    // manual overrides
    idx += this.crashBoost - this.rallyDip
    this.crashBoost *= Math.exp(-dt / 45) // decays over ~1.5 min
    this.rallyDip *= Math.exp(-dt / 45)

    if (this.manualMode === 'manual') idx = this.manualIndex

    this.target = clamp(idx, 0, 100)

    // smooth approach — weather moves like weather
    const k = 1 - Math.exp(-dt * 0.25)
    this.stormIndex += (this.target - this.stormIndex) * k

    // ---- dials ----
    const t = this.stormIndex / 100
    const gust = this.isGusting ? 0.3 : 0
    this.dials.chop = clamp(t * 1.1 + gust, 0, 1.3)
    this.dials.wind = clamp(t + gust * 1.2, 0, 1.3)
    this.dials.rain = clamp((this.stormIndex - 55) / 30, 0, 1)
    this.dials.lightning = clamp((this.stormIndex - 62) / 30, 0, 1)
    // §14.1 storm darkness curve: sharp ramp 45–80
    this.dials.skyDark =
      this.stormIndex < 30
        ? 0
        : this.stormIndex < 45
          ? ((this.stormIndex - 30) / 15) * 0.2
          : clamp(0.2 + ((this.stormIndex - 45) / 35) * 0.8, 0, 1)
    this.dials.fog = this.staleness
    this.dials.fireWeather = clamp((this.stormIndex - 80) / 20, 0, 1)
    this.dials.boatInstability = clamp(t * 1.15, 0, 1.2)
    this.dials.activity = clamp(t + gust, 0, 1)
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
