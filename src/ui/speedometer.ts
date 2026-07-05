/**
 * Drive speedometer — Regalia dial (design handoff): royal-amber conic
 * value arc with a glowing leading dot, gold inner hairline, faint major
 * ticks, mono numerals. Appears only in Drive Mode, above the BTC pill.
 */
export class Speedometer {
  private el: HTMLDivElement
  private readout: HTMLSpanElement
  private visible = false
  private displayed = 0

  private static readonly MAX = 150

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'speedo'
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="dial-arc"></div>
      <div class="dial-ticks"></div>
      <div class="dial-ring"></div>
      <div class="dial-lead"></div>
      <div class="speedo-center"><span class="speedo-value">0</span><i>MPH</i></div>`
    document.body.appendChild(this.el)
    this.readout = this.el.querySelector('.speedo-value') as HTMLSpanElement
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
    this.el.style.setProperty('--sweep', `${(frac * 360).toFixed(1)}deg`)
    this.el.classList.toggle('hot', this.displayed > 55)
    this.readout.textContent = Math.round(this.displayed).toString()
  }
}
