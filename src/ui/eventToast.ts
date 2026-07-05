/**
 * Event toasts — Regalia cards (design handoff): near-solid dark cards,
 * gold hairline, glowing accent bar, icon chip, mono values, timestamp,
 * auto-dismiss timer bar. Stacked top-right, newest on top.
 */

export type ToastType =
  | 'whale'
  | 'rally'
  | 'crash'
  | 'gust'
  | 'block'
  | 'feed'
  | 'info'

const TYPES: Record<ToastType, { glyph: string; accent: string }> = {
  whale: { glyph: '₿', accent: '#E3B968' },
  rally: { glyph: '▲', accent: '#5FB39A' },
  crash: { glyph: '▼', accent: '#D0623E' },
  gust: { glyph: '≈', accent: '#C0601C' },
  block: { glyph: '◆', accent: '#C9A24E' },
  feed: { glyph: '●', accent: '#5FB39A' },
  info: { glyph: '·', accent: '#C9A24E' },
}

export class EventToast {
  private host: HTMLDivElement

  constructor() {
    this.host = document.createElement('div')
    this.host.id = 'toast-host'
    this.host.dataset.mode = 'frame'
    document.body.appendChild(this.host)
  }

  setMode(mode: 'frame' | 'drive'): void {
    this.host.dataset.mode = mode
  }

  /**
   * `detail` may contain **bold** spans — rendered mono in the accent
   * color (values, per the design).
   */
  show(title: string, type: ToastType = 'info', detail = '', ms = 6000): void {
    const t = TYPES[type]
    const el = document.createElement('div')
    el.className = 'toast'
    el.style.setProperty('--accent', t.accent)
    const time = new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })
    const detailHtml = detail
      ? `<div class="t-detail">${detail.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</div>`
      : ''
    el.innerHTML = `
      <div class="t-icon">${t.glyph}</div>
      <div class="t-body"><div class="t-title">${title}</div>${detailHtml}</div>
      <div class="t-time">${time}</div>
      <div class="t-timer"></div>`
    // newest on top
    this.host.prepend(el)
    while (this.host.children.length > 4) {
      this.host.removeChild(this.host.lastChild!)
    }
    requestAnimationFrame(() => el.classList.add('in'))
    window.setTimeout(() => {
      el.classList.remove('in')
      window.setTimeout(() => el.remove(), 700)
    }, ms)
  }
}
