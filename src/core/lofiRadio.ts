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

    // real player size, parked off-screen (tiny players refuse playback)
    this.host = document.createElement('div')
    this.host.style.cssText =
      'position:fixed;left:-9999px;top:0;width:320px;height:180px;'
    const inner = document.createElement('div')
    this.host.appendChild(inner)
    document.body.appendChild(this.host)

    const boot = () => {
      // user may have toggled off while the API script was loading
      if (!this.enabled || !this.host) return
      this.player = new window.YT!.Player(inner, {
        width: 320,
        height: 180,
        videoId: 'jfKfPfyJRdk',
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          controls: 0,
          disablekb: 1,
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
