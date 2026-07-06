import './styles.css'
import * as THREE from 'three/webgpu'
import { pass, renderOutput } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { phasePillText } from './buildInfo'
import { SkySystem } from './scene/skySystem'
import { WaveField } from './scene/waveField'
import { LAKE_SCALE, waterDepth } from './scene/lakeMap'
import { WaterSystem } from './scene/waterSystem'
import { TerrainSystem } from './scene/terrainSystem'
import { ForestSystem } from './scene/forestSystem'
import { CloudSystem } from './scene/cloudSystem'
import { BoatSystem, type DriveInput } from './scene/boatSystem'
import { EffectsSystem } from './scene/effects'
import { RainSystem } from './scene/rainSystem'
import { LightningSystem } from './scene/lightningSystem'
import { FireSkySystem } from './scene/fireSkySystem'
import { WakeSystem } from './scene/wakeSystem'
import { LakeDressing } from './scene/dressing'
import { ProWater } from './scene/proWater'

/** Licensed Water Pro + Sky Pro pipeline (gitignored libs, local builds). */
const PREFER_PRO = true
import { Speedometer } from './ui/speedometer'
import { LofiRadio } from './core/lofiRadio'
import { Minimap } from './ui/minimap'
import { FarRanges } from './scene/terrainSystem'
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
// v4: the 1.3× intimacy verdict re-shaped the world again — the key bump
// retires stale poses (a saved tableau was ALSO hiding the new opening
// hero shot on the user's machines; the afloat guard catches the rest)
const TABLEAU_KEY = 'hashlake.tableau.v4'

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
  sunIntensity: [2.2, 1.9, 1.4, 0.85, 0.55],
  fogColor: [0xcfdad2, 0xb9c4bf, 0x8a949a, 0x525c63, 0x4a2a20],
  // anchored at the 2.2× world (far shore ~4.5 km) and rescaled below by
  // FOG_WORLD — Serene keeps the far shore visible through alpine haze,
  // Apocalyptic still closes the world down
  fogNear: [2700, 2400, 1900, 1450, 1100],
  fogFar: [9000, 8200, 6900, 5400, 4500],
}
/** Scene-fog distances ride the world size (anchors tuned at 2.2×) —
 *  floored at 0.55: the atmosphere doesn't shrink with the map. */
