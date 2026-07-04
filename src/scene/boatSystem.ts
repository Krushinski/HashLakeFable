import * as THREE from 'three/webgpu'
import { Fn, positionLocal, sin, uniform } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import type { WaveField } from './waveField'
import { shoreSdf } from './lakeMap'

/**
 * The hero runabout + Drive Mode physics (§6.2).
 *
 * The heading is the single source of truth: input steers the heading,
 * the hull follows it, the camera follows the hull. Pitch/roll/heave come
 * from multi-point sampling of the SAME analytic wave field the GPU
 * renders — the boat rides the actual water, storm coupling included,
 * with zero readback.
 */

const MPH = 0.44704
const SPEED_CRUISE = 52 * MPH
const SPEED_BOOST = 100 * MPH
const SPEED_SUPER = 120 * MPH
const SPEED_REVERSE = -8 * MPH

export interface DriveInput {
  forward: boolean
  backward: boolean
  left: boolean
  right: boolean
  boost: boolean
  superBoost: boolean
  anchor: boolean
}

export interface DriveCameraPreset {
  name: string
  back: number
  up: number
  lookAhead: number
  lookUp: number
}

export const DRIVE_PRESETS: DriveCameraPreset[] = [
  { name: 'Chase', back: 12.5, up: 4.4, lookAhead: 10, lookUp: 1.2 },
  { name: 'Low Chase', back: 9, up: 2.1, lookAhead: 14, lookUp: 1.6 },
  { name: 'High Map', back: 24, up: 30, lookAhead: 4, lookUp: 0 },
  { name: 'OJ Mode', back: 19, up: 6.5, lookAhead: 8, lookUp: 1 },
  { name: 'Vice City', back: 7.5, up: 3.2, lookAhead: 18, lookUp: 2.2 },
]

export class BoatSystem {
  readonly group = new THREE.Group()

  // physics state — heading is the source of truth
  x = 40
  z = 420
  heading = 0 // 0 = facing north (-z), toward the hero range
  speed = 0

  private pitch = 0
  private roll = 0
  private heave = 0
  private bowLift = 0
  private presetIndex = 0

  private readonly uFlagWind = uniform(1)
  private ready = false

  constructor(
    scene: THREE.Scene,
    private readonly waveField: WaveField,
  ) {
    scene.add(this.group)
  }

