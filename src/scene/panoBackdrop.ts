import * as THREE from 'three/webgpu'
import { texture, uniform, vec4 } from 'three/tsl'
import { LAKE_SCALE } from './lakeMap'

/**
 * The Cycles shore panorama — a horizon band of the Blender world (the 81k
 * grass biome, full forest, the hero range under real GI) mounted as an
 * equirect sphere segment just outside the terrain square. Sky Pro stays
 * the sky authority: the band is alpha-CUTOUT, never alpha-blended — a
 * transparent mesh would re-arm Water Pro's transparent depth+color
 * sub-passes, the exact cost that got the old mist quads retired — so the
 * dome shows through everywhere the bake has sky.
 *
 * Band angles come from tools/prep-bakes.mjs (pano rows 784..1032 of
 * 2048) — re-run the script and update these together if the bake changes.
 */
const THETA_START = (784 / 2048) * Math.PI
const THETA_LENGTH = (248 / 2048) * Math.PI

/** Blender pano camera height above the water (the bake's eye point). */
const EYE_Y = 6

/**
 * Outside the terrain square's corners (2715 m at the 0.75 world) so land
 * can never poke through the band; inside the far-ridge crests, whose
 * silhouettes still rise behind it through the alpha sky. Rides LAKE_SCALE
 * only so the ?scale probe keeps rough proportions — the bake content
 * itself is of the 0.75 world.
 */
const RADIUS = 3733 * LAKE_SCALE

export class PanoBackdrop {
  readonly mesh: THREE.Mesh
  private readonly mood = uniform(new THREE.Color(1, 1, 1))
  /** ?panoboost=N — live brightness dial for taste passes (default 1). */
  private readonly boost: number

  constructor(scene: THREE.Scene) {
    const q = new URLSearchParams(location.search)
    const boostProbe = Number(q.get('panoboost'))
    this.boost = Number.isFinite(boostProbe) && boostProbe > 0 ? boostProbe : 1
    ;(this.mood.value as THREE.Color).setScalar(this.boost)
    const base = import.meta.env.BASE_URL
    const tex = new THREE.TextureLoader().load(
      `${base}assets/textures/hl-pano-shores.webp`,
    )
    tex.colorSpace = THREE.SRGBColorSpace
    // the band is always viewed near-grazing — without anisotropy the
    // treeline melts into a smear one mip too early
    tex.anisotropy = 8
    // ?panoflip mirrors the equirect east-west (bake-convention A/B rig;
    // hardcode the verdict once verified against the 3D massif)
    if (q.has('panoflip')) {
      tex.wrapS = THREE.RepeatWrapping
      tex.repeat.x = -1
    }

    const geo = new THREE.SphereGeometry(
      RADIUS,
      128,
      12,
      0,
      Math.PI * 2,
      THETA_START,
      THETA_LENGTH,
    )

    const mat = new THREE.MeshBasicNodeMaterial()
    // unlit: the bake carries its own sun. The mood uniform (fed each frame
    // from the same water.lighting rig Water Pro re-syncs the real lights
    // from) carries storms and night; scene fog adds aerial perspective.
    const t = texture(tex)
    mat.colorNode = vec4(t.rgb.mul(this.mood), t.a)
    mat.alphaTest = 0.35
    mat.side = THREE.BackSide
    // NO scene fog: Cycles already baked true aerial perspective into the
    // pano at real distances — the web fog was a SECOND full dose (~52%
    // wash at the band's 3.3 km from the opening camera in Serene, which
    // erased the daylight band entirely). Storm/night stay correct via
    // the mood uniform; the fog-on-sky lesson applies to backdrops too.
    mat.fog = false

    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.position.y = EYE_Y
    // align the bake's u=0.5 (the hero massif, due north) with world -Z;
    // ?panorot=deg trims azimuth live while verifying
    const trim = Number(q.get('panorot')) || 0
    this.mesh.rotation.y = Math.PI / 2 + (trim * Math.PI) / 180
    scene.add(this.mesh)
  }

  /**
   * Track the scene mood from the tier-driven lighting values — normalized
   * so the blackFlag daylight rig (sun 2.5, ambient 1.3) lands at ~1.
   * Storm tiers dim it with the world; the night moon rig turns it a dark
   * blue-grey for free.
   */
  setMood(
    sunColor: THREE.Color,
    sunIntensity: number,
    skyColor: THREE.Color,
    ambientIntensity: number,
  ): void {
    const m = this.mood.value as THREE.Color
    const s = (sunIntensity / 2.5) * 0.55 * this.boost
    const a = (ambientIntensity / 1.3) * 0.5 * this.boost
    const cap = 1.15 * this.boost
    m.setRGB(
      Math.min(cap, sunColor.r * s + skyColor.r * a),
      Math.min(cap, sunColor.g * s + skyColor.g * a),
      Math.min(cap, sunColor.b * s + skyColor.b * a),
    )
  }
}
