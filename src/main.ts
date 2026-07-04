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
import { CloudSystem } from './scene/cloudSystem'
import { BoatSystem, type DriveInput } from './scene/boatSystem'
import { EffectsSystem } from './scene/effects'
import { LiveBitcoinStore } from './state/liveBitcoinStore'
import { WeatherEngine } from './state/weatherEngine'
import { bus } from './state/eventBus'
import { BitcoinPill } from './ui/bitcoinPill'
import { EventToast } from './ui/eventToast'
import { DebugPanel } from './ui/debugPanel'
import { LegendPanel } from './ui/legendPanel'
import { MobileControls } from './ui/mobileControls'
import { QualityGovernor } from './core/qualityGovernor'

const loader = document.getElementById('loader') as HTMLDivElement
const loaderSub = document.getElementById('loader-sub') as HTMLParagraphElement
const phasePill = document.getElementById('phase-pill') as HTMLDivElement
const appHost = document.getElementById('app') as HTMLDivElement

const bootStartedAt = performance.now()
const TABLEAU_KEY = 'hashlake.tableau.v1'

function showFallback(reason: unknown): void {
  console.error('HashLake boot failed:', reason)
  loader.classList.add('fallback')
  loaderSub.innerHTML =
    'The lake needs a browser with WebGPU or WebGL&nbsp;2 to surface.<br />' +
    'Chrome, Edge, Firefox, or Safari 26+ on an up-to-date device will open it.'
}

/** Visual anchors per storm tier — interpolated continuously by tierT. */
const TIER_VISUALS = {
  swell: [0.55, 1.0, 1.7, 2.6, 3.4],
  chop: [0.4, 0.9, 1.6, 2.4, 3.1],
  choppiness: [0.85, 1.0, 1.15, 1.3, 1.45],
  turbidity: [8, 12, 20, 30, 40],
  rayleigh: [1.8, 1.4, 0.8, 0.4, 0.2],
  exposure: [0.5, 0.47, 0.43, 0.38, 0.33],
  sunIntensity: [2.6, 2.2, 1.5, 0.85, 0.55],
  fogColor: [0xcfdad2, 0xb9c4bf, 0x8a949a, 0x525c63, 0x4a2a20],
  fogNear: [1700, 1500, 1200, 900, 700],
  fogFar: [5600, 5100, 4300, 3400, 2800],
}

