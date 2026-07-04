import type * as THREE from 'three/webgpu'

/**
 * Quality governor (§22): hold 60, never let the floor at 30 crack.
 * Sheds render scale first (biggest lever, invisible under TAA-less
 * bloom), recovers slowly when headroom returns.
 */

const STEPS = [1.0, 0.85, 0.72, 0.6, 0.5]

export class QualityGovernor {
  private step = 0
  private lowTime = 0
  private highTime = 0
  private readonly baseRatio: number

  constructor(private readonly renderer: THREE.WebGPURenderer) {
    this.baseRatio = Math.min(window.devicePixelRatio, 1.5)
  }

  get renderScale(): number {
    return STEPS[this.step]
  }

  update(dt: number, fps: number): void {
    if (fps <= 0) return
    if (fps < 34) {
      this.lowTime += dt
      this.highTime = 0
      if (this.lowTime > 2.5 && this.step < STEPS.length - 1) {
        this.step++
        this.apply()
        this.lowTime = 0
      }
    } else if (fps > 55) {
      this.highTime += dt
      this.lowTime = 0
      if (this.highTime > 12 && this.step > 0) {
        this.step--
        this.apply()
        this.highTime = 0
      }
    } else {
      this.lowTime = 0
      this.highTime = 0
    }
  }

  private apply(): void {
    this.renderer.setPixelRatio(this.baseRatio * STEPS[this.step])
    console.info(`quality governor: render scale ${STEPS[this.step]}`)
  }
}