const FOG_WORLD = Math.max(0.55, LAKE_SCALE / 2.2)

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
  // Water Pro's WebGL 2 fallback path is untuned and reads as a different,
  // broken world (dithered sky, wrong colors). Non-WebGPU browsers — old
  // phones, insecure http origins — get the round-5 legacy stack instead.
  const USE_PRO = PREFER_PRO && rendererPath === 'WebGPU'

  // Under Water Pro the per-pixel cost dominates. PIXEL BUDGET (§user:
  // 11 fps on the 4K desktop): cap the render at ~2.4 MP — about
  // 1080p-and-a-half — and let the browser upscale. Slight softness on
  // huge monitors buys the frame rate back; small screens are untouched.
  const PIXEL_BUDGET = 1.8e6
  const applyPixelBudget = () => {
    const base = Math.min(window.devicePixelRatio, USE_PRO ? 1.0 : 1.5)
    const px = window.innerWidth * window.innerHeight * base * base
    renderer.setPixelRatio(
      px > PIXEL_BUDGET ? base * Math.sqrt(PIXEL_BUDGET / px) : base,
    )
  }
  applyPixelBudget()
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.5
  appHost.appendChild(renderer.domElement)

  // ---------- scene ----------
  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0xcfdad2, 2700 * FOG_WORLD, 9000 * FOG_WORLD)

  // legacy CPU wave field stays: boat steering approximations, splash
  // seating, buoys — the VISUAL water is Water Pro's FFT when USE_PRO
  const waveField = new WaveField(20)
  const sky = USE_PRO ? null : new SkySystem(renderer, scene)
  const water = USE_PRO ? null : new WaterSystem(scene, waveField, sky!)
  const terrain = new TerrainSystem(scene)
  const forest = new ForestSystem(scene)
  const forestReady = forest.load()
  forestReady.catch((err) => console.error('forest load failed:', err))
  const clouds = USE_PRO ? null : new CloudSystem(scene)
  const boat = new BoatSystem(scene, waveField)
  const effects = new EffectsSystem(scene, waveField, boat)
  const rain = new RainSystem(scene, renderer)
  const lightning = new LightningSystem(scene)
  const fireSky = new FireSkySystem(scene)
  const wake = USE_PRO ? null : new WakeSystem(scene, waveField, boat)
  const dressing = new LakeDressing(scene, waveField)
  dressing.load().catch((err) => console.error('dressing load failed:', err))
  const speedo = new Speedometer()
  const lofi = new LofiRadio()
  const farRanges = new FarRanges(scene)

  sky?.bakeEnvironment()

  // ---------- data + weather ----------
  const store = new LiveBitcoinStore()
  store.start()
  const weather = new WeatherEngine(store)

  // ---------- camera ----------
  const camera = new THREE.PerspectiveCamera(
    46,
    window.innerWidth / window.innerHeight,
    0.3,
    24000,
  )
  // Water Pro + Sky Pro — created after the camera exists; the boat
  // registers with buoyancy/wake once its GLB is in
  const pro = USE_PRO ? await ProWater.create(renderer, scene, camera) : null
  // weave Water Pro's animated caustics into the terrain's underwater
  // bed shader — before the first frame so compileAsync sees the final
  // node graph (its own procedural floor stays hidden; our bed IS the
  // floor)
  // ?nocaustics for the fps A/B — the pattern evaluates on every terrain
  // fragment (the depth mask only hides it visually)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (pro && !new URLSearchParams(location.search).has('nocaustics'))
    terrain.injectWaterNodes((pro.water.floor as any).caustics)
  // scene-color pass diet: far dressing pays full vertex cost in the
  // refraction re-render for zero visible contribution
  if (pro) {
    pro.excludeFromSceneColor(farRanges.mesh)
    forestReady
      .then(() => pro.excludeFromSceneColor(forest.group))
      .catch(() => {})
  }
  boat
    .load()
    .then(() => pro?.attachBoat(boat))
    .catch((err) => console.error('boat load failed:', err))

  // Opening shot (§user, last-day): the hero fills the frame — a low
  // three-quarter portrait from the boat's starboard-aft quarter, gaze
  // carrying past the bow to the hero range. No more ant-on-the-water.
  // look AT the boat (dead center) from its starboard-aft quarter — the
  // north range fills the frame behind it
  const camRig = {
    pos: new THREE.Vector3(40 * LAKE_SCALE + 14, 4.2, 420 * LAKE_SCALE + 14),
    look: new THREE.Vector3(40 * LAKE_SCALE, 1.8, 420 * LAKE_SCALE),
    drift: 1,
  }
  const curLook = new THREE.Vector3().copy(camRig.look)
  const tmpTarget = new THREE.Vector3()
  const tmpDir = new THREE.Vector3()
  const tmpFocus = new THREE.Vector3()
  let baseExposure = 0.5
  // restore saved tableau
  try {
    const saved = JSON.parse(localStorage.getItem(TABLEAU_KEY) ?? 'null')
    // a tableau saved at one LAKE_SCALE can sit on dry land at another
    // (?scale= probe laps) — only restore poses that are still afloat
    if (saved && waterDepth(saved.x ?? 0, saved.z ?? 0) > 1) {
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

  // Exiting drive keeps the tableau WITH the boat — a 3/4 pull-back shot
  // from wherever the run ended, never a glide home to the spawn point.
  const exitDriveTableau = () => {
    const dx = Math.sin(boat.heading)
    const dz = -Math.cos(boat.heading)
    camRig.pos.set(
      boat.x - dx * 52 - dz * 20,
      11,
      boat.z - dz * 52 + dx * 20,
    )
    camRig.look.set(boat.x + dx * 30, 4, boat.z + dz * 30)
  }

  // ---------- post ----------
  const PipelineCtor =
    (THREE as unknown as { RenderPipeline?: typeof THREE.PostProcessing })
      .RenderPipeline ?? THREE.PostProcessing
  const post = new PipelineCtor(renderer)
  const scenePass = pass(scene, camera)
  const scenePassColor = scenePass.getTextureNode('output')
  if (pro) {
    // Water Pro's post stack (atmospheric fog, underwater, sun shafts)
    // wraps the scene, then our bloom rides on top. The PostProcessing
    // chain renders through non-MSAA intermediates, so hull/mast edges
    // alias raw and bloom amplifies the crawl into a fuzzy halo around
    // the hero boat (§user) — FXAA on the FINAL LDR output (after tone
    // mapping, hence outputColorTransform=false + manual renderOutput)
    // is the cheap cure.
    const waterOut = pro.water.postProcessing.buildNode(
      scenePass,
      scenePassColor,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any
    const withBloom = waterOut.add(bloom(waterOut, 0.09, 0.3, 1.45))
    post.outputColorTransform = false
    post.outputNode = fxaa(renderOutput(withBloom))
  } else {
    post.outputNode = scenePassColor.add(bloom(scenePassColor, 0.09, 0.3, 1.45))
  }

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
  const minimap = new Minimap(boat)
  debug.attachMinimap(minimap.el)

  // event toasts (§28 tone, Regalia cards)
  bus.on('whale', ({ btc }) => {
    if (btc >= 300)
      toast.show('Whale surfaced', 'whale', `**${fmtBtc(btc)} BTC** moved on-chain`)
    else if (btc >= 50)
      toast.show('Large move', 'whale', `**${fmtBtc(btc)} BTC** moved on-chain`)
    else if (btc >= 10)
      toast.show('BTC moved', 'whale', `**${fmtBtc(btc)} BTC** on-chain`)
  })
  bus.on('newBlock', ({ height }) => {
    if (height)
      toast.show('Block found', 'block', `**#${height.toLocaleString('en-US')}** sealed`)
  })
  bus.on('crash', () => toast.show('Crash warning', 'crash', 'storm front forming'))
  bus.on('rally', () => toast.show('Rally detected', 'rally', 'network calm returning'))
  bus.on('gust', () => toast.show('Gust incoming', 'gust', 'rolling across the lake'))
  bus.on('stale', () => toast.show('Stale feed', 'gust', 'fog rolling in'))
  bus.on('resumeLive', () => toast.show('Feed reconnected', 'feed', 'listening to the chain'))

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
    ultraBoost: false,
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
    if (e.key === 'z' || e.key === 'Z') input.ultraBoost = true
    if (e.code === 'Space') {
      input.anchor = true
      if (driveMode) e.preventDefault()
    }
    if (e.key === 'x' || e.key === 'X') {
      driveMode = !driveMode
      if (!driveMode) exitDriveTableau()
      toast.setMode(driveMode ? 'drive' : 'frame')
      speedo.setVisible(driveMode)
      updatePill()
    }
    if (e.key === 'm' || e.key === 'M') {
      toast.show(lofi.toggle() ? 'Lofi radio on' : 'Lofi radio off')
    }
    if (e.key === 'c' || e.key === 'C') {
      if (driveMode) {
        toast.show(boat.cyclePreset())
        updatePill()
      } else {
        frameIndex = (frameIndex + 1) % FRAME_PRESETS.length
        applyFramePreset(FRAME_PRESETS[frameIndex])
        toast.show(FRAME_PRESETS[frameIndex].name)
      }
    }
    if (e.key === 'd' || e.key === 'D') debug.toggle()
    if (e.key === 'l' || e.key === 'L') legend.toggle(weather.stormIndex)
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
      // R re-frames the OPENING hero shot around wherever the boat is now
      camRig.pos.set(boat.x + 14, 4.2, boat.z + 14)
      camRig.look.set(boat.x, 1.8, boat.z)
    }
    if (e.key === 'Escape' && driveMode) {
      driveMode = false
      exitDriveTableau()
      toast.setMode('frame')
      speedo.setVisible(false)
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
    if (e.key === 'z' || e.key === 'Z') input.ultraBoost = false
    if (e.code === 'Space') input.anchor = false
  })

  // ---------- frame-mode scenic presets (§19.1, C outside drive) ----------
  interface FramePreset {
    name: string
    off: [number, number, number]
    look: [number, number, number]
  }
  const FRAME_PRESETS: FramePreset[] = [
    { name: 'Wide Reflection', off: [0, 7.5, 85], look: [-20, 26, -1200] },
    { name: 'Hero Profile Low', off: [58, 2.6, 6], look: [0, 3, 0] },
    { name: 'Three-Quarter Portrait', off: [24, 5.5, 28], look: [0, 2.5, -12] },
    { name: 'Cove Shot', off: [175, 13, -55], look: [0, 6, 0] },
    // the same cove framing rotated a full 180° — looks back the other way
    { name: 'Cove Reverse', off: [-175, 13, 55], look: [0, 6, 0] },
    // close enough to enjoy the varnish (§user: none of the frame views
    // get near the boat's detail)
    { name: 'Deck Detail', off: [7.5, 2.4, 4.5], look: [0, 1.1, 0] },
    { name: 'Golden Close', off: [-6, 1.6, 7.5], look: [0, 1.3, 0] },
  ]
  let frameIndex = 0
  const applyFramePreset = (p: FramePreset) => {
    camRig.pos.set(boat.x + p.off[0], p.off[1], boat.z + p.off[2])
    camRig.look.set(boat.x + p.look[0], p.look[1], boat.z + p.look[2])
  }

  // ---------- frame-mode look-around (click-drag, §6.1 + user contract:
  // the drag ORBITS the boat, so the hero stays center-frame while you
  // swing around it) ----------
  let dragging = false
  const orbitStart = { px: 0, py: 0, yaw: 0, pitch: 0, radius: 60 }
  const orbitAnchor = new THREE.Vector3()
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (driveMode) return
    dragging = true
    orbitAnchor.set(boat.x, 2.5, boat.z)
    tmpDir.subVectors(camRig.pos, orbitAnchor)
    orbitStart.radius = Math.max(12, tmpDir.length())
    orbitStart.yaw = Math.atan2(tmpDir.x, tmpDir.z)
    orbitStart.pitch = Math.asin(
      THREE.MathUtils.clamp(tmpDir.y / orbitStart.radius, -1, 1),
    )
    orbitStart.px = e.clientX
    orbitStart.py = e.clientY
  })
  window.addEventListener('pointermove', (e) => {
    if (!dragging || driveMode) return
    const yaw = orbitStart.yaw - (e.clientX - orbitStart.px) * 0.0035
    const pitch = THREE.MathUtils.clamp(
      orbitStart.pitch + (e.clientY - orbitStart.py) * 0.0022,
      0.02,
      1.15,
    )
    const r = orbitStart.radius
    camRig.pos.set(
      orbitAnchor.x + Math.sin(yaw) * Math.cos(pitch) * r,
      orbitAnchor.y + Math.sin(pitch) * r,
      orbitAnchor.z + Math.cos(yaw) * Math.cos(pitch) * r,
    )
    camRig.look.set(orbitAnchor.x, orbitAnchor.y + 2, orbitAnchor.z)
  })
  window.addEventListener('pointerup', () => {
    dragging = false
  })

  new MobileControls(input, {
    toggleDrive: () => {
      driveMode = !driveMode
      if (!driveMode) exitDriveTableau()
      toast.setMode(driveMode ? 'drive' : 'frame')
      updatePill()
    },
    toggleDebug: () => debug.toggle(),
    toggleLegend: () => legend.toggle(weather.stormIndex),
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

    if (pro) {
      pro.applyWeatherRaw(t, d.skyDark)
      // Sky Pro's physical atmosphere sits ~2.5x dimmer through ACES than
      // the legacy Preetham dome at the same exposure
      baseExposure =
        lerpAnchors(TIER_VISUALS.exposure, t) * 2.5 * (1 - d.skyDark * 0.35)
    } else if (sky) {
      sky.sky.turbidity.value = lerpAnchors(TIER_VISUALS.turbidity, t)
      sky.sky.rayleigh.value = lerpAnchors(TIER_VISUALS.rayleigh, t)
      baseExposure =
        lerpAnchors(TIER_VISUALS.exposure, t) * (1 - d.skyDark * 0.35)
      sky.sunLight.intensity =
        lerpAnchors(TIER_VISUALS.sunIntensity, t) * (1 - d.skyDark * 0.6)
    }

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
    fog.near = lerpAnchors(TIER_VISUALS.fogNear, t) * staleCrush * FOG_WORLD
    fog.far =
      lerpAnchors(TIER_VISUALS.fogFar, t) * Math.max(0.22, staleCrush) * FOG_WORLD

    clouds?.setMood(d.skyDark, 1 + d.rain * 0.3)

    // env rebake at most every 4s, only when the tier band moved
    const band = Math.round(t * 4)
    if (sky && band !== lastBakedTier && now - lastBakeT > 4) {
      lastBakedTier = band
      lastBakeT = now
      sky.bakeEnvironment()
    }
  }

  // ---------- resize ----------
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    applyPixelBudget()
    renderer.setSize(window.innerWidth, window.innerHeight)
    // neither licensed lib watches the window; without this fan-out every
    // screen-space buffer and the sky's temporal history stay on the old
    // grid after a resize (permanent smear until reload)
    pro?.resize(window.innerWidth, window.innerHeight)
  })

  // ---------- debug handle ----------
  ;(window as unknown as Record<string, unknown>).__HL = {
    THREE,
    renderer,
    scene,
    sky,
    waveField,
    water,
    pro,
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

  // three r183 fires animation callbacks fire-and-forget: whenever the
  // buoyancy readback awaited inside pro.update outlasts one rAF
  // interval, TWO loop iterations interleave and presented frames
  // alternate between two boat/camera phase states — the "3 boats
  // ghosting" on turns, the mobile hat double-image, and a large share
  // of the drive jitter. The guard makes overlapping callbacks no-ops.
  let frameBusy = false

  // FRAME-PACING SURGERY (§user: 10 fps desktop): awaiting pro.update
  // inside the rAF callback gated PRESENTATION on the water's GPU
  // readback chain — every await that crossed a vsync boundary made the
  // next whole rAF tick a frameBusy no-op, quantizing ~20 real fps down
  // to ~10 presented. The water now updates fire-and-forget behind its
  // own reentrancy latch: every rAF presents, the water sim resolves at
  // its own cadence one frame late (its pose was already frame-late by
  // design). ?syncloop restores the old serialized loop for A/B.
  const asyncWater = !new URLSearchParams(location.search).has('syncloop')
  let waterBusy = false

  // vendor-recommended (docs/guide/basic-example): precompile the scene's
  // shaders before the first frame instead of hitching through async
  // pipeline compiles during the opening seconds
  try {
    await renderer.compileAsync(scene, camera)
  } catch {
    /* fall through — compiles lazily as before */
  }

  renderer.setAnimationLoop(async () => {
    if (frameBusy) return
    frameBusy = true
    const rawDt = clock.getDelta()
    const dt = Math.min(rawDt, 0.1)
    const t = clock.elapsedTime

    applyWeather(dt, t)
    water?.update(dt)
    // under Pro the legacy field still drives boat pitch/roll — but its
    // clock only ever ticked inside the legacy WaterSystem, so the boat
    // was scanning a FROZEN noise landscape at speed: frame-to-frame
    // attitude aliasing that only appeared while moving (drive jitter)
    if (!water) waveField.update(dt)
    clouds?.update(dt)
    boat.update(dt, driveMode ? input : null)
    effects.update(dt)

    // storm theater
    if (driveMode) tmpFocus.set(boat.x, 0, boat.z)
    else tmpFocus.copy(camRig.pos)
    rain.update(dt, tmpFocus, weather.dials.rain, weather.dials.wind)
    lightning.update(dt, weather.dials.lightning, boat.x, boat.z)
    fireSky.update(dt, weather.dials.fireWeather, tmpFocus)

    // drive feel
    wake?.update(dt)
    dressing.update()
    speedo.update(boat.speedMph)

    if (driveMode) {
      boat.driveCamera(camera, dt)
      // keep frame-mode look target primed so exit glides, not snaps
      curLook.set(boat.x, 8, boat.z)
    } else {
      // damped tableau camera — gives the smooth zoom-out when leaving
      // drive mode, and glides between presets / orbit-drag poses
      const blend = 1 - Math.exp(-dt * 2.2)
      // drift sway is sized for the km-long default gaze; near-orbit
      // framings need proportionally gentler breathing
      const drift =
        camRig.drift *
        Math.min(1, camRig.pos.distanceTo(camRig.look) / 400)
      tmpTarget.set(
        camRig.pos.x + Math.sin(t * 0.04) * 10 * drift,
        camRig.pos.y + Math.sin(t * 0.1) * 0.4 * drift,
        camRig.pos.z,
      )
      camera.position.lerp(tmpTarget, blend)

      tmpTarget.set(
        camRig.look.x + Math.sin(t * 0.03) * 14 * drift,
        camRig.look.y,
        camRig.look.z,
      )
      curLook.lerp(tmpTarget, blend)
      camera.lookAt(curLook)
    }

    // Water Pro AFTER boat + camera moves (vendor contract: its update
    // snaps the clipmap, anchors the wake/foam windows, and renders all
    // screen-space passes from the camera's CURRENT transform — running
    // it before the moves meant every pass lagged one frame behind)
    if (pro) {
      // sky ticks EVERY presented frame — its temporal cloud history
      // must track the live camera or fast moves stamp stale copies
      // across the frame (the "seeing triple" regression)
      pro.updateSky(dt)
      // proxy carries the hull footprint; Water Pro resolves its heave
      pro.boatProxy.position.x = boat.x
      pro.boatProxy.position.z = boat.z
      pro.setBoatSpeed(Math.abs(boat.speed))
      if (asyncWater) {
        // fire-and-forget behind the latch — presentation never waits
        if (!waterBusy) {
          waterBusy = true
          void pro
            .update(dt)
            .catch((err) => console.error('water update failed:', err))
            .finally(() => {
              waterBusy = false
            })
        }
      } else {
        await pro.update(dt)
      }
      // smooth the proxy's heave before the hull takes it — Water Pro's
      // own smoothing assumes 60Hz steps and passes jitter through at
      // 20fps (the resting-boat glitch); under asyncWater this reads the
      // most recently RESOLVED pose (one frame late by design)
      const prevHeave = boat.externalHeave ?? pro.boatProxy.position.y
      boat.externalHeave =
        prevHeave +
        (pro.boatProxy.position.y - prevHeave) * (1 - Math.exp(-dt * 8))
    }

    // "heavenly blinding" fix, round 3: heading dead south into the sun
    // still washed out at 0.48 — ease harder (legacy sky only; Sky Pro's
    // physical atmosphere doesn't blow out the same way)
    if (sky) {
      camera.getWorldDirection(tmpDir)
      const facing = Math.max(0, tmpDir.dot(sky.sunDirection))
      renderer.toneMappingExposure = baseExposure * (1 - facing * facing * 0.62)
    } else {
      renderer.toneMappingExposure = baseExposure
    }

    post.render()

    pillTimer += rawDt
    if (pillTimer > 1) {
      pillTimer = 0
      pill.update()
    }
    minimap.update()

    fpsAccum += rawDt
    fpsFrames++
    if (fpsAccum >= 0.5) {
      fps = fpsFrames / fpsAccum
      fpsAccum = 0
      fpsFrames = 0
      updatePill()
    }
    // Governor is legacy-only: under Pro it ratcheted pixelRatio toward
    // 0.5x forever (recovery needs 55fps — unreachable), overriding the
    // fixed 1.0 cap, and every step left the sky's temporal history on
    // the wrong grid (permanent cloud smear). Pro runs a FIXED ratio.
    if (!USE_PRO) governor.update(rawDt, fps)

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
    frameBusy = false
  })
}

boot().catch(showFallback)
