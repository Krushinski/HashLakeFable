import * as THREE from 'three/webgpu'
import {
  Fn,
  attribute,
  color,
  float,
  mix,
  positionLocal,
  smoothstep,
  varying,
  vec2,
  vec3,
  mx_noise_float,
} from 'three/tsl'
import { fbm2, valueNoise2 } from '../core/noise'
import { bedHeight, shoreSdf } from './lakeMap'

/**
 * The land — from lakebed sand to hero peaks, one height function.
 *
 * Composition follows the Inspiration-2 contract (§8/§11): water →
 * shoreline → meadow shelf → climbing forest land → foothills → the hero
 * mountain range standing far back on the north side, never a ring hugging
 * the lake. South/east/west stay lower and rolling.
 *
 * Heights inside the lake ARE the visible bed under the shallows — the
 * same lakeMap functions the water reads, so land and water can never
 * disagree.
 */

const DOMAIN = 5120
const CELLS = 528

interface Ridge {
  x1: number
  z1: number
  h1: number
  x2: number
  z2: number
  h2: number
  r: number // half-width of the ridge flank
}

/**
 * The hero range as connected RIDGE SEGMENTS — mountains are chains with
 * saddles and sharp crests, never radial gumdrops (§11.3).
 */
const RIDGES: Ridge[] = [
  // centerpiece massif: steep pyramid with shoulders
  { x1: -420, z1: -1720, h1: 520, x2: -120, z2: -1880, h2: 820, r: 340 },
  { x1: -120, z1: -1880, h1: 820, x2: 260, z2: -1760, h2: 560, r: 320 },
  // east spur descending toward the cove side
  { x1: 260, z1: -1760, h1: 560, x2: 780, z2: -1620, h2: 660, r: 330 },
  { x1: 780, z1: -1620, h1: 660, x2: 1350, z2: -1420, h2: 380, r: 300 },
  // west wall
  { x1: -420, z1: -1720, h1: 520, x2: -980, z2: -1600, h2: 640, r: 330 },
  { x1: -980, z1: -1600, h1: 640, x2: -1520, z2: -1380, h2: 360, r: 300 },
  // far back-range: taller, hazier, filling the horizon gaps
  { x1: -700, z1: -2350, h1: 760, x2: 60, z2: -2450, h2: 900, r: 480 },
  { x1: 60, z1: -2450, h1: 900, x2: 800, z2: -2250, h2: 700, r: 440 },
]

function ridgedNoise(x: number, z: number, seed: number): number {
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < 5; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, z * freq, seed + i * 37))
    sum += n * n * amp
    norm += amp
    amp *= 0.55
    freq *= 2.1
  }
  return sum / norm // 0..1
}

function mountainHeight(x: number, z: number): number {
  let h = 0
  for (const rg of RIDGES) {
    // distance to the ridge segment + parameter along it
    const ax = x - rg.x1
    const az = z - rg.z1
    const bx = rg.x2 - rg.x1
    const bz = rg.z2 - rg.z1
    const len2 = bx * bx + bz * bz
    let t = (ax * bx + az * bz) / len2
    t = Math.max(0, Math.min(1, t))
    const px = rg.x1 + bx * t
    const pz = rg.z1 + bz * t
    const d = Math.hypot(x - px, z - pz) / rg.r
    if (d > 2.6) continue

    // crest height along the segment, dipping into saddles mid-span
    const crest =
      (rg.h1 + (rg.h2 - rg.h1) * t) *
      (1 - 0.18 * Math.sin(t * Math.PI) * (rg.h1 > 400 && rg.h2 > 400 ? 1 : 0))

    // sharp flank profile — steep near the crest, easing at the skirt
    const flank = Math.pow(Math.max(0, 1 - d / 2.6), 1.8)

    // carve with ridged noise: strong crest articulation + rocky detail
    const macro = ridgedNoise(x * 0.0011, z * 0.0011, 913)
    const micro = ridgedNoise(x * 0.0048, z * 0.0048, 407)
    const carved = crest * flank * (0.52 + 0.38 * macro + 0.22 * micro)

    h = Math.max(h, carved)
  }
  return h
}

