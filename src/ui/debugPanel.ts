import { bus } from '../state/eventBus'
import type { LiveBitcoinStore } from '../state/liveBitcoinStore'
import type { WeatherEngine } from '../state/weatherEngine'

/**
 * Debug dashboard (§17.3) — dark translucent card in the Dashboard.png
 * language: metric tiles, stormindex contributions, weather dials, feed
 * rows, manual overrides. Calm: repaints at 2 Hz, only while visible.
 */

export interface DebugTelemetry {
  fps: number
  rendererPath: string
  mode: string
  boatSpeedMph: number
  boatPos: { x: number; z: number }
  heading: number
  cameraPreset: string
}

export class DebugPanel {
  private el: HTMLDivElement
  private body: HTMLDivElement
  private mapDock: HTMLDivElement
  private visible = false
  private timer: number | null = null

  constructor(
    private readonly store: LiveBitcoinStore,
    private readonly weather: WeatherEngine,
    private readonly telemetry: () => DebugTelemetry,
  ) {
    this.el = document.createElement('div')
    this.el.id = 'debug-panel'
    this.el.hidden = true
    // stable two-part layout: re-rendered body + persistent map dock, so
    // the 2 Hz innerHTML repaint never destroys the minimap canvas
    this.body = document.createElement('div')
    this.mapDock = document.createElement('div')
    this.mapDock.className = 'dbg-map'
    this.mapDock.innerHTML = '<h4>lake map</h4>'
    // storm slider — drives the engine's existing manual override
    // (manualMode/manualIndex). Lives OUTSIDE the 2 Hz innerHTML body so
    // a drag never fights the repaint; "Resume live" hands back to data.
    const stormDock = document.createElement('div')
    stormDock.className = 'dbg-storm'
    stormDock.innerHTML = '<h4>storm slider — drag to override</h4>'
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0'
    range.max = '100'
    range.step = '1'
    range.value = String(Math.round(weather.stormIndex))
    range.style.width = '100%'
    range.addEventListener('input', () => {
      this.weather.manualMode = 'manual'
      this.weather.manualIndex = Number(range.value)
    })
    stormDock.appendChild(range)
    this.el.appendChild(this.body)
    this.el.appendChild(stormDock)
    this.el.appendChild(this.mapDock)
    document.body.appendChild(this.el)
    this.el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button')
      if (!btn) return
      const act = btn.dataset.act
      if (act === 'crash') bus.emit('crash', undefined)
      if (act === 'rally') bus.emit('rally', undefined)
      if (act === 'gust') bus.emit('gust', undefined)
      if (act === 'stale') bus.emit('stale', undefined)
      if (act === 'resume') bus.emit('resumeLive', undefined)
      if (act === 'block') bus.emit('newBlock', { height: this.store.blockHeight || 0 })
      if (act?.startsWith('whale')) {
        const btc = parseFloat(act.split(':')[1])
        bus.emit('whale', { btc, txid: 'manual-test' })
      }
    })
  }

  /** Dock the minimap canvas at the bottom of the panel (§user: not on the main page). */
  attachMinimap(canvas: HTMLCanvasElement): void {
    this.mapDock.appendChild(canvas)
  }

  toggle(): boolean {
    this.visible = !this.visible
    this.el.hidden = !this.visible
    if (this.visible) {
      this.render()
      this.timer = window.setInterval(() => this.render(), 500)
    } else if (this.timer) {
      window.clearInterval(this.timer)
      this.timer = null
    }
    return this.visible
  }

  private render(): void {
    const s = this.store
    const w = this.weather
    const t = this.telemetry()

    const tile = (label: string, value: string, cls = '') =>
      `<div class="dbg-tile ${cls}"><span>${label}</span><b>${value}</b></div>`

    const bar = (label: string, frac: number, right: string) =>
      `<div class="dbg-bar"><span>${label}</span><div class="track"><div class="fill" style="width:${Math.round(
        Math.min(1, Math.max(0, frac)) * 100,
      )}%"></div></div><i>${right}</i></div>`

    const feedRow = (name: string) => {
      const f = s.feeds[name]
      const age = f.lastUpdate
        ? `${Math.max(0, Math.round((Date.now() - f.lastUpdate) / 1000))}s ago`
        : '—'
      return `<div class="dbg-feed"><span class="dot ${f.status}"></span><span>${name}</span><i>${f.detail ?? f.status}</i><b>${age}</b></div>`
    }

    this.body.innerHTML = `
      <header>Hashlake — Debug <i>${t.fps.toFixed(0)} fps · ${t.rendererPath}</i></header>
      <div class="dbg-tiles">
        ${tile('Price', s.price ? '$' + s.price.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—')}
        ${tile('24h', `${s.chg24h >= 0 ? '+' : ''}${s.chg24h.toFixed(2)}%`, s.chg24h >= 0 ? 'pos' : 'neg')}
        ${tile('7d', `${s.chg7d >= 0 ? '+' : ''}${s.chg7d.toFixed(2)}%`, s.chg7d >= 0 ? 'pos' : 'neg')}
        ${tile('Fastest fee', s.fastestFee ? s.fastestFee + ' sat/vB' : '—')}
        ${tile('Mempool', s.mempoolCount ? s.mempoolCount.toLocaleString('en-US') + ' tx' : '—')}
        ${tile('Block', s.blockHeight ? '#' + s.blockHeight.toLocaleString('en-US') : '—')}
        ${tile('Difficulty Δ', `${s.difficultyChange >= 0 ? '+' : ''}${s.difficultyChange.toFixed(2)}%`)}
        ${tile('Staleness', `${Math.round(w.staleness * 100)}%`)}
        ${tile('Mode', t.mode)}
        ${tile('Speed', t.boatSpeedMph.toFixed(0) + ' mph')}
        ${tile('Boat', `${t.boatPos.x.toFixed(0)}, ${t.boatPos.z.toFixed(0)}`)}
        ${tile('Camera', t.cameraPreset)}
      </div>
      <section>
        <h4>stormindex <b>${w.stormIndex.toFixed(1)}</b> <em>${w.tierName}</em></h4>
        ${w.contributions
          .map((c) => bar(`${c.label} ×${c.weight}`, c.value / 100, c.value.toFixed(1)))
          .join('')}
      </section>
      <section>
        <h4>dials</h4>
        ${bar('chop', w.dials.chop, Math.round(w.dials.chop * 100) + '%')}
        ${bar('wind', w.dials.wind, Math.round(w.dials.wind * 100) + '%')}
        ${bar('gust', w.dials.gust, Math.round(w.dials.gust * 100) + '%')}
        ${bar('rain', w.dials.rain, Math.round(w.dials.rain * 100) + '%')}
        ${bar('lightning', w.dials.lightning, Math.round(w.dials.lightning * 100) + '%')}
        ${bar('sky dark', w.dials.skyDark, Math.round(w.dials.skyDark * 100) + '%')}
        ${bar('fog', w.dials.fog, Math.round(w.dials.fog * 100) + '%')}
        ${bar('fire', w.dials.fireWeather, Math.round(w.dials.fireWeather * 100) + '%')}
      </section>
      <section>
        <h4>feeds</h4>
        ${['price', 'mempool', 'fees', 'whales', 'market', 'difficulty', 'websocket']
          .map(feedRow)
          .join('')}
      </section>
      <section class="dbg-actions">
        <h4>manual override — ${w.manualMode}</h4>
        <div>
          <button data-act="crash">Crash</button>
          <button data-act="rally">Rally</button>
          <button data-act="gust">Gust</button>
          <button data-act="stale">Stale</button>
          <button data-act="block">Block</button>
          <button data-act="resume">Resume live</button>
        </div>
        <div>
          <button data-act="whale:3">Whale 3</button>
          <button data-act="whale:10">10</button>
          <button data-act="whale:50">50</button>
          <button data-act="whale:300">300</button>
          <button data-act="whale:1000">1000</button>
        </div>
      </section>`
  }
}