  async load(): Promise<void> {
    const base = import.meta.env.BASE_URL
    const draco = new DRACOLoader()
    draco.setDecoderPath(`${base}assets/draco/`)
    const loader = new GLTFLoader()
    loader.setDRACOLoader(draco)
    const v = import.meta.env.DEV ? Date.now().toString(36) : __BUILD_COMMIT__
    const gltf = await loader.loadAsync(`${base}assets/models/hl-boat.glb?v=${v}`)

    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial
        if (std.transparent) std.depthWrite = false
        // hull loft normals aren't guaranteed outward — render both faces
        std.side = THREE.DoubleSide
      }
      if (mesh.name.includes('Flag') || o.parent?.name.includes('Flag')) {
        this.riggedFlag(mesh)
      }
    })

    // face -z when heading = π (glTF -z forward after y-up export; our hull
    // was authored bow toward -x → rotate so bow follows heading)
    gltf.scene.rotation.y = Math.PI / 2
    const holder = new THREE.Group()
    holder.add(gltf.scene)
    this.group.add(holder)
    this.ready = true
  }

  /** Flag cloth sway — distance-weighted sine ripple, wind/speed driven. */
  private riggedFlag(mesh: THREE.Mesh): void {
    const mat = mesh.material as THREE.MeshStandardNodeMaterial
    const t = this.waveField.uTime
    const wind = this.uFlagWind
    mat.positionNode = Fn(() => {
      const p = positionLocal.toVar()
      // authored: staff at x≈2.6..2.7, flag extends +x, waves in z
      const along = positionLocal.x.sub(2.62).max(0)
      const phase = along.mul(9).sub(t.mul(7))
      const amp = along.mul(0.16).mul(wind)
      p.z.addAssign(sin(phase).mul(amp))
      p.y.addAssign(sin(phase.mul(0.7)).mul(amp).mul(0.3))
      return p
    })()
    mat.side = THREE.DoubleSide
  }

  cyclePreset(): string {
    this.presetIndex = (this.presetIndex + 1) % DRIVE_PRESETS.length
    return DRIVE_PRESETS[this.presetIndex].name
  }

  get presetName(): string {
    return DRIVE_PRESETS[this.presetIndex].name
  }

  get speedMph(): number {
    return Math.abs(this.speed) / MPH
  }

  get position(): THREE.Vector3 {
    return this.group.position
  }

  update(dt: number, input: DriveInput | null): void {
    if (!this.ready) return

    // ------------------------------------------------------ longitudinal
    const boosting =
      !!input && input.forward && (input.boost || input.superBoost)
    if (input) {
      let target = 0
      let accel = 0
      if (input.forward) {
        target = input.superBoost
          ? SPEED_SUPER
          : input.boost
            ? SPEED_BOOST
            : SPEED_CRUISE
        accel = boosting ? 9.5 : 5.5
        if (this.speed < target) {
          this.speed = Math.min(target, this.speed + accel * dt)
        } else {
          // released boost: settle down through drag
          this.speed += (target - this.speed) * Math.min(1, dt * 0.8)
        }
      } else if (input.backward) {
        if (this.speed > 0.6) {
          this.speed = Math.max(0, this.speed - 13 * dt) // brake first
        } else {
          this.speed = Math.max(SPEED_REVERSE, this.speed - 2.2 * dt)
        }
      }
      if (input.anchor) {
        this.speed *= Math.exp(-3.2 * dt)
        if (Math.abs(this.speed) < 0.3) this.speed = 0
      }
      if (!input.forward && !input.backward && !input.anchor) {
        // strong natural water braking — reverse rarely needed (§6.2.2)
        this.speed *= Math.exp(-0.42 * dt)
        if (Math.abs(this.speed) < 0.15) this.speed = 0
      }

      // -------------------------------------------------------- steering
      const steer = (input.left ? 1 : 0) - (input.right ? 1 : 0)
      if (steer !== 0 && Math.abs(this.speed) > 0.4) {
        const spd = Math.abs(this.speed)
        // responsive at low speed, wide smooth arcs at high speed
        const rate = 1.05 / (1 + spd * 0.055)
        const dir = this.speed >= 0 ? 1 : -1
        this.heading += steer * rate * dt * dir
        // bank into the turn
        this.roll += (steer * Math.min(spd * 0.010, 0.16) - this.roll) *
          Math.min(1, dt * 3)
      }
    } else {
      // frame mode: drift to rest
      this.speed *= Math.exp(-0.8 * dt)
    }

    // ---------------------------------------------------------- movement
    const dirX = Math.sin(this.heading)
    const dirZ = -Math.cos(this.heading) // heading 0 = north (-z)... π = south
    let nx = this.x + dirX * this.speed * dt
    let nz = this.z + dirZ * this.speed * dt

    // ------------------------------------------------------- boundaries
    const look = 10 + Math.abs(this.speed) * 0.7
    const aheadSdf = shoreSdf(nx + dirX * look, nz + dirZ * look)
    if (aheadSdf > -14) {
      // approaching shore: bleed speed smoothly
      const closeness = Math.min(1, (aheadSdf + 14) / 26)
      this.speed *= Math.exp(-closeness * 3.4 * dt)
    }
    const hereSdf = shoreSdf(nx, nz)
    if (hereSdf > -5) {
      // gently push back toward open water via the SDF gradient
      const e = 2
      const gx = shoreSdf(nx + e, nz) - shoreSdf(nx - e, nz)
      const gz = shoreSdf(nx, nz + e) - shoreSdf(nx, nz - e)
      const glen = Math.hypot(gx, gz) || 1
      nx -= (gx / glen) * (hereSdf + 5) * 0.5
      nz -= (gz / glen) * (hereSdf + 5) * 0.5
      this.speed *= Math.exp(-2.5 * dt)
    }
    this.x = nx
    this.z = nz

    // ------------------------------------------------------- buoyancy
    const t = this.waveField.time
    const bowP = { x: this.x + dirX * 2.1, z: this.z + dirZ * 2.1 }
    const sternP = { x: this.x - dirX * 2.1, z: this.z - dirZ * 2.1 }
    const rightX = -dirZ
    const rightZ = dirX
    const portP = { x: this.x - rightX * 0.8, z: this.z - rightZ * 0.8 }
    const starP = { x: this.x + rightX * 0.8, z: this.z + rightZ * 0.8 }

    const hBow = this.waveField.heightAt(bowP.x, bowP.z, t)
    const hStern = this.waveField.heightAt(sternP.x, sternP.z, t)
    const hPort = this.waveField.heightAt(portP.x, portP.z, t)
    const hStar = this.waveField.heightAt(starP.x, starP.z, t)

    const targetHeave = (hBow + hStern + hPort + hStar) / 4
    const targetPitch = Math.atan2(hStern - hBow, 4.2)
    const targetRollWave = Math.atan2(hPort - hStar, 1.6)

    // planing bow lift on boost (§6.2.2 boost feel)
    const liftTarget = boosting && this.speed > 12 ? 0.115 : this.speed > 18 ? 0.045 : 0
    this.bowLift += (liftTarget - this.bowLift) * Math.min(1, dt * 1.8)

    const k = Math.min(1, dt * 6)
    this.heave += (targetHeave - this.heave) * k
    this.pitch += (targetPitch - this.pitch) * k
    const waveRollBlend = this.roll * 0.7 + targetRollWave * 0.65
    this.roll += (waveRollBlend - this.roll) * Math.min(1, dt * 4)

    // ---------------------------------------------------------- pose
    this.group.position.set(this.x, this.heave + 0.06 - (boosting ? 0.09 : 0), this.z)
    this.group.rotation.set(0, 0, 0)
    this.group.rotateY(-this.heading + Math.PI)
    this.group.rotateX(this.pitch - this.bowLift)
    this.group.rotateZ(this.roll)

    // flag wind: base breeze + speed
    this.uFlagWind.value = 0.6 + Math.min(2.2, Math.abs(this.speed) * 0.06) +
      this.waveField.params.chopScale * 0.4

    void input
  }

  /** Hard-locked drive camera pose for the active preset. */
  driveCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    const p = DRIVE_PRESETS[this.presetIndex]
    const dirX = Math.sin(this.heading)
    const dirZ = -Math.cos(this.heading)
    const targetPos = new THREE.Vector3(
      this.x - dirX * p.back,
      this.heave + p.up,
      this.z - dirZ * p.back,
    )
    const blend = 1 - Math.exp(-dt * 5.5)
    camera.position.lerp(targetPos, blend)
    camera.lookAt(
      this.x + dirX * p.lookAhead,
      this.heave + p.lookUp,
      this.z + dirZ * p.lookAhead,
    )
  }
}
