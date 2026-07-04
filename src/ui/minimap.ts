import { shoreSdf, ISLAND, SANDBAR } from '../scene/lakeMap'
import type { BoatSystem } from '../scene/boatSystem'

/**
 * Minimap (§17.5) — the real lake shape (sampled from the same SDF the
 * world uses), glassy dark card, live boat dot with heading, named
 * destination marks. North up. Docked at the bottom of the debug panel,
 * sized to fill its width.
 */

const W = 356
const H = 313
// world window, uniform scale (0.187 px/m)
const X0 = -950
const X1 = 950
const Z0 = -830
const Z1 = 840

const px = (x: number) => ((x - X0) / (X1 - X0)) * (W - 1)
const pz = (z: number) => ((z - Z0) / (Z1 - Z0)) * (H - 1)

interface Marker {
  x: number
  z: number
  label: string
  color: string
}

const MARKERS: Marker[] = [
  { x: 560, z: 190, label: 'COVE', color: 'rgba(111,252,232,0.8)' },
  { x: -585, z: 110, label: 'DOCK', color: 'rgba(111,252,232,0.8)' },
  { x: -140, z: -430, label: 'NORTH BAY', color: 'rgba(111,252,232,0.8)' },
  { x: ISLAND.cx, z: ISLAND.cz, label: 'ISLAND', color: 'rgba(196,220,150,0.85)' },
  { x: SANDBAR.cx, z: SANDBAR.cz, label: 'SANDBAR', color: 'rgba(222,206,160,0.8)' },
]

export class Minimap {
  readonly el: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private bg: ImageData

  constructor(private readonly boat: BoatSystem) {
    this.el = document.createElement('canvas')
    this.el.id = 'minimap'
    this.el.width = W
    this.el.height = H
    this.ctx = this.el.getContext('2d')!

    // bake the geography
    const img = this.ctx.createImageData(W, H)
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = X0 + (i / (W - 1)) * (X1 - X0)
        const z = Z0 + (j / (H - 1)) * (Z1 - Z0)
        const s = shoreSdf(x, z)
        const k = (j * W + i) * 4
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
    // island + sandbar land accents
    const mark = (
      cx: number,
      cz: number,
      r: number,
      rgb: [number, number, number],
    ) => {
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const x = X0 + (i / (W - 1)) * (X1 - X0)
          const z = Z0 + (j / (H - 1)) * (Z1 - Z0)
          if (Math.hypot(x - cx, z - cz) < r) {
            const k = (j * W + i) * 4
            img.data[k] = rgb[0]
            img.data[k + 1] = rgb[1]
            img.data[k + 2] = rgb[2]
          }
        }
      }
    }
    mark(ISLAND.cx, ISLAND.cz, ISLAND.landR, [72, 96, 58])
    mark(SANDBAR.cx, SANDBAR.cz, SANDBAR.rz * 0.4, [196, 182, 140])

    // labels baked on top of the geography
    this.ctx.putImageData(img, 0, 0)
    this.ctx.font = '600 9px ui-monospace, monospace'
    this.ctx.textAlign = 'center'
    for (const m of MARKERS) {
      const i = px(m.x)
      const j = pz(m.z)
      this.ctx.fillStyle = m.color
      this.ctx.beginPath()
      this.ctx.arc(i, j, 2.2, 0, Math.PI * 2)
      this.ctx.fill()
      this.ctx.fillStyle = m.color
      this.ctx.fillText(m.label, i, j - 5)
    }
    this.bg = this.ctx.getImageData(0, 0, W, H)
  }

  update(): void {
    // parked inside the (hidden) debug panel → offsetParent is null → skip
    if (this.el.offsetParent === null) return
    this.ctx.putImageData(this.bg, 0, 0)
    const i = px(this.boat.x)
    const j = pz(this.boat.z)
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