export function terrainHeight(x: number, z: number): number {
  const sdf = shoreSdf(x, z)

  if (sdf < 0) {
    return bedHeight(x, z)
  }

  // Shore shelf: gentle walkable rise, then meadow.
  const shelf = Math.min(1, sdf / 420)
  let h = 0.25 + 4.2 * Math.pow(shelf, 1.35)

  h +=
    fbm2(x * 0.0022, z * 0.0022, { octaves: 4, seed: 77 }) *
    2.6 *
    Math.min(1, sdf / 90)

  // Foothills climbing toward the north range.
  const north = Math.min(1, Math.max(0, (-z - 620) / 900))
  h += north * north * 130
  h +=
    north *
    fbm2(x * 0.0012, z * 0.0012, { octaves: 3, seed: 55 }) *
    46 *
    north

  // Hero mountains (north) — blended over the foothills.
  h = Math.max(h, mountainHeight(x, z))

  // Rolling rises on the other sides so the basin feels cradled.
  const radial = Math.hypot(x, z - 40)
  const edge = Math.min(1, Math.max(0, (radial - 1350) / 1000))
  const southish = Math.max(0, z / Math.max(radial, 1))
  h += edge * edge * (55 + 60 * southish) *
    (0.7 + 0.6 * fbm2(x * 0.0016, z * 0.0016, { octaves: 3, seed: 99 }))

  return h
}

/**
 * Distant background ranges (§user: fill the horizon flatness where it
 * pleases the eye) — a cheap separate band far beyond the main terrain,
 * hazed by fog into aerial-perspective silhouettes. North wall + east and
 * west spurs; the south stays open to breathe.
 */
const FAR_RIDGES: Ridge[] = [
  { x1: -2900, z1: -3400, h1: 760, x2: -900, z2: -3750, h2: 1120, r: 950 },
  { x1: -900, z1: -3750, h1: 1120, x2: 1500, z2: -3500, h2: 880, r: 900 },
  { x1: 2300, z1: -2600, h1: 640, x2: 3600, z2: -1500, h2: 430, r: 760 },
  { x1: -3600, z1: -1300, h1: 540, x2: -2600, z2: -2300, h2: 730, r: 800 },
]

function farRangeHeight(x: number, z: number): number {
  let h = 0
  for (const rg of FAR_RIDGES) {
    const ax = x - rg.x1
    const az = z - rg.z1
    const bx = rg.x2 - rg.x1
    const bz = rg.z2 - rg.z1
    let t = (ax * bx + az * bz) / (bx * bx + bz * bz)
    t = Math.max(0, Math.min(1, t))
    const d = Math.hypot(x - (rg.x1 + bx * t), z - (rg.z1 + bz * t)) / rg.r
    if (d > 2.4) continue
    const crest = rg.h1 + (rg.h2 - rg.h1) * t
    const flank = Math.pow(Math.max(0, 1 - d / 2.4), 1.7)
    const rid = ridgedNoise(x * 0.0009, z * 0.0009, 733)
    h = Math.max(h, crest * flank * (0.55 + 0.4 * rid))
  }
  return h
}

export class FarRanges {
  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(9000, 9000, 160, 160)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, farRangeHeight(pos.getX(i), pos.getZ(i)) - 4)
    }
    geo.computeVertexNormals()

    const material = new THREE.MeshStandardNodeMaterial()
    material.roughness = 1
    const vH = varying(float(0), 'vFarH')
    material.positionNode = Fn(() => {
      vH.assign(positionLocal.y)
      return positionLocal
    })()
    material.colorNode = Fn(() => {
      const rock = mix(color(0x55524c), color(0x7d786f),
        mx_noise_float(vec3(positionLocal.xz.mul(0.004), 3.3)).mul(0.5).add(0.5))
      const snow = color(0xe8edf0)
      return mix(rock, snow, smoothstep(float(640), float(800), vH))
    })()
    const mesh = new THREE.Mesh(geo, material)
    scene.add(mesh)
  }
}

export class TerrainSystem {
  readonly mesh: THREE.Mesh

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(DOMAIN, DOMAIN, CELLS, CELLS)
    geo.rotateX(-Math.PI / 2)

