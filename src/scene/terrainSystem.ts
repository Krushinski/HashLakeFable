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
import { fbm2 } from '../core/noise'
import { bedHeight, shoreSdf } from './lakeMap'

/**
 * The land. Heights come from the same lakeMap functions the water reads,
 * so shore and water can never disagree — inside the lake this mesh IS the
 * visible bed under the shallows (sand through turquoise, brief §10.1/10.2).
 *
 * Phase 1 ships correct geography with honest-but-simple shading: wet/dry
 * sand bands, meadow grass, rising ground. The hero terrain/mountain art
 * pass (Phases 3 & 5) builds on exactly this surface.
 */

const DOMAIN = 4096
const CELLS = 384

export function terrainHeight(x: number, z: number): number {
  const sdf = shoreSdf(x, z)

  if (sdf < 0) {
    return bedHeight(x, z)
  }

  // Shore shelf: gentle rise off the waterline so beaches feel walkable,
  // then meadows, then broad foothill swell toward the domain edge.
  const shelf = Math.min(1, sdf / 420)
  let h = 0.25 + 4.2 * Math.pow(shelf, 1.35)

  // Rolling meadow relief that stays quiet near the beach pockets.
  h +=
    fbm2(x * 0.0022, z * 0.0022, { octaves: 4, seed: 77 }) *
    2.4 *
    Math.min(1, sdf / 90)

  // Broad rise toward the north (mountain side, -Z) — placeholder for the
  // Phase 3 foothills so the horizon already reads as rising land.
  const north = Math.min(1, Math.max(0, (-z - 500) / 1200))
  h += north * north * 90

  // Soft rise at the far south/east/west so the lake sits in a basin.
  const edge = Math.min(1, Math.max(0, (Math.hypot(x, z) - 1500) / 900))
  h += edge * edge * 40

  return h
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

    const material = new THREE.MeshStandardNodeMaterial()
    material.roughness = 0.96
    material.metalness = 0

    const vShore = varying(float(0), 'vShoreDist')
    const vHeight = varying(float(0), 'vTerrainHeight')

    material.positionNode = Fn(() => {
      vShore.assign(attribute('shoreDist', 'float'))
      vHeight.assign(positionLocal.y)
      return positionLocal
    })()

    material.colorNode = Fn(() => {
      const worldXZ = vec2(positionLocal.x, positionLocal.z)
      const grain = mx_noise_float(vec3(worldXZ.mul(0.05), 7.7))
      const patch = mx_noise_float(vec3(worldXZ.mul(0.006), 3.1))

      // Underwater bed → damp sand → dry sand → grass → high meadow.
      const bedDeep = color(0x233020)
      const bedSand = color(0xbfae8a)
      const dampSand = color(0x9a8b6d)
      const drySand = color(0xd8cba6)
      const grass = color(0x55743d)
      const grassDark = color(0x3c5730)
      const high = color(0x4a5c3c)

      // Below water: sand shallows darkening with depth.
      const bed = mix(
        bedSand,
        bedDeep,
        smoothstep(float(-2), float(-9), vHeight),
      )

      // Wet band just above the waterline, then dry sand pockets.
      const beach = mix(
        dampSand,
        drySand,
        smoothstep(float(0.15), float(1.1), vHeight),
      )

      // Grass takes over a few meters up-shore; patchy tone variation.
      const meadow = mix(
        grass,
        grassDark,
        patch.mul(0.5).add(0.5),
      )
      const upland = mix(
        meadow,
        high,
        smoothstep(float(25), float(90), vHeight),
      )

      const land = mix(
        beach,
        upland,
        smoothstep(float(4), float(16), vShore),
      )
      const ground = mix(
        bed,
        land,
        smoothstep(float(-0.4), float(0.3), vHeight),
      )

      return ground.mul(grain.mul(0.1).add(0.95))
    })()

    this.mesh = new THREE.Mesh(geo, material)
    this.mesh.receiveShadow = true
    scene.add(this.mesh)
  }
}
