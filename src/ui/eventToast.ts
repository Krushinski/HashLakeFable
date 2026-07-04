/**
 * Event toasts (§17.2) — glassy, calm, queued, auto-fading. Bottom-right in
 * Drive Mode (preserve the view), top-center in Frame Mode.
 */
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

  show(message: string, ms = 5200): void {
    const el = document.createElement('div')
    el.className = 'toast'
    el.textContent = message
    this.host.appendChild(el)
    // limit the queue
    while (this.host.children.length > 4) {
      this.host.removeChild(this.host.firstChild!)
    }
    requestAnimationFrame(() => el.classList.add('in'))
    window.setTimeout(() => {
      el.classList.remove('in')
      window.setTimeout(() => el.remove(), 700)
    }, ms)
  }
}
