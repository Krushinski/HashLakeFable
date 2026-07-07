/**
 * ONE evaluation of "is it night?" shared by main.ts (bloom/fog rigs)
 * and proWater.ts (moonlit sky/water) — the two must never disagree.
 *
 * The lake lives on Eastern Time (§user: "night sky with our EST
 * daylight tracker"): night = 20:00–05:59 America/New_York, evaluated
 * once at boot. ?night forces it on, ?day forces it off — the probes
 * outrank the clock.
 */
function estHour(): number {
  try {
    const h = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
    }).format(new Date())
    const n = parseInt(h, 10)
    // some engines render midnight as "24"
    return Number.isFinite(n) ? n % 24 : new Date().getHours()
  } catch {
    // Intl timezone data unavailable — fall back to the local clock
    return new Date().getHours()
  }
}

const flags = new URLSearchParams(location.search)
// single sample — two calls could straddle the 20:00 boundary mid-eval
const bootHour = estHour()

export const NIGHT_ACTIVE: boolean = flags.has('day')
  ? false
  : flags.has('night')
    ? true
    : bootHour >= 20 || bootHour < 6
