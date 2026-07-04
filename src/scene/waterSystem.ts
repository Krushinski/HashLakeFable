import * as THREE from 'three/webgpu'
import {
  Fn,
  attribute,
  cameraPosition,
  color,
  exp,
  float,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  reflector,
  smoothstep,
  texture,
  varying,
  vec2,
  vec3,
} from 'three/tsl'
import type { WaveField } from './waveField'
import { shoreSdf, waterDepth } from './lakeMap'
import {
  makeDetailNormalTexture,
  makeFoamTexture,
} from './proceduralTextures'
import type { SkySystem } from './skySystem'

/**
 * The hero water.
 *
 * Geometry: a lake-fitted grid displaced in the vertex stage by the analytic
 * Gerstner bank (WaveField) — real 3D swell and chop with closed-form
 * normals and crest-fold, no readback, identical on WebGPU and WebGL 2.
 *
 * Shading: Beer–Lambert depth absorption over the lake bed, planar
 * reflections of the ACTUAL scene (sky, mountains, forest, boat) distorted
 * by the wave normals, fresnel blend, twin-lobe sun glint, and three foam
 * layers (jacobian whitecaps, shoreline lap, ambient wind streaks) — the
 * §9 contract.
 */

const WATER_DOMAIN = 2048 // world meters covered by the grid
const GRID_CELLS = 336 // cells per side before land trimming
const LAND_MARGIN = 24 // keep skirt cells this far onto land

function buildLakeGeometry(): THREE.BufferGeometry {
  const step = WATER_DOMAIN / GRID_CELLS
  const half = WATER_DOMAIN / 2

  // First pass: mark grid corners that are in-or-near the lake.
  const cols = GRID_CELLS + 1
  const keep = new Uint8Array(cols * cols)
  const sdfs = new Float32Array(cols * cols)
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < cols; i++) {
      const x = -half + i * step
      const z = -half + j * step
      const s = shoreSdf(x, z)
      sdfs[j * cols + i] = s
      keep[j * cols + i] = s < LAND_MARGIN ? 1 : 0
    }
  }

  // Second pass: emit only cells with at least one kept corner.
  const vertIndex = new Int32Array(cols * cols).fill(-1)
  const positions: number[] = []
  const depths: number[] = []
  const shores: number[] = []
  const indices: number[] = []

  const getVertex = (i: number, j: number): number => {
    const key = j * cols + i
    if (vertIndex[key] === -1) {
      const x = -half + i * step
      const z = -half + j * step
      vertIndex[key] = positions.length / 3
      positions.push(x, 0, z)
      depths.push(waterDepth(x, z))
      shores.push(sdfs[key])
    }
    return vertIndex[key]
  }

  for (let j = 0; j < GRID_CELLS; j++) {
    for (let i = 0; i < GRID_CELLS; i++) {
      const c00 = keep[j * cols + i]
      const c10 = keep[j * cols + i + 1]
      const c01 = keep[(j + 1) * cols + i]
      const c11 = keep[(j + 1) * cols + i + 1]
      if (!(c00 || c10 || c01 || c11)) continue
      const a = getVertex(i, j)
      const b = getVertex(i + 1, j)
      const c = getVertex(i, j + 1)
      const d = getVertex(i + 1, j + 1)
      indices.push(a, c, b, b, c, d)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3),
  )
  geo.setAttribute('lakeDepth', new THREE.Float32BufferAttribute(depths, 1))
  geo.setAttribute('shoreDist', new THREE.Float32BufferAttribute(shores, 1))
  geo.setIndex(indices)
  return geo
}

export class WaterSystem {
  readonly mesh: THREE.Mesh
  readonly material: THREE.MeshBasicNodeMaterial

  constructor(
    scene: THREE.Scene,
    readonly waveField: WaveField,
    sky: SkySystem,
  ) {
    const detailNormals = makeDetailNormalTexture()
    const foamTex = makeFoamTexture()

    const material = new THREE.MeshBasicNodeMaterial()
    material.transparent = true

    // ------------------------------------------------------------ vertex
    // Varyings are declared here and assigned inside the position Fn —
    // TSL assignments must run inside an Fn() stack.
    const vNormal = varying(vec3(0, 1, 0), 'vWaveNormal')
    const vFold = varying(float(0), 'vWaveFold')
    const vHeight = varying(float(0), 'vWaveHeight')
    const vDepth = varying(float(0), 'vLakeDepth')

    material.positionNode = Fn(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const depthAttr = float(attribute('lakeDepth', 'float') as any)
      const posXZ = vec2(positionLocal.x, positionLocal.z)
      const ampFade = smoothstep(float(0.06), float(2.4), depthAttr)
      const wave = this.waveField.buildTSL(posXZ, ampFade)
      vNormal.assign(wave.normal)
      vFold.assign(wave.fold)
      vHeight.assign(wave.offset.y)
      vDepth.assign(depthAttr)
      return positionLocal.add(wave.offset)
    })()

    // ---------------------------------------------------------- fragment
    const t = this.waveField.uTime

    // High-frequency ripple detail from the tileable normal map, fading
    // with distance to keep the far lake calm and alias-free.
    const worldXZ = vec2(positionWorld.x, positionWorld.z)
    const viewDist = cameraPosition.sub(positionWorld).length()
    const detailFade = float(1).div(viewDist.mul(0.0045).add(1))

