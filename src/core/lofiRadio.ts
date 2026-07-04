/**
 * Lofi hip-hop radio (user-directed): the famous 24/7 lofi girl stream via
 * a hidden YouTube embed — zero cost, zero assets. Created inside the M
 * keypress (user gesture) so unmuted autoplay is permitted.
 */
export class LofiRadio {
  private iframe: HTMLIFrameElement | null = null
  enabled = false

  toggle(): boolean {
    if (this.iframe) {
      this.iframe.remove()
      this.iframe = null
      this.enabled = false
      return false
    }
    const f = document.createElement('iframe')
    f.width = '1'
    f.height = '1'
    f.style.cssText =
      'position:fixed;bottom:-4px;right:-4px;width:1px;height:1px;opacity:0.01;border:0;pointer-events:none;'
    f.allow = 'autoplay; encrypted-media'
    f.src =
      'https://www.youtube-nocookie.com/embed/jfKfPfyJRdk?autoplay=1&playsinline=1&controls=0&disablekb=1'
    document.body.appendChild(f)
    this.iframe = f
    this.enabled = true
    return true
  }
}
