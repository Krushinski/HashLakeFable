/**
 * Chill radio (user-directed), v4 — no more YouTube.
 *
 * The Lofi Girl LIVE embed refuses playback ("live stream recording is
 * not available") — live-stream embeds are gated in ways we can't fix
 * from the outside. So: a plain HTML5 <audio> pointed at SomaFM's
 * Groove Salad (chilled, ad-free, listener-supported — credited in
 * CREDITS.md), with a styled mini chip instead of a video box. Created
 * inside the M keypress, so autoplay policy is satisfied by the gesture.
 */

const STREAMS = [
  { url: 'https://ice1.somafm.com/groovesalad-256-mp3', label: 'SOMA FM · GROOVE SALAD' },
  { url: 'https://ice2.somafm.com/groovesalad-128-mp3', label: 'SOMA FM · GROOVE SALAD' },
  { url: 'https://ice1.somafm.com/fluid-128-mp3', label: 'SOMA FM · FLUID' },
]

export class LofiRadio {
  private audio: HTMLAudioElement | null = null
  private chip: HTMLDivElement | null = null
  private streamIndex = 0
  enabled = false

  toggle(): boolean {
    if (this.enabled) {
      this.audio?.pause()
      this.audio?.remove()
      this.audio = null
      this.chip?.remove()
      this.chip = null
      this.enabled = false
      return false
    }
    this.enabled = true

    const chip = document.createElement('div')
    chip.id = 'radio-chip'
    chip.innerHTML =
      '<span class="radio-dot"></span><span class="radio-label">TUNING…</span>'
    document.body.appendChild(chip)
    this.chip = chip

    const audio = document.createElement('audio')
    audio.crossOrigin = 'anonymous'
    audio.preload = 'none'
    audio.volume = 0.65
    document.body.appendChild(audio)
    this.audio = audio

    const label = chip.querySelector('.radio-label') as HTMLSpanElement
    const tryStream = (i: number) => {
      if (!this.enabled || !this.audio) return
      if (i >= STREAMS.length) {
        label.textContent = 'RADIO UNREACHABLE'
        chip.classList.add('err')
        return
      }
      this.streamIndex = i
      this.audio.src = STREAMS[i].url
      this.audio
        .play()
        .then(() => {
          label.textContent = STREAMS[i].label
          chip.classList.remove('err')
        })
        .catch(() => tryStream(i + 1))
    }
    audio.addEventListener('error', () => tryStream(this.streamIndex + 1))
    tryStream(0)
    return true
  }
}
