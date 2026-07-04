import './styles.css'
import * as THREE from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { phasePillText } from './buildInfo'
import { SkySystem } from './scene/skySystem'
import { WaveField } from './scene/waveField'
import { WaterSystem } from './scene/waterSystem'
import { TerrainSystem } from './scene/terrainSystem'
import { ForestSystem } from './scene/forestSystem'

const loader = document.getElementById('loader') as HTMLDivElement
const loaderSub = document.getElementById('loader-sub') as HTMLParagraphElement
const phasePill = document.getElementById('phase-pill') as HTMLDivElement
const appHost = document.getElementById('app') as HTMLDivElement

const bootStartedAt = performance.now()

function showFallback(reason: unknown): void {
  console.error('HashLake boot failed:', reason)
  loader.classList.add('fallback')
  loaderSub.innerHTML =
    'The lake needs a browser with WebGPU or WebGL&nbsp;2 to surface.<br />' +
    'Chrome, Edge, Firefox, or Safari 26+ on an up-to-date device will open it.'
}

/**
 * Temporary storm-tier previews (keys 1–5) so the water can be judged
 * against each reference image while the real weather engine (Phase 6)
 * is still to come. These become debug-panel territory later.
 */
interface TierPreview {
  name: string
  swell: number
  chop: number
  choppiness: number
  turbidity: number
  rayleigh: number
  sunElevation: number
  exposure: number
}

const TIER_PREVIEWS: TierPreview[] = [
  { name: 'Serene', swell: 0.55, chop: 0.4, choppiness: 0.85, turbidity: 8, rayleigh: 1.8, sunElevation: 25, exposure: 0.5 },
  { name: 'Uneasy', swell: 1.0, chop: 0.9, choppiness: 1.0, turbidity: 12, rayleigh: 1.4, sunElevation: 28, exposure: 0.48 },
  { name: 'Volatile', swell: 1.7, chop: 1.6, choppiness: 1.15, turbidity: 20, rayleigh: 0.8, sunElevation: 35, exposure: 0.44 },
  { name: 'Storm', swell: 2.6, chop: 2.4, choppiness: 1.3, turbidity: 30, rayleigh: 0.4, sunElevation: 40, exposure: 0.4 },
  { name: 'Apocalyptic', swell: 3.4, chop: 3.1, choppiness: 1.45, turbidity: 40, rayleigh: 0.2, sunElevation: 45, exposure: 0.35 },
]

async function boot(): Promise<void> {
  const forceWebGL = new URLSearchParams(location.search).has('webgl')

  let renderer: THREE.WebGPURenderer
  try {
    renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL })
    await renderer.init()
  } catch (err) {
    showFallback(err)
    return
  }

  const backend = renderer.backend as { isWebGPUBackend?: boolean }
  const rendererPath = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2'

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.5
  appHost.appendChild(renderer.domElement)

  // ---------- scene ----------
  const scene = new THREE.Scene()
  // Alpine air: crisp near field, gentle aerial perspective far out.
  scene.fog = new THREE.Fog(0xcfdad2, 2100, 7000)

  const sky = new SkySystem(renderer, scene)
  const waveField = new WaveField(20)
  const water = new WaterSystem(scene, waveField, sky)
  new TerrainSystem(scene)
  const forest = new ForestSystem(scene)
  forest.load().catch((err) => console.error('forest load failed:', err))

  sky.bakeEnvironment()

  // ---------- camera: hero shot low over the south shallows, looking
  // north across the full fetch of the lake (000_INSPIRATION geometry).
  const camera = new THREE.PerspectiveCamera(
    46,
    window.innerWidth / window.innerHeight,
    0.3,
    12000,
  )
  // Live-tunable camera rig (drift oscillates around these).
  const camRig = {
    pos: new THREE.Vector3(120, 6.5, 740),
    look: new THREE.Vector3(210, 12, 400),
    drift: 1,
  }
  camera.position.copy(camRig.pos)
  camera.lookAt(camRig.look)

  // ---------- post ----------
  const PipelineCtor =
    (THREE as unknown as { RenderPipeline?: typeof THREE.PostProcessing })
      .RenderPipeline ?? THREE.PostProcessing
  const post = new PipelineCtor(renderer)
  const scenePass = pass(scene, camera)
  const scenePassColor = scenePass.getTextureNode('output')
  post.outputNode = scenePassColor.add(bloom(scenePassColor, 0.15, 0.35, 1.2))

  // ---------- tier preview keys (temporary, pre-weather-engine) ----------
  let tier = TIER_PREVIEWS[0]
  const applyTier = (t: TierPreview) => {
    tier = t
    waveField.params.swellScale = t.swell
    waveField.params.chopScale = t.chop
    waveField.params.choppiness = t.choppiness
    sky.sky.turbidity.value = t.turbidity
    sky.sky.rayleigh.value = t.rayleigh
    sky.setSun(t.sunElevation, 205)
    renderer.toneMappingExposure = t.exposure
    sky.bakeEnvironment()
    updatePill(rendererPath)
  }
  window.addEventListener('keydown', (e) => {
    const idx = ['1', '2', '3', '4', '5'].indexOf(e.key)
    if (idx >= 0) applyTier(TIER_PREVIEWS[idx])
  })

  // ---------- resize ----------
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  // ---------- loop ----------
  let firstFrameShown = false
  let fpsAccum = 0
  let fpsFrames = 0
  let fps = 0
  const clock = new THREE.Clock()

  const updatePill = (path: string) => {
    phasePill.textContent = `${phasePillText(path)} · ${tier.name} · ${fps.toFixed(0)} fps`
  }

  // Live-debug handle (console-only; no UI surface).
  ;(window as unknown as Record<string, unknown>).__HL = {
    THREE,
    renderer,
    scene,
    sky,
    waveField,
    water,
    forest,
    camera,
    camRig,
  }

  renderer.setAnimationLoop(() => {
    const rawDt = clock.getDelta()
    const dt = Math.min(rawDt, 0.1)
    const t = clock.elapsedTime

    water.update(dt)

    // Slow cinematic drift around the rig.
    camera.position.set(
      camRig.pos.x + Math.sin(t * 0.04) * 10 * camRig.drift,
      camRig.pos.y + Math.sin(t * 0.1) * 0.4 * camRig.drift,
      camRig.pos.z,
    )
    camera.lookAt(
      camRig.look.x + Math.sin(t * 0.03) * 18 * camRig.drift,
      camRig.look.y,
      camRig.look.z,
    )

    post.render()

    fpsAccum += rawDt
    fpsFrames++
    if (fpsAccum >= 0.5) {
      fps = fpsFrames / fpsAccum
      fpsAccum = 0
      fpsFrames = 0
      updatePill(rendererPath)
    }

    if (!firstFrameShown) {
      firstFrameShown = true
      phasePill.hidden = false
      console.info(`HashLake · water proof · renderer path: ${rendererPath}`)
      const elapsed = performance.now() - bootStartedAt
      window.setTimeout(
        () => {
          loader.classList.add('hidden')
          window.setTimeout(() => loader.remove(), 1800)
        },
        Math.max(0, 1400 - elapsed),
      )
    }
  })
}

boot().catch(showFallback)
