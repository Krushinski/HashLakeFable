import * as THREE from 'three/webgpu'
import { fbm2, seededRandom } from '../core/noise'

/**
 * Cumulus clouds — soft procedural sprite billboards drifting with the
 * wind. Textures are generated once at boot (FBM density with a flattened
 * base, brighter tops), so the sky gets the reference images' puffy clouds
 * with zero assets and near-zero per-frame cost.
 *
 * Weather (Phase 6) drives coverage/darkness through `setMood`.
 */

function makeCloudTexture(seed: number, size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)

  const cx = 0.5
  const cy = 0.58 // flat-ish bottom: density center below middle
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size
      const v = j / size
      // ellipse falloff, squashed vertically
      const dx = (u - cx) * 2.1
      const dy = (v - cy) * 3.0
      const fall = Math.max(0, 1 - Math.hypot(dx, dy))
      // puffy FBM lobes
      const n =
        fbm2(u * 5.2 + seed * 11, v * 5.2 - seed * 7, {
          octaves: 5,
          seed: seed * 131 + 7,
        }) *
          0.5 +
        0.5
      let a = Math.max(0, fall * (0.55 + 0.75 * n) - 0.32)
      // flatten the base
      if (v > 0.72) a *= Math.max(0, 1 - (v - 0.72) * 5)
      a = Math.min(1, a * 1.6)

      // self-shading: darker toward the bottom of dense areas
      const shade = 1 - Math.max(0, v - 0.35) * 0.5 * a

      const idx = (j * size + i) * 4
      img.data[idx] = Math.round(255 * shade)
      img.data[idx + 1] = Math.round(255 * shade)
      img.data[idx + 2] = Math.round(252 * shade)
      img.data[idx + 3] = Math.round(255 * Math.pow(a, 1.25))
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

interface CloudSprite {
  sprite: THREE.Sprite
  speed: number
}

export class CloudSystem {
  readonly group = new THREE.Group()
  private readonly clouds: CloudSprite[] = []
  private readonly materials: THREE.SpriteMaterial[] = []
  private readonly deckMaterials: THREE.SpriteMaterial[] = []

  constructor(scene: THREE.Scene, count = 18) {
    const rand = seededRandom(7042026)
    const textures = [
      makeCloudTexture(1),
      makeCloudTexture(2),
      makeCloudTexture(3),
    ]

    // storm deck: low, wide, dark stratus layer that fades in with skyDark
    for (let i = 0; i < 9; i++) {
      const material = new THREE.SpriteMaterial({
        map: textures[i % 3],
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
        color: 0x2a2f34,
      })
      this.deckMaterials.push(material)
      const sprite = new THREE.Sprite(material)
      const ang = rand() * Math.PI * 2
      const rad = 500 + rand() * 1600
      const w = 1400 + rand() * 900
      sprite.scale.set(w, w * 0.22, 1)
      sprite.position.set(
        Math.sin(ang) * rad,
        380 + rand() * 130,
        Math.cos(ang) * rad,
      )
      this.group.add(sprite)
    }

    for (let i = 0; i < count; i++) {
      const tex = textures[Math.floor(rand() * textures.length)]
      const material = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0.5 + rand() * 0.35,
        depthWrite: false,
        fog: false,
      })
      material.userData.baseOpacity = material.opacity
      this.materials.push(material)
      const sprite = new THREE.Sprite(material)

      const ang = rand() * Math.PI * 2
      const rad = 1300 + rand() * 2600
      const w = 500 + rand() * 750
      sprite.scale.set(w, w * (0.32 + rand() * 0.14), 1)
      sprite.position.set(
        Math.sin(ang) * rad,
        520 + rand() * 420,
        Math.cos(ang) * rad,
      )
      this.group.add(sprite)
      this.clouds.push({ sprite, speed: 2.0 + rand() * 2.5 })
    }
    scene.add(this.group)
  }

  /** Weather hook: 0 = bright puffy, 1 = dark storm deck. */
  setMood(darkness: number, opacityScale = 1): void {
    for (const m of this.materials) {
      const c = 1 - darkness * 0.72
      m.color.setRGB(c, c, c * (1 - darkness * 0.08))
      m.opacity = Math.min(
        1,
        (m.userData.baseOpacity as number) * opacityScale,
      )
    }
    for (const m of this.deckMaterials) {
      m.opacity = Math.min(0.92, darkness * 1.05)
    }
  }

  update(dt: number): void {
    // slow SE drift, wrapping around the domain
    for (const c of this.clouds) {
      c.sprite.position.x += c.speed * dt * 0.7
      c.sprite.position.z += c.speed * dt * 0.5
      if (c.sprite.position.x > 4200) c.sprite.position.x = -4200
      if (c.sprite.position.z > 4200) c.sprite.position.z = -4200
    }
  }
}
