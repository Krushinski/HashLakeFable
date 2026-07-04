import type { LiveBitcoinStore } from '../state/liveBitcoinStore'

/** Bottom-left Bitcoin pill (§15.2) — the quiet anchor of the live data. */
export class BitcoinPill {
  private el: HTMLDivElement
  private dot: HTMLSpanElement
  private text: HTMLSpanElement

  constructor(private readonly store: LiveBitcoinStore) {
    this.el = document.createElement('div')
    this.el.id = 'btc-pill'
    this.dot = document.createElement('span')
    this.dot.className = 'pill-dot'
    this.text = document.createElement('span')
    this.el.appendChild(this.text)
    this.el.appendChild(this.dot)
    document.body.appendChild(this.el)
  }

  update(): void {
    const s = this.store
    const price = s.price
      ? `$${s.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : '—'
    const chg = s.price ? ` ${s.chg24h >= 0 ? '+' : ''}${s.chg24h.toFixed(2)}%` : ''
    const fee = s.fastestFee ? ` · ${s.fastestFee} sat/vB` : ''
    const block = s.blockHeight ? ` · #${s.blockHeight.toLocaleString('en-US')}` : ''
    this.text.textContent = `${price}${chg}${fee}${block}`

    const stale = s.staleness
    this.dot.className =
      'pill-dot ' + (stale > 0.6 ? 'red' : stale > 0.15 ? 'yellow' : 'green')
    const chgClass = s.chg24h >= 0 ? 'pos' : 'neg'
    this.el.dataset.chg = chgClass
  }
}