function lerpAnchors(arr: number[], t: number): number {
  const i = Math.min(arr.length - 2, Math.floor(t))
  const f = Math.min(1, t - i)
  return arr[i] + (arr[i + 1] - arr[i]) * f
}

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
  scene.fog = new THREE.Fog(0xcfdad2, 1700, 5600)

  const sky = new SkySystem(renderer, scene)
  const waveField = new WaveField(20)
  const water = new WaterSystem(scene, waveField, sky)
  new TerrainSystem(scene)
  const forest = new ForestSystem(scene)
  forest.load().catch((err) => console.error('forest load failed:', err))
  const clouds = new CloudSystem(scene)
  const boat = new BoatSystem(scene, waveField)
  boat.load().catch((err) => console.error('boat load failed:', err))
  const effects = new EffectsSystem(scene, waveField, boat)

  sky.bakeEnvironment()

  // ---------- data + weather ----------
  const store = new LiveBitcoinStore()
  store.start()
  const weather = new WeatherEngine(store)

  // ---------- camera ----------
  const camera = new THREE.PerspectiveCamera(
    46,
    window.innerWidth / window.innerHeight,
    0.3,
    12000,
  )
  const camRig = {
    pos: new THREE.Vector3(40, 6, 620),
    look: new THREE.Vector3(-30, 30, -900),
    drift: 1,
  }
  // restore saved tableau
  try {
    const saved = JSON.parse(localStorage.getItem(TABLEAU_KEY) ?? 'null')
    if (saved) {
      boat.x = saved.x ?? boat.x
      boat.z = saved.z ?? boat.z
      boat.heading = saved.heading ?? boat.heading
      if (saved.camPos) camRig.pos.fromArray(saved.camPos)
      if (saved.camLook) camRig.look.fromArray(saved.camLook)
    }
  } catch {
    /* fresh start */
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

  // ---------- UI ----------
  const pill = new BitcoinPill(store)
  const toast = new EventToast()
  const legend = new LegendPanel()
  let driveMode = false
  const debug = new DebugPanel(store, weather, () => ({
    fps,
    rendererPath,
    mode: driveMode ? 'drive' : 'frame',
    boatSpeedMph: boat.speedMph,
    boatPos: { x: boat.x, z: boat.z },
    heading: boat.heading,
    cameraPreset: driveMode ? boat.presetName : 'tableau',
  }))

  const governor = new QualityGovernor(renderer)

  // event toasts (§28 tone)
  bus.on('whale', ({ btc }) => {
    if (btc >= 300) toast.show(`Whale moved — ${fmtBtc(btc)} BTC`)
    else if (btc >= 50) toast.show(`Large BTC move — ${fmtBtc(btc)} BTC`)
    else if (btc >= 10) toast.show(`BTC moved — ${fmtBtc(btc)} BTC`)
  })
  bus.on('newBlock', ({ height }) => {
    if (height) toast.show(`New block found — #${height.toLocaleString('en-US')}`)
  })
  bus.on('crash', () => toast.show('Storm front forming'))
  bus.on('rally', () => toast.show('Network calm returning'))
  bus.on('gust', () => toast.show('Gust rolling across the lake'))
  bus.on('stale', () => toast.show('Stale feed — fog rolling in'))
  bus.on('resumeLive', () => toast.show('Listening to the chain.'))

  const fmtBtc = (v: number) =>
    v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')

  // ---------- input ----------
  const input: DriveInput = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    boost: false,
    superBoost: false,
    anchor: false,
  }
  const keyMap: Record<string, keyof DriveInput> = {
    ArrowUp: 'forward',
    ArrowDown: 'backward',
    ArrowLeft: 'left',
    ArrowRight: 'right',
  }
  window.addEventListener('keydown', (e) => {
    if (e.key in keyMap) {
      input[keyMap[e.key]] = true
      if (driveMode) e.preventDefault()
    }
    if (e.key === 'Shift') input.boost = true
    if (e.key === 'Control') input.superBoost = e.shiftKey
    if (e.code === 'Space') {
      input.anchor = true
      if (driveMode) e.preventDefault()
    }
    if (e.key === 'x' || e.key === 'X') {
      driveMode = !driveMode
      toast.setMode(driveMode ? 'drive' : 'frame')
      updatePill()
    }
    if (e.key === 'c' || e.key === 'C') {
      if (driveMode) {
        toast.show(boat.cyclePreset())
        updatePill()
      }
    }
    if (e.key === 'd' || e.key === 'D') debug.toggle()
    if (e.key === 'l' || e.key === 'L') legend.toggle()
    if (e.key === 'f' || e.key === 'F') {
      if (document.fullscreenElement) document.exitFullscreen()
      else document.documentElement.requestFullscreen()
    }
    if (e.key === 'Enter' && driveMode) {
      localStorage.setItem(
        TABLEAU_KEY,
        JSON.stringify({
          x: boat.x,
          z: boat.z,
          heading: boat.heading,
          camPos: camRig.pos.toArray(),
          camLook: camRig.look.toArray(),
        }),
      )
      toast.show('Tableau saved')
    }
    if (e.key === 'r' || e.key === 'R') {
      camRig.pos.set(40, 6, 620)
      camRig.look.set(-30, 30, -900)
    }
    if (e.key === 'Escape' && driveMode) {
      driveMode = false
      toast.setMode('frame')
      updatePill()
    }
  })
  window.addEventListener('keyup', (e) => {
    if (e.key in keyMap) input[keyMap[e.key]] = false
    if (e.key === 'Shift') {
      input.boost = false
      input.superBoost = false
    }
    if (e.key === 'Control') input.superBoost = false
    if (e.code === 'Space') input.anchor = false
  })

  new MobileControls(input, {
    toggleDrive: () => {
      driveMode = !driveMode
      toast.setMode(driveMode ? 'drive' : 'frame')
      updatePill()
    },
    toggleDebug: () => debug.toggle(),
    toggleLegend: () => legend.toggle(),
    isDriving: () => driveMode,
  })

  // ---------- weather → world application ----------
  let lastBakeT = -10
  let lastBakedTier = -1
  const applyWeather = (dt: number, now: number) => {
    weather.update(dt)
    const t = weather.tierT
    const d = weather.dials

    waveField.params.swellScale = lerpAnchors(TIER_VISUALS.swell, t)
    waveField.params.chopScale =
      lerpAnchors(TIER_VISUALS.chop, t) * (weather.isGusting ? 1.35 : 1)
    waveField.params.choppiness = lerpAnchors(TIER_VISUALS.choppiness, t)

    sky.sky.turbidity.value = lerpAnchors(TIER_VISUALS.turbidity, t)
    sky.sky.rayleigh.value = lerpAnchors(TIER_VISUALS.rayleigh, t)
    renderer.toneMappingExposure =
      lerpAnchors(TIER_VISUALS.exposure, t) * (1 - d.skyDark * 0.35)
    sky.sunLight.intensity =
      lerpAnchors(TIER_VISUALS.sunIntensity, t) * (1 - d.skyDark * 0.6)

    // fog: tier haze + stale fog crush + fire tint
    const fog = scene.fog as THREE.Fog
    const cA = new THREE.Color(
      TIER_VISUALS.fogColor[Math.min(4, Math.floor(t))],
    )
    const cB = new THREE.Color(
      TIER_VISUALS.fogColor[Math.min(4, Math.floor(t) + 1)],
    )
    fog.color.copy(cA.lerp(cB, Math.min(1, t - Math.floor(t))))
    if (d.fireWeather > 0) {
      fog.color.lerp(new THREE.Color(0x3a140a), d.fireWeather * 0.6)
    }
    const staleCrush = 1 - d.fog * 0.82
    fog.near = lerpAnchors(TIER_VISUALS.fogNear, t) * staleCrush
    fog.far = lerpAnchors(TIER_VISUALS.fogFar, t) * Math.max(0.22, staleCrush)

    clouds.setMood(d.skyDark, 1 + d.rain * 0.3)

    // env rebake at most every 4s, only when the tier band moved
    const band = Math.round(t * 4)
    if (band !== lastBakedTier && now - lastBakeT > 4) {
      lastBakedTier = band
      lastBakeT = now
      sky.bakeEnvironment()
    }
  }

  // ---------- resize ----------
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  // ---------- debug handle ----------
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
    boat,
    input,
    store,
    weather,
    setDrive: (v: boolean) => {
      driveMode = v
    },
  }

  // ---------- loop ----------
  let firstFrameShown = false
  let fpsAccum = 0
  let fpsFrames = 0
  let fps = 0
  let pillTimer = 0
  const clock = new THREE.Clock()

  const updatePill = () => {
    const drive = driveMode
      ? ` · DRIVE ${boat.speedMph.toFixed(0)} mph · ${boat.presetName}`
      : ''
    phasePill.textContent = `${phasePillText(rendererPath)} · ${weather.tierName} ${weather.stormIndex.toFixed(0)} · ${fps.toFixed(0)} fps${drive}`
  }

  renderer.setAnimationLoop(() => {
    const rawDt = clock.getDelta()
    const dt = Math.min(rawDt, 0.1)
    const t = clock.elapsedTime

    applyWeather(dt, t)
    water.update(dt)
    clouds.update(dt)
    boat.update(dt, driveMode ? input : null)
    effects.update(dt)

    if (driveMode) {
      boat.driveCamera(camera, dt)
    } else {
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
    }

    post.render()

    pillTimer += rawDt
    if (pillTimer > 1) {
      pillTimer = 0
      pill.update()
    }

    fpsAccum += rawDt
    fpsFrames++
    if (fpsAccum >= 0.5) {
      fps = fpsFrames / fpsAccum
      fpsAccum = 0
      fpsFrames = 0
      updatePill()
    }
    governor.update(rawDt, fps)

    if (!firstFrameShown) {
      firstFrameShown = true
      phasePill.hidden = false
      console.info(`HashLake · renderer path: ${rendererPath}`)
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
