import * as THREE from 'three/webgpu'
import { attribute, positionWorld, smoothstep, texture, uniform, uv, vec2, vec3, float } from 'three/tsl'
import type { WaveField } from './waveField'
import type { BoatSystem } from './boatSystem'
import { makeFoamTexture } from './proceduralTextures'
import { seededRandom } from '../core/noise'

/**
 * Hyper-real wake v3, tied to hull physics (§6.3 + user contract).
 *
 * Surface foam — three ribbons fed by the speed AT THE MOMENT each water
 * parcel was disturbed:
 *  - Kelvin V-arms: two crisp divergent lines leaving the bow at the
 *    classic ~19.5°, propagating outward at a rate set by boat speed
 *  - Turbulent stern wash: churned band directly aft, widening and
 *    dissolving; width/brightness/persistence all scale with speed
 *  All ribbons sample the tileable lacy foam texture in world space, so
 *  the wash reads as real churned filaments instead of a flat white band.
 *
 * Airborne water — two pooled particle systems:
 *  - bow spray: fans thrown sideways off the bow at speed, falling back
 *    under gravity and dying in the water like real spray
 *  - rooster tail: the tall plume a planing hull throws behind the stern
 *    at boost speeds
 */

const MAX_POINTS = 150
const DROP_DISTANCE = 1.3
const LIFE = 9.5
const KELVIN_SIN = 0.3338 // sin(19.5°)

interface WakePoint {
  x: number
  z: number
  dirX: number
  dirZ: number
  age: number
  speed: number // boat speed when this parcel was disturbed
}

/** Soft round droplet sprite — square points read as 2D confetti. */
let sprayTexture: THREE.CanvasTexture | null = null
function makeSprayTexture(): THREE.CanvasTexture {
  if (sprayTexture) return sprayTexture
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,0.9)')
  grad.addColorStop(0.35, 'rgba(242,250,248,0.5)')
  grad.addColorStop(0.75, 'rgba(238,248,245,0.12)')
  grad.addColorStop(1, 'rgba(238,248,245,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  sprayTexture = new THREE.CanvasTexture(c)
  return sprayTexture
}

/** Pooled gravity particles rendered as Points; dead ones park far below. */
class SprayPool {
  readonly points: THREE.Points
  private readonly pos: THREE.BufferAttribute
  private readonly vel: Float32Array
  private readonly age: Float32Array
  private readonly life: Float32Array
  private cursor = 0
  private readonly rand = seededRandom(777)

  constructor(scene: THREE.Scene, readonly capacity: number, size: number, opacity: number) {
    const geo = new THREE.BufferGeometry()
    const arr = new Float32Array(capacity * 3)
    for (let i = 0; i < capacity; i++) arr[i * 3 + 1] = -500
    this.pos = new THREE.BufferAttribute(arr, 3)
    geo.setAttribute('position', this.pos)
    const mat = new THREE.PointsMaterial({
      color: 0xf0faf7,
      size,
      map: makeSprayTexture(),
      transparent: true,
      opacity,
      depthWrite: false,
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 18
    scene.add(this.points)
    this.vel = new Float32Array(capacity * 3)
    this.age = new Float32Array(capacity)
    this.life = new Float32Array(capacity).fill(-1)
  }

  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    jitter: number, life: number,
  ): void {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    this.pos.setXYZ(i, x, y, z)
    this.vel[i * 3] = vx + (this.rand() - 0.5) * jitter
    this.vel[i * 3 + 1] = vy + (this.rand() - 0.5) * jitter * 0.6
    this.vel[i * 3 + 2] = vz + (this.rand() - 0.5) * jitter
    this.age[i] = 0
    this.life[i] = life * (0.7 + this.rand() * 0.6)
  }

  update(dt: number): void {
    let any = false
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] < 0) continue
      any = true
      this.age[i] += dt
      const y = this.pos.getY(i) + this.vel[i * 3 + 1] * dt
      // die when spent or fallen back into the lake
      if (this.age[i] > this.life[i] || y < -0.25) {
        this.life[i] = -1
        this.pos.setXYZ(i, 0, -500, 0)
        continue
      }
      this.vel[i * 3 + 1] -= 9.8 * dt
      this.pos.setXYZ(
        i,
        this.pos.getX(i) + this.vel[i * 3] * dt,
        y,
        this.pos.getZ(i) + this.vel[i * 3 + 2] * dt,
      )
    }
    if (any) this.pos.needsUpdate = true
    this.points.visible = any
  }
}

