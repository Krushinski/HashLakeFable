import * as THREE from 'three/webgpu'
import { Fn, positionLocal, sin, uniform } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import type { WaveField } from './waveField'
import { LAKE_SCALE, shoreSdf, waterDepth } from './lakeMap'

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
const SPEED_ULTRA = 150 * MPH
const SPEED_REVERSE = -8 * MPH

export interface DriveInput {
  forward: boolean
  backward: boolean
  left: boolean
  right: boolean
  boost: boolean
  superBoost: boolean
  ultraBoost: boolean
  anchor: boolean
}

/** Deep-red flag with a white bitcoin mark, drawn once on a canvas. */
function makeFlagTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#8a1016'
  g.fillRect(0, 0, 256, 128)
  g.fillStyle = '#f4efe8'
  // Traditional bitcoin B (§user: the B from the orange logo, sans the
  // orange): heavy sans glyph + two vertical strokes protruding through
  // top and bottom. Drawn manually — U+20BF is tofu on stock Android
  // fonts and would bake permanently into the texture. Stub geometry
  // (final swarm, Arial metrics): bars sink ~8 px INTO the cap/base
  // strokes so they connect under any sans fallback, and never cross
  // the B's counters (no white stripes in the red holes).
  g.font = '900 96px "Arial Black", Arial, Helvetica, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('B', 128, 64)
  g.fillRect(112, 12, 10, 25)
  g.fillRect(133, 12, 10, 25)
  g.fillRect(112, 88, 10, 26)
  g.fillRect(133, 88, 10, 26)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
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
  // Sky Chase: a FORWARD-LOOKING High Map — top-down altitude, view
  // shifted ahead so you can read the water coming at you (§user v2:
  // was too close to OJ)
  { name: 'Sky Chase', back: 20, up: 38, lookAhead: 20, lookUp: 0 },
  // OJ: helicopter tracking shot — boat ~86% down frame, horizon high
  // (framing solved against the Codex reference screenshots)
  { name: 'OJ Mode', back: 44, up: 26, lookAhead: 28, lookUp: 8 },
  // Vice: full aerial — boat small at the bottom, the world in frame
  // (old lookAhead 240 pitched the view so far out the boat left the FOV)
  { name: 'Vice City', back: 88, up: 54, lookAhead: 150, lookUp: 6 },
]

export class BoatSystem {
  readonly group = new THREE.Group()

  // physics state — heading is the source of truth
  x = 40 * LAKE_SCALE
  z = 420 * LAKE_SCALE
  heading = 0 // 0 = facing north (-z), toward the hero range
  speed = 0

  /** When Water Pro drives buoyancy, its proxy height lands here and
   *  overrides the legacy Gerstner heave (pitch/roll stay approximate). */
  externalHeave: number | null = null

  private pitch = 0
  private roll = 0
  private heave = 0
  private bowLift = 0
  private presetIndex = 0
  private hopEnergy = 0

