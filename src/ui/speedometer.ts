/**
 * Drive speedometer — minimal, classy, a little futuristic (§user).
 * A thin 240° arc with a glowing sweep, digital mph, and boost ticks at
 * 52/100/120/150. Appears only in Drive Mode, above the BTC pill.
 */
export class Speedometer {
  private el: HTMLDivElement
  private sweep: SVGPathElement
  private readout: HTMLSpanElement
  private visible = false
  private displayed = 0

  private static readonly MAX = 150
  private static readonly R = 44
  private static readonly ARC = 240 // degrees of sweep

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'speedo'
    this.el.hidden = true

    const R = Speedometer.R
    const size = R * 2 + 14
    const c = size / 2

    const arcPath = (fracFrom: number, fracTo: number): string => {
      const a0 = ((fracFrom * Speedometer.ARC - 210) * Math.PI) / 180
      const a1 = ((fracTo * Speedometer.ARC - 210) * Math.PI) / 180
      // large-arc only past 180° of actual sweep (240° dial → frac 0.75);
      // keying it on frac 0.5 made the boost arc escape through the gap
      const large = (fracTo - fracFrom) * Speedometer.ARC > 180 ? 1 : 0
      return `M ${c + R * Math.cos(a0)} ${c + R * Math.sin(a0)} A ${R} ${R} 0 ${large} 1 ${
        c + R * Math.cos(a1)
      } ${c + R * Math.sin(a1)}`
    }

    const tick = (frac: number): string => {
      const a = ((frac * Speedometer.ARC - 210) * Math.PI) / 180
      const r0 = R - 5
      const r1 = R + 1
      return `M ${c + r0 * Math.cos(a)} ${c + r0 * Math.sin(a)} L ${
        c + r1 * Math.cos(a)
      } ${c + r1 * Math.sin(a)}`
    }

    this.el.innerHTML = `
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
        <path d="${arcPath(0, 1)}" class="speedo-track"/>
        <path d="${arcPath(0, 0)}" class="speedo-sweep"/>
        <path d="${[52, 100, 120, 150]
          .map((v) => tick(v / Speedometer.MAX))
          .join(' ')}" class="speedo-ticks"/>
      </svg>
      <div class="speedo-center"><span class="speedo-value">0</span><i>mph</i></div>`
    document.body.appendChild(this.el)
    this.sweep = this.el.querySelector('.speedo-sweep') as SVGPathElement
    this.readout = this.el.querySelector('.speedo-value') as HTMLSpanElement

    // stash for arc updates
    ;(this.sweep as unknown as { _arc: (f0: number, f1: number) => string })._arc =
      arcPath
  }

  setVisible(v: boolean): void {
    this.visible = v
    this.el.hidden = !v
  }

  update(mph: number): void {
    if (!this.visible) return
    // smooth needle
    this.displayed += (mph - this.displayed) * 0.18
    const frac = Math.min(1, this.displayed / Speedometer.MAX)
    const arc = (
      this.sweep as unknown as { _arc: (f0: number, f1: number) => string }
    )._arc
    this.sweep.setAttribute('d', arc(0, Math.max(0.001, frac)))
    // hot glow past cruise
    this.sweep.classList.toggle('hot', this.displayed > 55)
    this.readout.textContent = Math.round(this.displayed).toString()
  }
}
