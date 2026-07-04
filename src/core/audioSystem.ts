/**
 * The soundscape (§user-approved: full, muted by default) — entirely
 * synthesized, zero assets:
 *  - engine: detuned saw pair → lowpass, pitch/gain ride the throttle;
 *    opening the throttle at boost overdrives the filter into a roar
 *  - wind/lake ambience: shaped noise through moving bandpass
 *  - thunder: filtered noise bursts with a long tail
 * AudioContext resumes on the first user gesture; M toggles.
 */

export class AudioSystem {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private engineGain: GainNode | null = null
  private engineFilter: BiquadFilterNode | null = null
  private oscA: OscillatorNode | null = null
  private oscB: OscillatorNode | null = null
  private windGain: GainNode | null = null
  private windFilter: BiquadFilterNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  enabled = false

  private ensureContext(): void {
    if (this.ctx) return
    const ctx = new AudioContext()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = 0
    this.master.connect(ctx.destination)

    // shared noise buffer
    const len = ctx.sampleRate * 2
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = this.noiseBuffer.getChannelData(0)
    let last = 0
    for (let i = 0; i < len; i++) {
      // pink-ish: integrate white noise lightly
      last = last * 0.94 + (Math.random() * 2 - 1) * 0.2
      data[i] = last
    }

    // ---- engine ----
    this.engineFilter = ctx.createBiquadFilter()
    this.engineFilter.type = 'lowpass'
    this.engineFilter.frequency.value = 220
    this.engineFilter.Q.value = 2.2
    this.engineGain = ctx.createGain()
    this.engineGain.gain.value = 0
    this.oscA = ctx.createOscillator()
    this.oscA.type = 'sawtooth'
    this.oscA.frequency.value = 42
    this.oscB = ctx.createOscillator()
    this.oscB.type = 'sawtooth'
    this.oscB.frequency.value = 43.7
    this.oscA.connect(this.engineFilter)
    this.oscB.connect(this.engineFilter)
    this.engineFilter.connect(this.engineGain)
    this.engineGain.connect(this.master)
    this.oscA.start()
    this.oscB.start()

    // ---- wind / lake ambience ----
    const windSrc = ctx.createBufferSource()
    windSrc.buffer = this.noiseBuffer
    windSrc.loop = true
    this.windFilter = ctx.createBiquadFilter()
    this.windFilter.type = 'bandpass'
    this.windFilter.frequency.value = 320
    this.windFilter.Q.value = 0.6
    this.windGain = ctx.createGain()
    this.windGain.gain.value = 0.05
    windSrc.connect(this.windFilter)
    this.windFilter.connect(this.windGain)
    this.windGain.connect(this.master)
    windSrc.start()
  }

  /** Toggle. Returns the new state. Must be called from a user gesture. */
  toggle(): boolean {
    this.ensureContext()
    this.enabled = !this.enabled
    if (this.ctx!.state === 'suspended') this.ctx!.resume()
    this.master!.gain.linearRampToValueAtTime(
      this.enabled ? 0.72 : 0,
      this.ctx!.currentTime + 0.6,
    )
    return this.enabled
  }

  thunder(intensity = 1): void {
    if (!this.ctx || !this.enabled || !this.noiseBuffer) return
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(900, ctx.currentTime)
    filter.frequency.exponentialRampToValueAtTime(70, ctx.currentTime + 2.8)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(0.9 * intensity, ctx.currentTime + 0.08)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 3.4)
    src.connect(filter)
    filter.connect(gain)
    gain.connect(this.master!)
    src.start()
    src.stop(ctx.currentTime + 3.6)
  }

  /** Per-frame: engine pitch/gain + ambience from world state. */
  update(
    mph: number,
    throttle: boolean,
    boosting: boolean,
    windDial: number,
  ): void {
    if (!this.ctx || !this.enabled) return
    const t = this.ctx.currentTime
    const rpm = 40 + mph * 2.6 + (boosting ? 26 : 0)
    this.oscA!.frequency.setTargetAtTime(rpm, t, 0.18)
    this.oscB!.frequency.setTargetAtTime(rpm * 1.037, t, 0.18)
    this.engineFilter!.frequency.setTargetAtTime(
      180 + mph * 9 + (boosting ? 720 : 0),
      t,
      0.25,
    )
    const load = throttle ? 0.22 + Math.min(0.2, mph * 0.0022) : Math.min(0.1, mph * 0.002)
    this.engineGain!.gain.setTargetAtTime(load, t, 0.3)

    this.windGain!.gain.setTargetAtTime(
      0.04 + windDial * 0.12 + mph * 0.0012,
      t,
      0.8,
    )
    this.windFilter!.frequency.setTargetAtTime(280 + windDial * 420 + mph * 6, t, 1.2)
  }
}
