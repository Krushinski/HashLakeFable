/** Legend (§17.4) — what the Bitcoin weather world means. Toggled with L. */
export class LegendPanel {
  private el: HTMLDivElement
  private visible = false

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'legend-panel'
    this.el.hidden = true
    this.el.innerHTML = `
      <header>Hashlake — Legend</header>
      <section>
        <h4>The lake is Bitcoin weather</h4>
        <p>Market and network conditions become sky, water, and light.
        The 24-hour price move leads; the weekly trend, fees, and mempool
        congestion weigh in behind it.</p>
        <div class="legend-tiers">
          <span class="t0">0–20 Serene</span><span class="t1">20–40 Uneasy</span>
          <span class="t2">40–60 Volatile</span><span class="t3">60–80 Storm</span>
          <span class="t4">80–100 Apocalyptic</span>
        </div>
      </section>
      <section>
        <h4>Signals</h4>
        <ul>
          <li><b>Whale splash</b> — a transaction of 3+ BTC entered the
          mempool. Splash size scales with the amount. Local only — whales
          never change the weather.</li>
          <li><b>Block pulse</b> — a new block was found. A clean ring runs
          through the water beneath the boat.</li>
          <li><b>Fog</b> — the data feeds have gone stale or uncertain.
          Not an apocalypse; the lake waits for the chain.</li>
        </ul>
      </section>
      <section>
        <h4>Controls</h4>
        <ul class="legend-keys">
          <li><b>X</b> Drive Mode</li>
          <li><b>Arrows</b> throttle & steer</li>
          <li><b>Shift</b> boost · <b>Ctrl+Shift</b> super</li>
          <li><b>Space</b> anchor</li>
          <li><b>C</b> cameras</li>
          <li><b>Enter</b> save tableau</li>
          <li><b>Esc</b> exit drive</li>
          <li><b>R</b> reset view</li>
          <li><b>D</b> debug</li>
          <li><b>L</b> legend</li>
          <li><b>F</b> fullscreen</li>
        </ul>
      </section>`
    document.body.appendChild(this.el)
  }

  toggle(): boolean {
    this.visible = !this.visible
    this.el.hidden = !this.visible
    return this.visible
  }
}
