import * as THREE from 'three/webgpu'
import { bus } from '../state/eventBus'
import { isInLake, shoreSdf } from './lakeMap'
import type { WaveField } from './waveField'
import type { BoatSystem } from './boatSystem'
import { seededRandom } from '../core/noise'

/**
 * Event effects (§16): whale splashes with expanding land-aware rings and
 * a rising spray crown; block pulses as a sharp teal ring from beneath the
 * boat plus a gentle hull hop. All pooled, all bounded, never global.
 */

const RING_POOL = 10
const SPLASH_POOL = 4
const SPRAY_COUNT = 90

interface Ring {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  age: number
  life: number
  maxRadius: number
  speed: number
  active: boolean
  kind: 'whale' | 'block'
}

interface Splash {
  points: THREE.Points
  mat: THREE.PointsMaterial
  vel: Float32Array
  age: number
  life: number
  active: boolean
  scale: number
  origin: THREE.Vector3
}

export class EffectsSystem {
  private rings: Ring[] = []
  private splashes: Splash[] = []
  private rand = seededRandom(31337)

  constructor(
    scene: THREE.Scene,
    private readonly waveField: WaveField,
    private readonly boat: BoatSystem,
  ) {
    // ring pool — flat annulus, additive, fades out
    for (let i = 0; i < RING_POOL; i++) {
      const geo = new THREE.RingGeometry(0.92, 1.0, 64)
      geo.rotateX(-Math.PI / 2)
      const mat = new THREE.MeshBasicMaterial({
        color: 0xbfeee8,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.visible = false
      mesh.renderOrder = 20
      scene.add(mesh)
      this.rings.push({
        mesh,
        mat,
        age: 0,
        life: 0,
        maxRadius: 10,
        speed: 8,
        active: false,
        kind: 'whale',
      })
    }

    // splash pool — point sprays
    for (let i = 0; i < SPLASH_POOL; i++) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(SPRAY_COUNT * 3), 3),
      )
      const mat = new THREE.PointsMaterial({
        color: 0xe8f6f2,
        size: 0.55,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
      const points = new THREE.Points(geo, mat)
      points.visible = false
      points.renderOrder = 21
      points.frustumCulled = false
      scene.add(points)
      this.splashes.push({
        points,
        mat,
        vel: new Float32Array(SPRAY_COUNT * 3),
        age: 0,
        life: 0,
        active: false,
        scale: 1,
        origin: new THREE.Vector3(),
      })
    }

    bus.on('whale', ({ btc }) => this.whaleSplash(btc))
    bus.on('newBlock', () => this.blockPulse())
  }

  /** §15.4 scaling: clamp(log10(btc)/1.2, 0.6, 2.6). */
  private whaleSplash(btc: number): void {
    const scale = Math.min(2.6, Math.max(0.6, Math.log10(btc) / 1.2))

    // spawn somewhere on open water within view-ish of the boat
    let x = 0
    let z = 0
    for (let tries = 0; tries < 12; tries++) {
      const ang = this.rand() * Math.PI * 2
      const dist = 60 + this.rand() * 200
      x = this.boat.x + Math.sin(ang) * dist
      z = this.boat.z + Math.cos(ang) * dist
      if (isInLake(x, z) && shoreSdf(x, z) < -30) break
    }

    const y = this.waveField.heightAt(x, z)

    // rings: count scales with size
    const ringCount = Math.round(2 + scale * 1.4)
    for (let i = 0; i < ringCount; i++) {
      this.fireRing(x, y, z, {
        kind: 'whale',
        delay: i * 0.5,
        maxRadius: (26 + scale * 34) * (1 - i * 0.16),
        speed: 10 + scale * 5,
        life: 2.8 + scale,
      })
    }

    // spray crown
    const splash = this.splashes.find((s) => !s.active)
    if (splash) {
      const pos = splash.points.geometry.attributes
        .position as THREE.BufferAttribute
      for (let i = 0; i < SPRAY_COUNT; i++) {
        pos.setXYZ(i, 0, 0, 0)
        const ang = this.rand() * Math.PI * 2
        const r = this.rand()
        splash.vel[i * 3] = Math.sin(ang) * r * 3.2 * scale
        splash.vel[i * 3 + 1] = (4 + this.rand() * 6.5) * scale
        splash.vel[i * 3 + 2] = Math.cos(ang) * r * 3.2 * scale
      }
      pos.needsUpdate = true
      splash.origin.set(x, y, z)
      splash.points.position.copy(splash.origin)
      splash.age = 0
      splash.life = 1.6 + scale * 0.5
      splash.scale = scale
      splash.active = true
      splash.points.visible = true
      splash.mat.opacity = 0.95
      splash.mat.size = 0.4 + scale * 0.3
    }
  }

  /** §15.5/16.2: sharp teal pulse ring from directly beneath the boat. */
  private blockPulse(): void {
    const y = this.waveField.heightAt(this.boat.x, this.boat.z)
    this.fireRing(this.boat.x, y, this.boat.z, {
      kind: 'block',
      delay: 0,
      maxRadius: 320,
      speed: 90,
      life: 3.6,
    })
    this.fireRing(this.boat.x, y, this.boat.z, {
      kind: 'block',
      delay: 0.25,
      maxRadius: 220,
      speed: 70,
      life: 3.0,
    })
    this.boat.hop()
  }

  private fireRing(
    x: number,
    y: number,
    z: number,
    opts: {
      kind: 'whale' | 'block'
      delay: number
      maxRadius: number
      speed: number
      life: number
    },
  ): void {
    const ring = this.rings.find((r) => !r.active)
    if (!ring) return
    // land-aware cap: rings dissipate at the shore (§16.1)
    const shoreDist = -shoreSdf(x, z)
    const maxR = Math.min(opts.maxRadius, Math.max(14, shoreDist))
    ring.mesh.position.set(x, y + 0.25, z)
    ring.age = -opts.delay
    ring.life = opts.life
    ring.maxRadius = maxR
    ring.speed = opts.speed
    ring.kind = opts.kind
    ring.active = true
    ring.mat.color.setHex(opts.kind === 'block' ? 0x53e0d2 : 0xcfeee9)
  }

  update(dt: number): void {
    for (const r of this.rings) {
      if (!r.active) continue
      r.age += dt
      if (r.age < 0) continue
      const radius = Math.min(r.maxRadius, r.age * r.speed)
      const lifeT = r.age / r.life
      if (lifeT >= 1 || radius >= r.maxRadius) {
        r.active = false
        r.mesh.visible = false
        continue
      }
      r.mesh.visible = true
      r.mesh.scale.setScalar(Math.max(radius, 0.01))
      // leading ring reads clearly, then dissolves
      r.mat.opacity = (1 - lifeT) * (r.kind === 'block' ? 0.85 : 0.6)
      // ride the waves
      r.mesh.position.y =
        this.waveField.heightAt(r.mesh.position.x, r.mesh.position.z) + 0.25
    }

    for (const s of this.splashes) {
      if (!s.active) continue
      s.age += dt
      const lifeT = s.age / s.life
      if (lifeT >= 1) {
        s.active = false
        s.points.visible = false
        continue
      }
      const pos = s.points.geometry.attributes
        .position as THREE.BufferAttribute
      for (let i = 0; i < SPRAY_COUNT; i++) {
        s.vel[i * 3 + 1] -= 9.8 * dt // gravity
        pos.setXYZ(
          i,
          pos.getX(i) + s.vel[i * 3] * dt,
          Math.max(pos.getY(i) + s.vel[i * 3 + 1] * dt, -0.5),
          pos.getZ(i) + s.vel[i * 3 + 2] * dt,
        )
      }
      pos.needsUpdate = true
      s.mat.opacity = 0.95 * (1 - lifeT * lifeT)
    }
  }
}