    const pos = geo.attributes.position as THREE.BufferAttribute
    const shore = new Float32Array(pos.count)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, terrainHeight(x, z))
      shore[i] = shoreSdf(x, z)
    }
    geo.setAttribute('shoreDist', new THREE.BufferAttribute(shore, 1))
    geo.computeVertexNormals()

    // slope from the computed normals: 0 flat → 1 vertical
    const geoNormal = geo.attributes.normal as THREE.BufferAttribute
    const slopes = new Float32Array(pos.count)
    for (let i = 0; i < pos.count; i++) {
      slopes[i] = 1 - geoNormal.getY(i)
    }
    geo.setAttribute('slope', new THREE.BufferAttribute(slopes, 1))

    const material = new THREE.MeshStandardNodeMaterial()
    material.roughness = 0.95
    material.metalness = 0

    const vShore = varying(float(0), 'vShoreDist')
    const vHeight = varying(float(0), 'vTerrainHeight')
    const vSlope = varying(float(0), 'vSlope')

    material.positionNode = Fn(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vShore.assign(float(attribute('shoreDist', 'float') as any))
      vHeight.assign(positionLocal.y)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vSlope.assign(float(attribute('slope', 'float') as any))
      return positionLocal
    })()

    material.colorNode = Fn(() => {
      const worldXZ = vec2(positionLocal.x, positionLocal.z)
      const grain = mx_noise_float(vec3(worldXZ.mul(0.045), 7.7))
      const patch = mx_noise_float(vec3(worldXZ.mul(0.004), 3.1))
      const macro = mx_noise_float(vec3(worldXZ.mul(0.0008), 12.9))

      // palette
      const bedDeep = color(0x1e2b1a)
      const bedSand = color(0xb8a67f)
      const dampSand = color(0x8f8064)
      const drySand = color(0xd3c49d)
      const grassLush = color(0x4e7038)
      const grassDeep = color(0x35522c)
      const meadowDry = color(0x6d7f42)
      const forestFloor = color(0x2c4526)
      const rockLight = color(0x8d8578)
      const rockDark = color(0x4f4a42)
      const snow = color(0xeef2f4)

      // lakebed
      const bed = mix(
        bedSand,
        bedDeep,
        smoothstep(float(-2), float(-9), vHeight),
      )

      // beach band — narrow, pocketed by noise so it isn't a uniform rim
      const beach = mix(
        dampSand,
        drySand,
        smoothstep(float(0.12), float(0.9), vHeight),
      )

      // meadow: lush near shore, drier + patchier with altitude
      const grass = mix(
        mix(grassLush, grassDeep, patch.mul(0.5).add(0.5)),
        meadowDry,
        macro.mul(0.5).add(0.5).mul(0.55),
      )
      const upland = mix(
        grass,
        forestFloor,
        smoothstep(float(60), float(220), vHeight),
      )

      // rock takes over on slopes and altitude; banded striations at two
      // scales — broad strata + finer fracture detail
      const stria = mx_noise_float(
        vec3(worldXZ.x.mul(0.02), vHeight.mul(0.055), worldXZ.y.mul(0.02)),
      )
      const fracture = mx_noise_float(
        vec3(worldXZ.x.mul(0.11), vHeight.mul(0.16), worldXZ.y.mul(0.11)),
      )
      const rockBase = mix(rockDark, rockLight, stria.mul(0.5).add(0.5))
      const rock = mix(
        rockBase,
        mix(color(0x6b6257), color(0x9a938a), fracture.mul(0.5).add(0.5)),
        0.35,
      )
      // scree fans collect on the mid slopes below the crags
      const scree = color(0x7a7268)
      const screeMask = smoothstep(float(0.24), float(0.36), vSlope)
        .mul(float(1).sub(smoothstep(float(0.42), float(0.6), vSlope)))
        .mul(smoothstep(float(160), float(280), vHeight))
        .mul(patch.mul(0.5).add(0.5))

      const slopeRock = smoothstep(float(0.35), float(0.62), vSlope)
      const altRock = smoothstep(float(210), float(330), vHeight)
      const rockMask = slopeRock.max(altRock)

      // subalpine golden band where the meadow thins into rock
      const subalpine = color(0x96914e)
      const subalpMask = smoothstep(float(260), float(360), vHeight)
        .mul(float(1).sub(smoothstep(float(360), float(470), vHeight)))
        .mul(float(1).sub(slopeRock))
        .mul(macro.mul(0.5).add(0.5))

      // snow on high, flatter faces — the line broken by drift noise so
      // it reads as fingers and gullies, never a contour line
      const snowJitter = mx_noise_float(vec3(worldXZ.mul(0.006), 21.7))
        .mul(70)
      const snowMask = smoothstep(
        float(455),
        float(590),
        vHeight.add(snowJitter),
      ).mul(float(1).sub(smoothstep(float(0.42), float(0.68), vSlope)))

      const beachToGrass = mix(
        beach,
        upland,
        smoothstep(float(3), float(14), vShore).mul(
          smoothstep(float(0.25), float(1.6), vHeight),
        ),
      )
      let ground = mix(bed, beachToGrass,
        smoothstep(float(-0.35), float(0.25), vHeight))
      ground = mix(ground, subalpine, subalpMask.mul(0.6))
      ground = mix(ground, rock, rockMask)
      ground = mix(ground, scree, screeMask)
      ground = mix(ground, snow, snowMask)

      return ground.mul(grain.mul(0.12).add(0.94))
    })()

    this.mesh = new THREE.Mesh(geo, material)
    this.mesh.receiveShadow = true
    scene.add(this.mesh)
  }
}