    const duvA = worldXZ.mul(0.052).add(vec2(t.mul(0.013), t.mul(0.021)))
    const duvB = worldXZ.mul(0.017).sub(vec2(t.mul(0.011), t.mul(-0.006)))
    const dA = texture(detailNormals, duvA).rg.mul(2).sub(1)
    const dB = texture(detailNormals, duvB).rg.mul(2).sub(1)
    const detail = dA.add(dB).mul(float(0.55).mul(detailFade)).mul(ampFadeFrag(vDepth))

    const n = normalize(
      vec3(
        vNormal.x.add(detail.x),
        vNormal.y,
        vNormal.z.add(detail.y),
      ),
    )

    const V = normalize(cameraPosition.sub(positionWorld))
    const NdotV = n.dot(V).max(0)
    const fresnel = float(0.024).add(
      float(0.976).mul(pow(float(1).sub(NdotV), 4.2)),
    )

    // Beer–Lambert body color over the bed.
    const absorb = vec3(0.62, 0.16, 0.115) // red dies first — alpine teal
    const viewStretch = float(1).div(NdotV.mul(0.85).add(0.15))
    const transmit = exp(
      vDepth.mul(viewStretch).mul(absorb.negate()).mul(0.85),
    )
    const bedTint = mix(
      color(0xcfc1a0), // pale sand shallows
      color(0x25321f), // deep olive bed
      smoothstep(float(0), float(7.5), vDepth),
    )
    const deepScatter = color(0x07333c)
    const body = deepScatter
      .mul(float(1).sub(transmit.g))
      .add(bedTint.mul(transmit).mul(0.92))
      // faint teal lift on wave flanks — cheap subsurface impression
      .add(color(0x0d4f49).mul(vHeight.mul(1.6).clamp(0, 1)).mul(0.3))

    // Planar reflection of the live scene, distorted by the wave normal.
    // Rendered at reduced resolution — the wave distortion hides it, and it
    // roughly halves the frame cost of a full-res mirror pass.
    // (?noreflect QA flag swaps in a flat sky tint to isolate its cost.)
    const useReflector = !new URLSearchParams(location.search).has('noreflect')
    let reflectionRGB
    if (useReflector) {
      const reflection = reflector({ resolutionScale: 0.35 })
      reflection.target.rotateX(-Math.PI / 2)
      scene.add(reflection.target)
      reflection.uvNode = reflection.uvNode!.add(n.xz.mul(0.11))
      reflectionRGB = reflection.rgb
    } else {
      reflectionRGB = color(0x9db8c4).mul(1.0)
    }

    // Twin-lobe sun glint.
    const H = normalize(sky.uSunDirection.add(V))
    const NdotH = n.dot(H).max(0)
    const sunCol = sky.uSunColor
    // Clamped to tame HDR fireflies that otherwise alias into bloom dots.
    const glint = pow(NdotH, 360).mul(2.6).min(2.1).add(pow(NdotH, 48).mul(0.16))

    // ------------------------------------------------------------- foam
    const foamUv = worldXZ.mul(0.06).add(vec2(t.mul(0.02), t.mul(0.014)))
    const foamSample = texture(foamTex, foamUv)
    const foamBig = texture(foamTex, worldXZ.mul(0.011).add(t.mul(0.004))).g

    const crestFoam = smoothstep(
      float(0.34),
      float(0.68),
      vFold.add(foamSample.g.sub(0.5).mul(0.3)),
    )
    const lap = vDepth
      .mul(5.2)
      .sub(t.mul(1.35))
      .sin()
      .mul(0.5)
      .add(0.5)
    const shoreFoam = smoothstep(float(1.5), float(0.18), vDepth)
      .mul(lap.mul(0.55).add(0.45))
      .mul(foamSample.r.mul(0.75).add(0.25))
    const ambientFoam = smoothstep(float(0.62), float(0.95), foamBig)
      .mul(foamSample.r)
      .mul(0.16)

    const foamMask = crestFoam
      .mul(1.15)
      .add(shoreFoam.mul(0.95))
      .add(ambientFoam)
      .clamp(0, 1)

    const foamColor = sunCol.mul(0.35).add(0.65).mul(color(0xeaf5f2))

    // ------------------------------------------------------------ compose
    const reflectAmount = fresnel.mul(float(1).sub(foamMask.mul(0.9)))
    let col = mix(body, reflectionRGB, reflectAmount)
      .add(sunCol.mul(glint).mul(float(1).sub(foamMask)))
    col = mix(col, foamColor, foamMask)

    material.colorNode = col.min(5)
    material.opacityNode = smoothstep(float(0.0), float(0.32), vDepth)
      .mul(0.985)
      .add(0.015)

    // ------------------------------------------------------------- mesh
    const geometry = buildLakeGeometry()
    this.material = material
    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.frustumCulled = false // vertex displacement breaks the AABB
    this.mesh.renderOrder = 10
    scene.add(this.mesh)
  }

  update(dt: number): void {
    this.waveField.update(dt)
  }
}

/** Depth-based amplitude fade, fragment-side twin of the vertex fade. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ampFadeFrag(depthNode: any) {
  return smoothstep(float(0.06), float(1.6), depthNode)
}