export class WakeSystem {
  private readonly mesh: THREE.Mesh
  private readonly geometry: THREE.BufferGeometry
  private readonly points: WakePoint[] = []
  private lastX = 0
  private lastZ = 0
  private readonly bowSpray: SprayPool
  private readonly rooster: SprayPool
  private readonly streaks: SprayPool
  private readonly boil: THREE.Mesh
  private readonly boilOpacity = { value: 0 }
  private sprayCarry = 0
  private roosterCarry = 0
  private streakCarry = 0
  private wakeSrcLastX = 0
  private wakeSrcLastZ = 0

  constructor(
    scene: THREE.Scene,
    private readonly waveField: WaveField,
    private readonly boat: BoatSystem,
  ) {
    this.geometry = new THREE.BufferGeometry()
    // 3 ribbons (wash + port arm + starboard arm), 2 verts per point each
    const maxVerts = MAX_POINTS * 6
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3),
    )
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(maxVerts * 4), 4),
    )
    // across-ribbon coordinate (u: 0 = one edge, 1 = the other) — the
    // shader erodes the straight geometric edges into ragged foam
    const uvArr = new Float32Array(maxVerts * 2)
    for (let i = 0; i < maxVerts; i++) {
      uvArr[i * 2] = i % 2
      uvArr[i * 2 + 1] = 0
    }
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2))
    this.geometry.setIndex(
      new THREE.BufferAttribute(new Uint16Array((MAX_POINTS - 1) * 18), 1),
    )

    // world-space lacy foam over the ribbons; vertex alpha carries the
    // per-parcel fade, filaments give the churn its structure
    const foam = makeFoamTexture()
    const material = new THREE.MeshBasicNodeMaterial()
    material.transparent = true
    material.depthWrite = false
    material.side = THREE.DoubleSide
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vcol = attribute('color', 'vec4') as any
    const drift = this.waveField.uTime.mul(0.05)
    const f = texture(
      foam,
      vec2(positionWorld.x, positionWorld.z).mul(0.16).add(drift),
    )
    const f2 = texture(
      foam,
      vec2(positionWorld.z, positionWorld.x).mul(0.043),
    )
    // ragged edges: push the across coordinate around with the foam
    // field, then fade both borders — no more ruler-straight silhouette
    const across = uv().x
    const ragged = across.add(f.r.sub(0.5).mul(0.6))
    const edge = smoothstep(float(0.0), float(0.3), ragged).mul(
      smoothstep(float(1.0), float(0.7), ragged),
    )
    // churn core: brightest, most opaque along the centerline
    const core = float(1).sub(across.sub(0.5).abs().mul(2))
    material.colorNode = vec3(vcol.x, vcol.y, vcol.z)
      .mul(f.r.mul(0.5).add(core.mul(0.22)).add(0.78))
    material.opacityNode = vcol.w
      .mul(edge)
      .mul(
        f.r.mul(0.85)
          .add(f.g.mul(f2.g).mul(0.5))
          .add(core.mul(0.3))
          .add(0.08),
      )
      .clamp(0, 1)

    this.mesh = new THREE.Mesh(this.geometry, material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 15
    scene.add(this.mesh)

    this.bowSpray = new SprayPool(scene, 420, 0.6, 0.55)
    this.rooster = new SprayPool(scene, 260, 1.25, 0.42)
    // skimming streaks: small fast droplets thrown flat across the water
    this.streaks = new SprayPool(scene, 520, 0.3, 0.5)

    // ---- transom boil: the churning prop wash right off the engine ----
    // two counter-scrolling foam samples multiplied = live bubbling; it
    // rides the (wake-displaced) surface just behind the stern
    const boilGeo = new THREE.CircleGeometry(1, 40)
    boilGeo.rotateX(-Math.PI / 2)
    const boilMat = new THREE.MeshBasicNodeMaterial()
    boilMat.transparent = true
    boilMat.depthWrite = false
    const bt = this.waveField.uTime
    const buv = vec2(positionWorld.x, positionWorld.z)
    const b1 = texture(foam, buv.mul(0.55).add(vec2(bt.mul(0.55), bt.mul(0.34))))
    const b2 = texture(foam, buv.mul(0.31).sub(vec2(bt.mul(0.42), bt.mul(-0.5))))
    const churn = b1.r.mul(1.4).add(b1.g.mul(0.5)).mul(b2.r.mul(1.2).add(0.35))
    const uBoil = uniform(0)
    this.boilOpacity = uBoil as unknown as { value: number }
    // radial falloff from the disc center via uv (CircleGeometry uv is 0..1)
    const rr = uv().sub(0.5).length().mul(2)
    const radial = smoothstep(float(1.0), float(0.25), rr)
    boilMat.colorNode = vec3(0.93, 0.985, 0.965).mul(churn.mul(0.5).add(0.75))
    boilMat.opacityNode = churn.clamp(0, 1.4).mul(radial).mul(uBoil)
    this.boil = new THREE.Mesh(boilGeo, boilMat)
    this.boil.renderOrder = 16
    this.boil.frustumCulled = false
    this.boil.visible = false
    scene.add(this.boil)
  }

  update(dt: number): void {
    const b = this.boat
    const speed = Math.abs(b.speed)

    for (const p of this.points) p.age += dt
    while (this.points.length && this.points[0].age > LIFE) this.points.shift()

    const dirX = Math.sin(b.heading)
    const dirZ = -Math.cos(b.heading)
    const sternX = b.x - dirX * 2.4
    const sternZ = b.z - dirZ * 2.4
    const moved = Math.hypot(sternX - this.lastX, sternZ - this.lastZ)
    if (speed > 1.6 && moved > DROP_DISTANCE) {
      this.lastX = sternX
      this.lastZ = sternZ
      this.points.push({ x: sternX, z: sternZ, dirX, dirZ, age: 0, speed })
      if (this.points.length > MAX_POINTS) this.points.shift()
    }

    // ---- REAL water displacement: drop wake-wave sources every ~5 m ----
    const srcMoved = Math.hypot(sternX - this.wakeSrcLastX, sternZ - this.wakeSrcLastZ)
    if (speed > 3 && srcMoved > 5) {
      this.wakeSrcLastX = sternX
      this.wakeSrcLastZ = sternZ
      this.waveField.pushWakeSource(
        sternX,
        sternZ,
        Math.min(0.22, 0.05 + speed * 0.004),
      )
    }

    // ---- transom boil: churning prop wash pinned behind the stern ----
    const boilTarget = speed > 4 ? Math.min(1, (speed - 4) / 14) : 0
    this.boilOpacity.value +=
      (boilTarget * 0.85 - this.boilOpacity.value) * Math.min(1, dt * 5)
    if (this.boilOpacity.value > 0.02) {
      const bx = b.x - dirX * 3.4
      const bz = b.z - dirZ * 3.4
      this.boil.visible = true
      this.boil.position.set(
        bx,
        this.waveField.heightAt(bx, bz, this.waveField.time) + 0.12,
        bz,
      )
      this.boil.scale.setScalar(1.6 + Math.min(1, speed / 24) * 1.5)
    } else {
      this.boil.visible = false
    }

    // ---------------------------------------------------- airborne water
    const px0 = -dirZ
    const pz0 = dirX
    if (speed > 7) {
      // bow spray fans — intensity ramps with speed
      const rate = Math.min(220, speed * 5.5)
      this.sprayCarry += rate * dt
      const bowX = b.x + dirX * 2.5
      const bowZ = b.z + dirZ * 2.5
      const wy = this.waveField.heightAt(bowX, bowZ, this.waveField.time)
      while (this.sprayCarry >= 1) {
        this.sprayCarry -= 1
        const side = this.sprayCarry % 2 < 1 ? 1 : -1
        const out = 1.6 + speed * 0.09
        this.bowSpray.emit(
          bowX + px0 * side * 0.8,
          wy + 0.35,
          bowZ + pz0 * side * 0.8,
          px0 * side * out + dirX * speed * 0.22,
          1.4 + speed * 0.075,
          pz0 * side * out + dirZ * speed * 0.22,
          1.5,
          0.75,
        )
      }
    }
    if (speed > 24) {
      // rooster tail — the planing plume behind the stern
      const rate = Math.min(120, (speed - 24) * 6)
      this.roosterCarry += rate * dt
      const wy = this.waveField.heightAt(sternX, sternZ, this.waveField.time)
      while (this.roosterCarry >= 1) {
        this.roosterCarry -= 1
        this.rooster.emit(
          sternX - dirX * 1.2,
          wy + 0.15,
          sternZ - dirZ * 1.2,
          -dirX * (2.5 + speed * 0.1),
          3.6 + speed * 0.09,
          -dirZ * (2.5 + speed * 0.1),
          2.2,
          0.95,
        )
      }
    }
    if (speed > 6) {
      // flat skimming streaks off the hull sides — the white slashes a
      // planing hull rips across the surface
      const rate = Math.min(320, speed * 7)
      this.streakCarry += rate * dt
      const wy2 = this.waveField.heightAt(b.x, b.z, this.waveField.time)
      while (this.streakCarry >= 1) {
        this.streakCarry -= 1
        const side = this.streakCarry % 2 < 1 ? 1 : -1
        const back = 0.5 + (this.streakCarry % 5) * 0.55
        this.streaks.emit(
          b.x - dirX * back + px0 * side * 1.05,
          wy2 + 0.12,
          b.z - dirZ * back + pz0 * side * 1.05,
          px0 * side * (2.8 + speed * 0.16) - dirX * speed * 0.1,
          0.6,
          pz0 * side * (2.8 + speed * 0.16) - dirZ * speed * 0.1,
          1.8,
          0.4,
        )
      }
    }
    this.bowSpray.update(dt)
    this.rooster.update(dt)
    this.streaks.update(dt)

    // ------------------------------------------------------ foam ribbons
    const pos = this.geometry.attributes.position as THREE.BufferAttribute
    const col = this.geometry.attributes.color as THREE.BufferAttribute
    const idx = this.geometry.index as THREE.BufferAttribute
    const n = this.points.length
    const t = this.waveField.time
    const A = MAX_POINTS // vertex-block offsets: wash 0, port A*2, star A*4

    for (let i = 0; i < n; i++) {
      const p = this.points[i]
      const px = -p.dirZ
      const pz = p.dirX
      const y = this.waveField.heightAt(p.x, p.z, t) + 0.1
      const spdN = Math.min(1, p.speed / 24) // 0..1 across the speed range
      const fade = Math.max(0, 1 - p.age / LIFE)

      // ---- turbulent stern wash: churn width grows fast then relaxes ----
      // born at hull width (the prop wash), spreading as the water churns
      const growth = 1 - Math.exp(-p.age * (0.55 + spdN * 0.5))
      const washW = (0.85 + spdN * 0.4) + growth * (2.2 + p.speed * 0.34)
      // brightness: violent white at planing, gentle at trolling; the
      // youngest water is the whitest (fresh churn), dissolving outward
      const washA =
        Math.pow(fade, 1.35) * (0.12 + spdN * 0.72) * (0.45 + 0.55 * Math.exp(-p.age * 0.8))
      pos.setXYZ(i * 2, p.x - px * washW, y, p.z - pz * washW)
      pos.setXYZ(i * 2 + 1, p.x + px * washW, y + 0.02, p.z + pz * washW)
      // edges dissolve first — center stays churned
      col.setXYZW(i * 2, 0.90, 0.96, 0.94, washA * 0.55)
      col.setXYZW(i * 2 + 1, 0.90, 0.96, 0.94, washA * 0.55)
      // (center brightness is carried by the foam filaments in the shader)

      // ---- Kelvin arms: crisp lines propagating at 19.5° wave speed ----
      const armDist = 1.2 + p.age * p.speed * KELVIN_SIN
      const armW = 0.32 + p.age * 0.15 + spdN * 0.2
      const armA = Math.pow(fade, 2.1) * (0.05 + spdN * 0.42)
      const armY = this.waveField.heightAt(p.x - px * armDist, p.z - pz * armDist, t) + 0.09
      pos.setXYZ(A * 2 + i * 2, p.x - px * (armDist + armW), armY, p.z - pz * (armDist + armW))
      pos.setXYZ(A * 2 + i * 2 + 1, p.x - px * (armDist - armW), armY, p.z - pz * (armDist - armW))
      col.setXYZW(A * 2 + i * 2, 0.95, 0.99, 0.97, armA * 0.35)
      col.setXYZW(A * 2 + i * 2 + 1, 0.95, 0.99, 0.97, armA)
      const armY2 = this.waveField.heightAt(p.x + px * armDist, p.z + pz * armDist, t) + 0.09
      pos.setXYZ(A * 4 + i * 2, p.x + px * (armDist - armW), armY2, p.z + pz * (armDist - armW))
      pos.setXYZ(A * 4 + i * 2 + 1, p.x + px * (armDist + armW), armY2, p.z + pz * (armDist + armW))
      col.setXYZW(A * 4 + i * 2, 0.95, 0.99, 0.97, armA)
      col.setXYZW(A * 4 + i * 2 + 1, 0.95, 0.99, 0.97, armA * 0.35)
    }

    let ii = 0
    const strip = (base: number) => {
      for (let i = 0; i < Math.max(0, n - 1); i++) {
        const a = base + i * 2
        idx.setX(ii++, a)
        idx.setX(ii++, a + 1)
        idx.setX(ii++, a + 3)
        idx.setX(ii++, a)
        idx.setX(ii++, a + 3)
        idx.setX(ii++, a + 2)
      }
    }
    strip(0)
    strip(A * 2)
    strip(A * 4)
    this.geometry.setDrawRange(0, ii)
    pos.needsUpdate = true
    col.needsUpdate = true
    idx.needsUpdate = true
    this.mesh.visible = n > 1
  }
}