  private readonly uFlagWind = uniform(1)
  /** Prop assembly (PropHub/PropBlade*): reparented at load into ONE
   *  group centered on the hub, spun about the resolved shaft axis.
   *  Spinning meshes individually made each blade orbit its own pivot —
   *  the "ceiling fan" (§user, twice). */
  private readonly propParts: THREE.Mesh[] = []
  /** Static running gear (shaft/rudder/exhausts) — shrunk toward the
   *  hull line at load so it reads as machinery, not a kitchen fork. */
  private readonly gearMeshes: THREE.Mesh[] = []
  /** The flag staff — stretched down into the deck at load. */
  private gearStaff: THREE.Mesh | null = null
  private propGroup: THREE.Group | null = null
  private readonly propAxis = new THREE.Vector3(1, 0, 0)
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
      if (mesh.name.includes('Scarf')) {
        this.riggedScarf(mesh)
      }
      // the running gear spins with throttle (§user) — blades + hub only;
      // the shaft is visually static and the rudder steers, not spins
      if (mesh.name.startsWith('PropBlade') || mesh.name === 'PropHub') {
        this.propParts.push(mesh)
      }
      if (
        ['PropShaft', 'Rudder', 'ExhaustTipP', 'ExhaustTipS'].includes(
          mesh.name,
        )
      ) {
        this.gearMeshes.push(mesh)
      }
      if (mesh.name === 'SternStaff') this.gearStaff = mesh
    })

    // face -z when heading = π (glTF -z forward after y-up export; our hull
    // was authored bow toward -x → rotate so bow follows heading)
    gltf.scene.rotation.y = Math.PI / 2
    const holder = new THREE.Group()
    holder.add(gltf.scene)
    this.group.add(holder)

    // Prop rig: ONE group centered on the hub — blades attach with their
    // world transforms preserved, so the whole assembly revolves around
    // the shaft center like a real prop (spinning meshes individually
    // orbited each blade's own pivot: the ceiling fan). The shaft axis
    // is the hull's world longitudinal direction at this instant,
    // expressed in the group's local frame.
    this.group.updateMatrixWorld(true)
    if (this.propParts.length) {
      const hub =
        this.propParts.find((m) => m.name === 'PropHub') ?? this.propParts[0]
      const hubPos = hub.getWorldPosition(new THREE.Vector3())
      const pg = new THREE.Group()
      const parent = hub.parent as THREE.Object3D
      parent.add(pg)
      pg.position.copy(parent.worldToLocal(hubPos.clone()))
      pg.updateMatrixWorld(true)
      for (const m of this.propParts) pg.attach(m)
      const worldShaft = new THREE.Vector3(
        Math.sin(this.heading),
        0,
        -Math.cos(this.heading),
      )
      const q = pg.getWorldQuaternion(new THREE.Quaternion()).invert()
      this.propAxis.copy(worldShaft).applyQuaternion(q).normalize()
      this.propGroup = pg

      // PROP DIGNITY (§user: "laughing stock"): shrink the assembly 30%
      // about the hub and tuck it 0.28 m forward / 0.1 m up toward the
      // hull shadow. Safe: rotateOnAxis only touches the quaternion, so
      // scale/position never fight the spin; pg's quaternion is still
      // identity here, so the resolved axes are exact.
      pg.scale.setScalar(0.7)
      const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize()
      // right up against the hull bottom (§user round 2: "bring the
      // propeller up to the boat") — the shaft it used to hang from is
      // hidden below
      pg.translateOnAxis(this.propAxis, 0.45)
      pg.translateOnAxis(localUp, 0.3)
    }

    // static gear: the dinky shaft stick is RETIRED outright (§user);
    // rudder/exhausts shrink toward their TOP edges so they hug the
    // hull line — same proven attach() math as the prop rig
    for (const m of this.gearMeshes) {
      if (m.name === 'PropShaft') {
        m.visible = false
        continue
      }
      const bb = new THREE.Box3().setFromObject(m)
      const pivotW = bb.getCenter(new THREE.Vector3())
      pivotW.y = bb.max.y
      const g2 = new THREE.Group()
      const par = m.parent as THREE.Object3D
      par.add(g2)
      g2.position.copy(par.worldToLocal(pivotW.clone()))
      g2.updateMatrixWorld(true)
      g2.attach(m)
      g2.scale.setScalar(m.name === 'Rudder' ? 0.75 : 0.8)
    }

    // flagpole planted IN the deck (§user: "connect the darn flagpole"):
    // stretch the staff downward about its TOP so the base sinks into
    // the transom while the tip and the cloth stay exactly where they
    // were (the Flag mesh is separate — its TSL sway is untouched)
    const staff = this.gearStaff
    if (staff) {
      const bb = new THREE.Box3().setFromObject(staff)
      const pivotW = bb.getCenter(new THREE.Vector3())
      pivotW.y = bb.max.y
      const g3 = new THREE.Group()
      const par = staff.parent as THREE.Object3D
      par.add(g3)
      g3.position.copy(par.worldToLocal(pivotW.clone()))
      g3.updateMatrixWorld(true)
      g3.attach(staff)
      g3.scale.set(1, 1.3, 1)
    }
    this.ready = true
  }

  /** Flag cloth sway — distance-weighted sine ripple, wind/speed driven. */
  private riggedFlag(mesh: THREE.Mesh): void {
    const mat = mesh.material as THREE.MeshStandardNodeMaterial
    // white ₿ on the deep red field (canvas texture, zero assets)
    mat.map = makeFlagTexture()
    mat.color.set(0xffffff)
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

  /** Satoshi's scarf tail — streams aft, driven by the same wind uniform. */
  private riggedScarf(mesh: THREE.Mesh): void {
    const mat = mesh.material as THREE.MeshStandardNodeMaterial
    const t = this.waveField.uTime
    const wind = this.uFlagWind
    mat.positionNode = Fn(() => {
      const p = positionLocal.toVar()
      // tail anchored at the neck (authored from x≈1.0, trailing +x)
      const along = positionLocal.x.sub(1.0).max(0)
      const phase = along.mul(7).sub(t.mul(6))
      const amp = along.mul(0.13).mul(wind)
      p.z.addAssign(sin(phase).mul(amp))
      p.y.addAssign(sin(phase.mul(0.8).add(1.2)).mul(amp).mul(0.45))
      return p
    })()
    mat.side = THREE.DoubleSide
  }

  /** Brief §15.5 — a new block makes the boat lurch/hop briefly. */
  hop(): void {
    this.hopEnergy = 1
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
        target =
          input.ultraBoost && input.boost
            ? SPEED_ULTRA
            : input.superBoost
              ? SPEED_SUPER
              : input.boost
                ? SPEED_BOOST
                : SPEED_CRUISE
        accel = boosting ? (input.ultraBoost ? 11.5 : 9.5) : 5.5
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
        // left arrow turns the BOW left (heading decreases in our compass)
        this.heading -= steer * rate * dt * dir
        // bank into the turn
        this.roll += (-steer * Math.min(spd * 0.010, 0.16) - this.roll) *
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
    // RELAXED for the 0.75x world (§user: "stuck between the island and
    // land channel... allow more land climbing, just not crazy"): the
    // braking radii are absolute meters, but the channels shrank with
    // the world — the old 14 m bubble touched BOTH shores of the island
    // back-channel at once and pinned the throttle. Tighter bubble,
    // gentler bleed, land still ends the run.
    const look = 6 + Math.abs(this.speed) * 0.45
    const aheadSdf = shoreSdf(nx + dirX * look, nz + dirZ * look)
    if (aheadSdf > -5) {
      // approaching shore: bleed speed smoothly
      const closeness = Math.min(1, (aheadSdf + 5) / 12)
      this.speed *= Math.exp(-closeness * 2.2 * dt)
    }
    const hereSdf = shoreSdf(nx, nz)
    // push-back only INSIDE the land line (§user round 2: couldn't come
    // alongside the dock — the old water-side shove kept 1.5-3 m of
    // standoff at every shore)
    if (hereSdf > -1.5) {
      const e = 2
      const gx = shoreSdf(nx + e, nz) - shoreSdf(nx - e, nz)
      const gz = shoreSdf(nx, nz + e) - shoreSdf(nx, nz - e)
      const glen = Math.hypot(gx, gz) || 1
      nx -= (gx / glen) * (hereSdf + 1.5) * 0.4
      nz -= (gz / glen) * (hereSdf + 1.5) * 0.4
      this.speed *= Math.exp(-1.8 * dt)
    }

    // ------------------------------------------- shallow-water grounding
    // The island and sandbar are bed bumps invisible to shoreSdf — the
    // hull runs aground on DEPTH, same field the water renders as sand,
    // so the boat stops exactly where the shallows visually begin.
    const DRAFT = 0.7
    const depthAhead = waterDepth(nx + dirX * look, nz + dirZ * look)
    if (depthAhead < DRAFT + 1.0) {
      const closeness = 1 - Math.max(0, depthAhead - DRAFT) / 1.0
      this.speed *= Math.exp(-closeness * 2.8 * dt)
    }
    const depthHere = waterDepth(nx, nz)
    if (depthHere < DRAFT + 0.15) {
      // push toward deeper water along the depth gradient
      const e = 2.5
      const gx = waterDepth(nx + e, nz) - waterDepth(nx - e, nz)
      const gz = waterDepth(nx, nz + e) - waterDepth(nx, nz - e)
      const glen = Math.hypot(gx, gz) || 1
      const shove = Math.min(2.2, (DRAFT + 0.15 - depthHere) * 3)
      nx += (gx / glen) * shove
      nz += (gz / glen) * shove
      this.speed *= Math.exp(-3.2 * dt)
    }

    // Hard beaching cap (§user): the bow may nose a couple of metres
    // into the sand — enough to beach deliberately — but land ends
    // forward progress there. Without this, throttle vs. the decay
    // above settles into an endless ~3 mph crawl that once carried the
    // hull 40 m inland. Reverse stays free so a beached boat refloats.
    // 6.5 m of deliberate bow-in-the-sand (§user round 2: dock parking
    // + walk-the-beach closeness); reverse still refloats
    const BEACH_LIMIT_SDF = 6.5
    const BEACH_DEPTH = 0.12
    if (
      this.speed > 0 &&
      (hereSdf > BEACH_LIMIT_SDF || depthHere < BEACH_DEPTH)
    ) {
      this.speed = 0
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
    const heaveTarget = this.externalHeave ?? targetHeave
    this.heave += (heaveTarget - this.heave) * k
    this.pitch += (targetPitch - this.pitch) * k
    const waveRollBlend = this.roll * 0.7 + targetRollWave * 0.65
    this.roll += (waveRollBlend - this.roll) * Math.min(1, dt * 4)

    // block-pulse hop: quick lift, springy settle
    let hopY = 0
    if (this.hopEnergy > 0) {
      this.hopEnergy = Math.max(0, this.hopEnergy - dt * 1.4)
      hopY = Math.sin((1 - this.hopEnergy) * Math.PI) * 0.34 * this.hopEnergy
    }

    // ---------------------------------------------------------- pose
    this.group.position.set(
      this.x,
      this.heave + hopY + 0.06 - (boosting ? 0.09 : 0),
      this.z,
    )
    this.group.rotation.set(0, 0, 0)
    this.group.rotateY(-this.heading + Math.PI)
    this.group.rotateX(this.pitch - this.bowLift)
    this.group.rotateZ(this.roll)

    // flag wind: base breeze + speed
    this.uFlagWind.value = 0.6 + Math.min(2.2, Math.abs(this.speed) * 0.06) +
      this.waveField.params.chopScale * 0.4

    // prop spin: revs follow throttle (idle tickover when moving at all,
    // full churn at speed; reverses with reverse) — the whole assembly
    // about the hub-centered shaft axis
    if (this.propGroup && Math.abs(this.speed) > 0.1) {
      const revs =
        (2.5 + Math.abs(this.speed) * 1.3) * Math.sign(this.speed) * dt
      this.propGroup.rotateOnAxis(this.propAxis, revs)
    }

  }

  /** Hard-locked drive camera pose for the active preset. */
  private camHeave = 0

  driveCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    const p = DRIVE_PRESETS[this.presetIndex]
    const dirX = Math.sin(this.heading)
    const dirZ = -Math.cos(this.heading)
    // The camera position is damped below, but lookAt is instantaneous —
    // aiming it at raw heave whips the whole frame vertically on every
    // buoyancy jitter (the "hurricane camera" at speed). The camera
    // tracks its own slow heave instead; the hull can bob without
    // shaking the horizon.
    this.camHeave += (this.heave - this.camHeave) * (1 - Math.exp(-dt * 3.5))
    const targetPos = new THREE.Vector3(
      this.x - dirX * p.back,
      this.camHeave + p.up,
      this.z - dirZ * p.back,
    )
    // Never let the lens dip into the water: low presets ride ~2 m up,
    // but heave dips + the stern wake hump at speed can put the displaced
    // surface ABOVE the camera (Low Chase "swallowed" at 150 mph). The
    // wake field peaks well under a meter, so a 1.5 m floor keeps the
    // horizon dry through any combination of dip and hump.
    targetPos.y = Math.max(targetPos.y, 1.5)
    const blend = 1 - Math.exp(-dt * 5.5)
    camera.position.lerp(targetPos, blend)
    camera.lookAt(
      this.x + dirX * p.lookAhead,
      Math.max(this.camHeave + p.lookUp, 0.6),
      this.z + dirZ * p.lookAhead,
    )
  }
}
