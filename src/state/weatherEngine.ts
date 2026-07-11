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
  gust: number // 0..1 envelope, not a square wave
  rain: number
  lightning: number
  skyDark: number
  fog: number
  fireWeather: number
  boatInstability: number
  activity: number
}

/** Gust envelope — attack/hold/decay in seconds. The old 9 s boolean
 *  square wave read as an on/off glitch; wind actually swells and dies. */
const GUST_ATTACK = 1.5
const GUST_HOLD = 4
const GUST_DECAY = 3

/** Prevailing wind heading (radians). Matches the FFT spectrum convention:
 *  the wind vector in the XZ plane is (cos θ, sin θ). 130° is the heading
 *  the lake was tuned under. */
const BASE_WIND_RAD = (130 * Math.PI) / 180

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
  /** Seconds since gust onset; Infinity = no gust running. */
  private gustT = Infinity
  /** Current gust envelope value 0..1 (mirrored into dials.gust). */
  private gust = 0
  private windPhase = 0
  private manualStale = false
  manualMode: 'live' | 'manual' = 'live'
  manualIndex = 0

  /** Unified wind vector — one heading for FFT spectrum, rain shear and
   *  cloth. Veers ±15° as the storm builds (dead-steady air reads fake
   *  under a thunderstorm). */
  windHeadingRad = BASE_WIND_RAD
  /** Wind strength 0..1 for consumers that want a plain scalar. */
  windSpeed01 = 0

  readonly dials: WeatherDials = {
    chop: 0,
    wind: 0,
    gust: 0,
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
      // fresh gust attacks from zero; a re-trigger mid-gust rewinds to
      // the start of the hold (never re-pops the attack)
      this.gustT = this.gustT === Infinity ? 0 : Math.min(this.gustT, GUST_ATTACK)
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
    return this.gust > 0.05
  }

  /** Wind vector X component (heading × strength), FFT convention. */
  get windX(): number {
    return Math.cos(this.windHeadingRad) * this.windSpeed01
  }

  /** Wind vector Z component (heading × strength), FFT convention. */
  get windZ(): number {
    return Math.sin(this.windHeadingRad) * this.windSpeed01
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

    // ---- gust envelope: attack → hold → decay ----
    if (this.gustT !== Infinity) {
      this.gustT += dt
      const g = this.gustT
      if (g < GUST_ATTACK) this.gust = g / GUST_ATTACK
      else if (g < GUST_ATTACK + GUST_HOLD) this.gust = 1
      else if (g < GUST_ATTACK + GUST_HOLD + GUST_DECAY)
        this.gust = 1 - (g - GUST_ATTACK - GUST_HOLD) / GUST_DECAY
      else {
        this.gust = 0
        this.gustT = Infinity
      }
    }

    // ---- dials ----
    const t = this.stormIndex / 100
    // 0.3 is the old square wave's amplitude — same peak, now enveloped
    const gust = this.gust * 0.3
    this.dials.gust = this.gust
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

    // ---- unified wind vector ----
    // two incommensurate sines = cheap smooth veer; amplitude rides the
    // storm so Serene air holds its heading
    this.windPhase += dt * (0.02 + t * 0.06)
    const veer =
      Math.sin(this.windPhase) * 0.7 +
      Math.sin(this.windPhase * 2.7 + 1.3) * 0.3
    this.windHeadingRad = BASE_WIND_RAD + veer * (Math.PI / 12) * t
    this.windSpeed01 = Math.min(1, this.dials.wind)
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
