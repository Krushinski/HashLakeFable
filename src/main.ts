import './styles.css'
import * as THREE from 'three/webgpu'
import {
  color,
  float,
  mix,
  mx_noise_float,
  pass,
  positionWorld,
  positionWorldDirection,
  smoothstep,
  time,
  vec3,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { phasePillText } from './buildInfo'

/**
 * Phase 0 — First Light.
 * A deliberately minimal nocturne tableau that proves the whole spine:
 * WebGPU-first boot (WebGL 2 automatic fallback), TSL materials compiling on
 * both backends, the node-based post stack, immediate render, and the
 * loading-screen choreography. Every visual here is a placeholder that later
 * phases replace with the real systems.
 */

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

async function boot(): Promise<void> {
  // QA escape hatch: ?webgl forces the WebGL 2 backend so the fallback path
  // stays verifiable on WebGPU-capable machines (brief §2.1).
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

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  appHost.appendChild(renderer.domElement)

  // ---------- scene ----------
  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x081418, 420, 1500)

  // Night-sky gradient with a soft teal horizon glow (placeholder sky).
  const dirY = positionWorldDirection.y
  const zenith = color(0x02070a)
  const horizon = color(0x123239)
  const skyGradient = mix(horizon, zenith, dirY.clamp(0, 1).pow(0.55))
  const horizonGlow = color(0x1e5f5c).mul(
    smoothstep(0.35, 0.0, dirY.abs()).mul(0.22),
  )
  scene.backgroundNode = skyGradient.add(horizonGlow)

  // ---------- placeholder water (Phase 1 replaces this wholesale) ----------
  const waterGeometry = new THREE.CircleGeometry(1400, 128)
  waterGeometry.rotateX(-Math.PI / 2)

  const waterMaterial = new THREE.MeshStandardNodeMaterial()
  const drift = time.mul(0.045)
  const p = positionWorld.xz.mul(0.006)
  const breatheA = mx_noise_float(vec3(p.x.add(drift), p.y, drift))
  const breatheB = mx_noise_float(
    vec3(p.x.mul(3.1), p.y.mul(3.1).sub(drift.mul(1.7)), drift.mul(0.6)),
  )
  const shimmer = breatheA.mul(0.6).add(breatheB.mul(0.4)).add(1).mul(0.5) // 0..1
  waterMaterial.colorNode = mix(color(0x0a2126), color(0x0f3038), shimmer)
  waterMaterial.roughnessNode = float(0.08).add(shimmer.mul(0.1))
  waterMaterial.metalness = 0.0

  const water = new THREE.Mesh(waterGeometry, waterMaterial)
  scene.add(water)

  // ---------- light ----------
  const moon = new THREE.DirectionalLight(0xcfe4ea, 1.35)
  moon.position.set(-260, 340, -420)
  scene.add(moon)
  scene.add(new THREE.HemisphereLight(0x2a4a53, 0x0a1012, 0.4))

  // ---------- camera ----------
  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.5,
    4000,
  )
  camera.position.set(0, 26, 150)
  camera.lookAt(0, 8, 0)

  // ---------- post ----------
  const postProcessing = new THREE.PostProcessing(renderer)
  const scenePass = pass(scene, camera)
  const scenePassColor = scenePass.getTextureNode()
  const bloomPass = bloom(scenePassColor, 0.22, 0.35, 0.82)
  postProcessing.outputNode = scenePassColor.add(bloomPass)

  // ---------- resize ----------
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  // ---------- loop ----------
  let firstFrameShown = false
  const clock = new THREE.Clock()

  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime()

    // Slow cinematic drift — enough life to feel alive on a wall.
    camera.position.x = Math.sin(t * 0.05) * 14
    camera.position.y = 26 + Math.sin(t * 0.11) * 1.6
    camera.lookAt(0, 8, 0)

    postProcessing.render()

    if (!firstFrameShown) {
      firstFrameShown = true
      revealScene(rendererPath)
    }
  })
}

function revealScene(rendererPath: string): void {
  phasePill.textContent = phasePillText(rendererPath)
  phasePill.hidden = false
  console.info(`HashLake · first light · renderer path: ${rendererPath}`)

  // Let the loader hold for a beat so the arrival feels intentional,
  // then dissolve into the scene.
  const elapsed = performance.now() - bootStartedAt
  const holdMs = Math.max(0, 1400 - elapsed)
  window.setTimeout(() => {
    loader.classList.add('hidden')
    window.setTimeout(() => loader.remove(), 1800)
  }, holdMs)
}

boot().catch(showFallback)
