/**
 * Legend — Regalia v2 L-key overlay (Design handoff 2): centered 420px
 * card over a dimmed blurred backdrop. Storm tiers with the live
 * stormindex on a five-stop scale bar (active tier highlighted), then
 * the control keycap grid. Toggled with L.
 */

const TIERS = [
  { name: 'Serene', range: '0–20', color: '#5FB39A', desc: 'flat seas, steady chain' },
  { name: 'Uneasy', range: '20–40', color: '#C9A24E', desc: 'light chop, market stirring' },
  { name: 'Volatile', range: '40–60', color: '#E3A857', desc: 'swells building, watch fees' },
  { name: 'Storm', range: '60–80', color: '#D0623E', desc: 'heavy weather, hold course' },
  { name: 'Apocalyptic', range: '80–100', color: '#B5341A', desc: 'maelstrom — all hands' },
]

const CONTROLS: Array<[string[], string]> = [
  [['X'], 'drive mode'],
  [['←', '→'], 'steer'],
  [['Shift', 'Ctrl', 'Z'], 'boost'],
  [['Space'], 'anchor'],
  [['C'], 'cameras'],
  [['D'], 'debug'],
  [['L'], 'legend'],
  [['M'], 'radio'],
  [['F'], 'fullscreen'],
  [['Enter'], 'save tableau'],
  [['R'], 'reset'],
  [['Esc'], 'exit'],
]

export class LegendPanel {
  private el: HTMLDivElement
  private visible = false

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'legend-panel'
    this.el.hidden = true
    const tiers = TIERS.map(
      (t) => `
      <div class="lg-tier">
        <span class="lg-sw" style="background:${t.color}"></span>
        <span class="lg-tn">${t.name}<i class="lg-rg">${t.range}</i></span>
        <span class="lg-td">${t.desc}</span>
      </div>`,
    ).join('')
    const controls = CONTROLS.map(
      ([keys, act]) => `
      <div class="lg-ctl">
        <span class="lg-keys">${keys.map((k) => `<span class="lg-key">${k}</span>`).join('')}</span>
        <span class="lg-act">${act}</span>
      </div>`,
    ).join('')
    this.el.innerHTML = `
      <div class="lg-card">
        <div class="lg-head">
          <h1>LEGEND</h1>
          <div class="lg-hint">press <span class="lg-key">L</span> to close</div>
        </div>
        <div class="lg-secrow">
          <span class="lg-sec">STORM TIERS</span>
          <span class="lg-cur">stormindex <b>—</b> · <span class="lg-tiername">—</span></span>
        </div>
        <div class="lg-scale"><div class="lg-marker"></div></div>
        ${tiers}
        <div class="lg-divider"></div>
        <div class="lg-sec">CONTROLS</div>
        <div class="lg-controls">${controls}</div>
      </div>`
    document.body.appendChild(this.el)
  }

  /** Reflect the live storm index: marker, readout, active tier row. */
  setStorm(index: number): void {
    const i = Math.max(0, Math.min(100, index))
    const marker = this.el.querySelector('.lg-marker') as HTMLElement
    marker.style.left = `${i}%`
    this.el.querySelector('.lg-cur b')!.textContent = i.toFixed(1)
    const band = Math.min(4, Math.floor(i / 20))
    this.el.querySelector('.lg-tiername')!.textContent =
      TIERS[band].name.toUpperCase()
    this.el
      .querySelectorAll('.lg-tier')
      .forEach((row, n) => row.classList.toggle('on', n === band))
  }

  toggle(stormIndex?: number): boolean {
    this.visible = !this.visible
    if (this.visible && stormIndex !== undefined) this.setStorm(stormIndex)
    this.el.hidden = !this.visible
    return this.visible
  }
}
