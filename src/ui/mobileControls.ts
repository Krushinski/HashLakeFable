import type { DriveInput } from '../scene/boatSystem'

/**
 * Mobile surface (§5.6): Drive / Debug / Legend buttons, plus a hold-to-
 * throttle pad — drag up to throttle, drag sideways to steer. Touch never
 * rotates the camera, never spins the boat, never scrolls the page.
 */
export class MobileControls {
  private host: HTMLDivElement
  private pad: HTMLDivElement
  private padActive = false
  private padOrigin = { x: 0, y: 0 }

  constructor(
    private readonly input: DriveInput,
    hooks: {
      toggleDrive: () => void
      toggleDebug: () => void
      toggleLegend: () => void
      isDriving: () => boolean
    },
  ) {
    const coarse = window.matchMedia('(pointer: coarse)').matches
    this.host = document.createElement('div')
    this.host.id = 'mobile-ui'
    if (!coarse) this.host.classList.add('hidden')

    const mkBtn = (label: string, fn: () => void) => {
      const b = document.createElement('button')
      b.textContent = label
      b.addEventListener('click', (e) => {
        e.preventDefault()
        fn()
      })
      return b
    }
    const bar = document.createElement('div')
    bar.className = 'mobile-bar'
    const driveBtn = mkBtn('Drive', () => {
      hooks.toggleDrive()
      this.pad.classList.toggle('active', hooks.isDriving())
    })
    bar.appendChild(driveBtn)
    bar.appendChild(mkBtn('Debug', hooks.toggleDebug))
    bar.appendChild(mkBtn('Legend', hooks.toggleLegend))
    this.host.appendChild(bar)

    // throttle/steer pad
    this.pad = document.createElement('div')
    this.pad.className = 'mobile-pad'
    this.pad.innerHTML = '<span>hold · up = throttle · tilt = steer</span>'
    this.host.appendChild(this.pad)

    const onTouch = (e: TouchEvent) => {
      e.preventDefault()
      const t = e.touches[0]
      if (!t) return
      if (!this.padActive) {
        this.padActive = true
        this.padOrigin = { x: t.clientX, y: t.clientY }
      }
      const dx = t.clientX - this.padOrigin.x
      const dy = this.padOrigin.y - t.clientY // up = positive
      this.input.forward = dy > 14
      this.input.backward = dy < -24
      this.input.boost = dy > 110
      this.input.left = dx < -26
      this.input.right = dx > 26
    }
    const endTouch = (e: TouchEvent) => {
      e.preventDefault()
      this.padActive = false
      this.input.forward = false
      this.input.backward = false
      this.input.boost = false
      this.input.left = false
      this.input.right = false
    }
    this.pad.addEventListener('touchstart', onTouch, { passive: false })
    this.pad.addEventListener('touchmove', onTouch, { passive: false })
    this.pad.addEventListener('touchend', endTouch, { passive: false })
    this.pad.addEventListener('touchcancel', endTouch, { passive: false })

    document.body.appendChild(this.host)
  }
}
