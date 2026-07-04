/**
 * Lofi hip-hop radio (user-directed): the ChilledCow / Lofi Girl 24/7
 * stream ("beats to relax/study to", jfKfPfyJRdk) via a hidden YouTube
 * embed — zero cost, zero assets.
 *
 * Playback notes learned the hard way:
 *  - a 1×1 px player is below YouTube's minimum size and silently refuses
 *    to play — the frame must be a real player size, parked off-screen
 *  - the embed boots muted-ish in some Chrome profiles even with a user
 *    gesture, so after load we poke it through the enablejsapi postMessage
 *    channel (unMute / setVolume / playVideo) until it responds
 */
export class LofiRadio {
  private iframe: HTMLIFrameElement | null = null
  private poker: number | null = null
  enabled = false

  toggle(): boolean {
    if (this.iframe) {
      if (this.poker) window.clearInterval(this.poker)
      this.poker = null
      this.iframe.remove()
      this.iframe = null
      this.enabled = false
      return false
    }
    const f = document.createElement('iframe')
    f.width = '320'
    f.height = '180'
    f.style.cssText =
      'position:fixed;left:-9999px;top:0;width:320px;height:180px;border:0;'
    f.allow = 'autoplay; encrypted-media'
    f.src =
      'https://www.youtube-nocookie.com/embed/jfKfPfyJRdk' +
      '?autoplay=1&playsinline=1&controls=0&disablekb=1&enablejsapi=1&mute=0'
    document.body.appendChild(f)
    this.iframe = f
    this.enabled = true

    // young players ignore early commands — repeat for a few seconds
    const send = (func: string, args: unknown[] = []) =>
      f.contentWindow?.postMessage(
        JSON.stringify({ event: 'command', func, args }),
        '*',
      )
    let tries = 0
    this.poker = window.setInterval(() => {
      send('unMute')
      send('setVolume', [70])
      send('playVideo')
      if (++tries >= 12 && this.poker) {
        window.clearInterval(this.poker)
        this.poker = null
      }
    }, 650)
    return true
  }
}
