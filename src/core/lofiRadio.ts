/**
 * Lofi hip-hop radio (user-directed): the ChilledCow / Lofi Girl 24/7
 * stream ("beats to relax/study to", jfKfPfyJRdk) — zero cost, zero assets.
 *
 * v3: the raw-embed + postMessage approach failed twice on this machine,
 * so this is the OFFICIAL YouTube IFrame API — YT.Player with an onReady
 * that unmutes and plays. Created inside the M keypress (user gesture) so
 * Chrome's autoplay delegation applies. The API script loads once, lazily,
 * only after the user first asks for music.
 */

interface YTPlayer {
  unMute(): void
  setVolume(v: number): void
  playVideo(): void
  destroy(): void
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      width: number
      height: number
      videoId: string
      playerVars: Record<string, string | number>
      events: { onReady: (e: { target: YTPlayer }) => void }
    },
  ) => YTPlayer
}

declare global {
  interface Window {
    YT?: YTNamespace & { loaded?: number }
    onYouTubeIframeAPIReady?: () => void
  }
}

export class LofiRadio {
  private player: YTPlayer | null = null
  private host: HTMLDivElement | null = null
  enabled = false

  toggle(): boolean {
    if (this.enabled) {
      this.player?.destroy()
      this.player = null
      this.host?.remove()
      this.host = null
      this.enabled = false
      return false
    }
    this.enabled = true

    // VISIBLE mini player, bottom-right: YouTube treats viewable players
    // as first-class (offscreen ones get throttled/refused in some
    // profiles), and the user can SEE any error the embed reports —
    // no more silent mystery
    this.host = document.createElement('div')
    this.host.style.cssText =
      'position:fixed;right:16px;bottom:16px;width:224px;height:126px;' +
      'z-index:44;border-radius:12px;overflow:hidden;' +
      'border:1px solid rgba(69,200,192,0.25);' +
      'box-shadow:0 6px 28px rgba(0,0,0,0.45);opacity:0.94;'
    const inner = document.createElement('div')
    this.host.appendChild(inner)
    document.body.appendChild(this.host)

    const boot = () => {
      // user may have toggled off while the API script was loading
      if (!this.enabled || !this.host) return
      this.player = new window.YT!.Player(inner, {
        width: 224,
        height: 126,
        videoId: 'jfKfPfyJRdk',
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          controls: 1,
        },
        events: {
          onReady: (e) => {
            e.target.unMute()
            e.target.setVolume(75)
            e.target.playVideo()
          },
        },
      })
    }

    if (window.YT?.Player) {
      boot()
    } else {
      const prev = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        prev?.()
        boot()
      }
      if (!document.querySelector('script[src*="iframe_api"]')) {
        const s = document.createElement('script')
        s.src = 'https://www.youtube.com/iframe_api'
        document.head.appendChild(s)
      }
    }
    return true
  }
}
