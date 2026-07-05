/**
 * Event toasts — Regalia v2 "whisper scale" (Design handoff 2): a
 * jeweler's label, not a desktop notification. One visual line per
 * event — bare 16px glyph · title · mono value on the right — plus a
 * rare detail second line and a 1px accent timer. Max 3 visible,
 * overflow queued, newest on top.
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

const MAX_VISIBLE = 3

export class EventToast {
  private host: HTMLDivElement
  private queue: Array<() => void> = []

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
   * `detail`'s first **bold** span becomes the right-hand mono value;
   * the prose around it is dropped as non-essential (v2 anatomy). A
   * detail with no bold span renders as the rare second line.
   */
  show(title: string, type: ToastType = 'info', detail = '', ms = 6000): void {
    if (this.host.children.length >= MAX_VISIBLE) {
      this.queue.push(() => this.show(title, type, detail, ms))
      return
    }
    const t = TYPES[type]
    const el = document.createElement('div')
    el.className = 'toast'
    el.style.setProperty('--accent', t.accent)
    const bold = detail.match(/\*\*(.+?)\*\*/)
    const value = bold ? `<span class="t-value">${bold[1]}</span>` : ''
    const detailHtml =
      !bold && detail ? `<div class="t-detail">${detail}</div>` : ''
    el.innerHTML = `
      <div class="t-row"><span class="t-glyph">${t.glyph}</span><span class="t-title">${title}</span>${value}</div>
      ${detailHtml}
      <div class="t-timer" style="animation-duration:${ms}ms"></div>`
    // newest on top
    this.host.prepend(el)
    requestAnimationFrame(() => el.classList.add('in'))
    window.setTimeout(() => {
      el.classList.remove('in')
      window.setTimeout(() => {
        el.remove()
        this.queue.shift()?.()
      }, 320)
    }, ms)
  }
}
