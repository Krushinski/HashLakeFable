import { shoreSdf, ISLAND, SANDBAR } from '../scene/lakeMap'
import type { BoatSystem } from '../scene/boatSystem'

/**
 * Minimap (§17.5) — the real lake shape (sampled from the same SDF the
 * world uses), glassy dark card, live boat dot with heading. North up.
 * Lives docked at the bottom of the debug panel (§user), not on the
 * main page.
 */

const SIZE = 148
const WORLD = 2100 // world meters spanned edge to edge

export class Minimap {
  readonly el: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private bg: ImageData

  constructor(private readonly boat: BoatSystem) {
    this.el = document.createElement('canvas')
    this.el.id = 'minimap'
    this.el.width = SIZE
    this.el.height = SIZE
    this.ctx = this.el.getContext('2d')!

    // bake the geography once
    const img = this.ctx.createImageData(SIZE, SIZE)
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const x = (i / (SIZE - 1) - 0.5) * WORLD
        const z = (j / (SIZE - 1) - 0.5) * WORLD
        const s = shoreSdf(x, z)
        const k = (j * SIZE + i) * 4
        if (s < 0) {
          // water: deeper = darker teal
          const d = Math.min(1, -s / 300)
          img.data[k] = 14 + 10 * (1 - d)
          img.data[k + 1] = 58 + 26 * (1 - d)
          img.data[k + 2] = 64 + 30 * (1 - d)
          img.data[k + 3] = 235
        } else {
          // land: dark glass with a faint shore rim
          const rim = s < 14 ? 46 : 0
          img.data[k] = 16 + rim * 0.9
          img.data[k + 1] = 24 + rim
          img.data[k + 2] = 22 + rim * 0.8
          img.data[k + 3] = 225
        }
      }
    }
    // island + sandbar accents
    const mark = (cx: number, cz: number, r: number, rgb: [number, number, number]) => {
      for (let j = 0; j < SIZE; j++) {
        for (let i = 0; i < SIZE; i++) {
          const x = (i / (SIZE - 1) - 0.5) * WORLD
          const z = (j / (SIZE - 1) - 0.5) * WORLD
          if (Math.hypot(x - cx, z - cz) < r) {
            const k = (j * SIZE + i) * 4
            img.data[k] = rgb[0]
            img.data[k + 1] = rgb[1]
            img.data[k + 2] = rgb[2]
          }
        }
      }
    }
    mark(ISLAND.cx, ISLAND.cz, ISLAND.r * 0.8, [72, 96, 58])
    mark(SANDBAR.cx, SANDBAR.cz, SANDBAR.rz * 0.9, [196, 182, 140])
    this.bg = img
  }

  update(): void {
    // parked inside the (hidden) debug panel → offsetParent is null → skip
    if (this.el.offsetParent === null) return
    this.ctx.putImageData(this.bg, 0, 0)
    const i = (this.boat.x / WORLD + 0.5) * (SIZE - 1)
    const j = (this.boat.z / WORLD + 0.5) * (SIZE - 1)
    const hx = Math.sin(this.boat.heading)
    const hz = -Math.cos(this.boat.heading)
    this.ctx.strokeStyle = 'rgba(111,252,232,0.9)'
    this.ctx.lineWidth = 1.6
    this.ctx.beginPath()
    this.ctx.moveTo(i, j)
    this.ctx.lineTo(i + hx * 9, j + hz * 9)
    this.ctx.stroke()
    this.ctx.fillStyle = '#6ffce8'
    this.ctx.beginPath()
    this.ctx.arc(i, j, 3, 0, Math.PI * 2)
    this.ctx.fill()
  }
}
