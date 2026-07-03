# HashLake Codex - Claude Fable Master Build Brief

This document is the all-in master instruction packet for rebuilding HashLake Codex from scratch as a better, cleaner, more beautiful, more deliberate version of the project.

It is written for Claude/Fable or another highly capable coding and visual AI that can take a complete product brief, infer implementation details, and produce a polished application. The purpose is not to recreate every tactical mistake, phase number, zone argument, or failed low-poly experiment. The purpose is to transmit the full mission, the art direction, the functional surface, the engineering contracts, the user experience, and the hard lessons learned from a long build process.

The target is a living, playable, data-reactive Bitcoin alpine lake artwork.

The output should be a browser app that is beautiful to watch, fun to drive, technically stable, zero-cost to operate, and emotionally distinctive.

## 1. Project Identity

Name: HashLake Codex

Alternate concept names:

- HashLake
- Bitcoin Lake
- Bitcoin weather lake
- Living Bitcoin lake
- HashLake Codex physics plus HashLake3 procedural art spirit

Core idea:

HashLake is a cinematic alpine lake where Bitcoin network and market conditions become weather, water, atmosphere, local events, and subtle UI signals. The user can simply look at it like living wall art, or press Drive Mode and pilot a small wooden boat around the lake.

The experience should feel like:

- A beautiful alpine lake scene.
- A living Bitcoin signal surface.
- A small playable boating world.
- A premium ambient dashboard.
- A mysterious, calm, slightly magical object.
- A place the user wants to leave open on a screen.

The app is not a trading terminal. It is not a game only. It is not a dashboard only. It is a playable generative tableau where Bitcoin activity changes the world.

## 2. One-Sentence Product Vision

Build a high-quality Three.js/Vite/TypeScript web app where a cinematic alpine lake reacts to live zero-cost Bitcoin data through weather, water, whale splashes, block pulses, fog, UI signals, and a smooth locked-camera boat Drive Mode.

## 3. Highest Priority Outcome

The most important outcome is the feel:

The user should load the site and immediately see a polished, reflective alpine lake with beautiful water, lush forest, distant mountain drama, a small boat, a quiet Bitcoin pill, and a sense that the world is alive.

Then they should press `X`, drive the boat, and think:

This feels good.

Then they should press `D`, test Bitcoin and weather events, and see that the lake responds visibly without becoming cluttered or noisy.

Then they should press `L`, understand the legend, and realize the whole thing is a Bitcoin weather artwork.

## 4. Current Inspiration Assets

Use these local reference files as the visual north stars:

- `references/000_INSPIRATION.jpg`
- `references/Serene.png`
- `references/Inspiration 2.PNG`
- `references/Uneasy.png`
- `references/Volatile.png`
- `references/Storm.png`
- `references/Apocalyptic.png`
- `references/Dashboard.png`
- `references/HashLake Legend.JPG`
- `references/HashLake Pill.JPG`
- `references/Hashlake1.png`
- `references/HashLake3-reference/`

Do not commit or publish `references/` unless explicitly approved. These files are private creative references.

### 4.1 Primary Visual Reference: `000_INSPIRATION.jpg`

This is the main emotional and visual north star.

What it teaches:

- Water is the hero.
- The lake is glossy, reflective, deep, and detailed.
- The water is not flat cyan, not black, not a debug plane.
- The boat is centered enough to matter but not so big that it kills the landscape.
- The mountain range has real rocky verticality, warm highlights, dark cuts, and scale.
- Trees are varied, tall, natural, and clustered, not toy cones.
- Shoreline is alive: rocks, grasses, conifers, transitions, reflections.
- The scene has depth: water foreground, shoreline, forest, mountain base, hero peaks, sky.
- Light is warm and premium, even when moody.
- Reflections make the scene feel expensive.

The final app does not have to copy the photo exactly, but it must borrow its feeling: alpine, cinematic, reflective, lush, grounded, grand.

### 4.2 Secondary Composition Reference: `Inspiration 2.PNG`

This image is important for layout and scene architecture.

What it teaches:

- The lake should not feel trapped inside a fake bowl or ring wall.
- There should be usable land between lake and mountains.
- Trees should occupy broad land shelves and climb toward mountains.
- The mountains should sit in the background as destination and drama, not as a hard border hugging the water.
- The scene reads better as:
  water -> shoreline -> meadow/forest land -> rising foothills -> hero mountains -> sky.
- The land around the lake should feel traversable and organic, not like stacked rings.

This reference should guide how to solve the old "front mountain ring" problem. Avoid a black wall or quarter-pipe ring. Use rising land, forest, and foothills instead.

### 4.3 Serene Reference: `Serene.png`

Use this for the calm, heavenly state:

- Warm sun.
- Blue sky.
- Puffy clouds.
- Beautiful reflective water.
- Crisp mountain detail.
- Green, readable forests.
- Premium, magical calm.

### 4.4 Weather References

Use `Uneasy.png`, `Volatile.png`, `Storm.png`, and `Apocalyptic.png` to define mood progression.

The weather should change the scene meaningfully:

- Calm is beautiful and alive.
- Uneasy is muted and windier.
- Volatile is darker and more active.
- Storm is dramatic with rain, darkness, rougher water, and lightning.
- Apocalyptic is black/red, fire-weather, intense, and rare.

The storm should not merely darken a CSS overlay. It should visibly alter sky, water, clouds, wind, fog, lighting, and boat instability.

### 4.5 Dashboard Reference: `Dashboard.png`

Use this for Debug Mode tone:

- Dark translucent card.
- Metric tiles.
- Calm technical layout.
- Fable-style dashboard aesthetic.
- Status rows with dots.
- Manual overrides.
- FPS and telemetry.

Debug should be useful but not ugly. It should not strobe.

### 4.6 HashLake3 Reference Source

The local `references/HashLake3-reference/` source is important as a procedural art and effects reference.

Use it as inspiration for:

- Sky.
- Water.
- Terrain.
- Forest.
- Boat.
- Effects.
- Captions/toasts.
- Data/event architecture.

Do not blindly copy its data sources. HashLake3 used some data patterns that may include CoinGecko or other sources not allowed in HashLake Codex. Port art/effect ideas, not forbidden data dependencies.

## 5. Non-Negotiable Product Requirements

These are mandatory.

### 5.1 Immediate Render

The app must render immediately.

No blank screen.

If WebGL fails, show a graceful, styled fallback in the same premium visual language.

If data fails, use cache or placeholder values and keep rendering.

If optional visuals fail, fallback to native/procedural visuals and keep rendering.

### 5.2 Build

Use:

- Vite.
- TypeScript.
- Three.js.
- `npm run dev`.
- `npm run build`.
- `npm run preview`.

`npm run build` must pass.

The app must work on GitHub Pages under:

`https://krushinski.github.io/HashLakeCodex/`

If using Vite, set base path:

`/HashLakeCodex/`

### 5.3 Zero-Cost Data Policy

No paid APIs.

No API keys.

No bearer tokens.

No authenticated providers.

No CoinGecko runtime calls.

No Sketchfab, Poly Haven, Rodin, Hunyuan, Hyper3D, or paid asset/runtime services unless explicitly approved by the user.

Allowed data sources:

- Coinbase Advanced Trade public WebSocket for BTC-USD price/market heartbeat:
  - `wss://advanced-trade-ws.coinbase.com`
  - Channels may include `ticker_batch` and `heartbeats`.
  - No account, no key, no secret.
- mempool.space public REST and WebSocket:
  - fees.
  - mempool count.
  - recent transactions.
  - latest blocks.
  - difficulty adjustment.
  - block websocket.
  - no key.
- Local browser cache through `localStorage`.

If any provider changes terms or appears to require payment/authentication, stop and alert the user immediately.

### 5.4 Preserve Performance

The experience must remain smooth enough to drive.

Use:

- Instancing.
- Merged geometry.
- Object pools.
- Bounded particle counts.
- Quality presets or an internal quality governor.
- A single efficient water surface.
- No broad per-frame DOM work.
- No expensive unbounded procedural regeneration in the render loop.

Do not use full-scene reflection render targets by default unless proven safe and gated.

### 5.5 No Clutter

Do not add visible graphics selectors, debug-only visual modes, water mode dropdowns, or noisy UI clutter.

The user-facing app should be quiet and premium.

Controls and diagnostics should exist, but they should be hidden or subtle unless requested.

### 5.6 Mobile Works

The site must be usable on mobile.

Mobile must have:

- Drive button.
- Debug button.
- Legend button.
- Touch drive controls or touch/hold steering.
- No camera spin from touch in Drive Mode.
- No page zoom/scroll jank during driving.
- Stable, non-nauseating motion.

### 5.7 No Git/Repo Pollution

Do not commit:

- `node_modules/`.
- `dist/`.
- `references/`.
- `artifacts/`.
- random screenshots unless explicitly approved.
- temp files.
- large unapproved assets.

## 6. Core Modes

HashLake has two primary user modes.

### 6.1 Frame Mode / Tableau Mode

This is the default wall-art mode.

The boat sits in the lake.

The user sees a beautiful scenic composition.

The app continues updating weather, Bitcoin data, water, sky, and effects.

Features:

- Gentle mouse/touch look-around.
- Look-around must be clamped so unfinished edges or broken scene areas are not visible.
- `C` cycles scenic/tableau camera presets.
- `R` resets to saved/default composition.
- Last saved tableau may restore from localStorage.
- Frame Mode is where the scene should feel like a beautiful background or living painting.

Frame camera presets should include:

- Hero Profile Low.
- Wide Reflection or Helicopter Truth View.
- Three-Quarter Boat Portrait.
- Cove / Environment Shot.

These are not Drive camera presets. They are presentation shots.

They should frame the current boat position and orientation.

They should not drift nauseatingly.

They should preserve manual look-around after use.

### 6.2 Drive Mode

Activated with `X`.

Drive Mode is hidden/fun mode where the user pilots the boat around the lake.

This is one of the app's most important successes. Preserve it.

Drive Mode must feel:

- Smooth.
- Stable.
- Cinematic.
- Controllable.
- Water-resistant.
- Fun.
- Not twitchy.
- Not seasick.

#### 6.2.1 Drive Controls

Desktop:

- `X`: toggle Drive Mode.
- Up Arrow: accelerate forward.
- Down Arrow: brake first, then reverse after near-stop.
- Left/Right Arrows: steer the boat only.
- Shift: boost.
- Ctrl+Shift+Up or equivalent: super boost.
- Space: anchor/stabilize/hard brake.
- `C`: cycle hard-locked Drive camera presets.
- `Enter`: save current boat position, rotation, camera preset, and camera distance as the new default tableau.
- `Esc`: exit Drive Mode without saving.
- `R`: reset camera/view.

Mobile:

- Drive button toggles Drive Mode.
- Touch/hold upward throttles forward.
- Touch angle left/right steers.
- Brake/anchor must be available.
- Touch input must never rotate the camera.
- Touch input must never spin the boat.

#### 6.2.2 Drive Physics Contract

The boat heading is the source of truth.

Forward means bow-forward.

The bow must always lead.

Movement, visual rotation, wake direction, and camera heading must agree.

Do not allow:

- Frisbee spin.
- Camera-assisted turning.
- Boat visual rotation independent of physics heading.
- Forward input rotating the boat by itself.
- Touch-driven camera rotation.
- World/scene rotation in Drive Mode.

Steering:

- Left/right should create smooth course corrections.
- Holding left/right creates arcing turns.
- High speed turns are wider and smoother.
- Low speed turns are more responsive.
- Water resistance limits sharp snapping.
- No 90-degree instant turns.

Braking:

- Off-throttle natural braking should be strong enough that the user does not need reverse to slow down.
- Down arrow brakes first.
- Reverse engages only after near-stop.
- Space anchors hard.

Speed:

- Normal Up speed around 52.
- Shift boost around 100.
- Ctrl+Shift/super boost around 120.
- Do not show 100 unless actual speed is near 100.

#### 6.2.3 Drive Camera Contract

Drive camera must be hard locked to the boat.

No Drive Mode:

- swivel.
- pan.
- orbit.
- free-look.
- touch-driven camera.

Camera should:

- follow boat heading.
- sit above and behind.
- show whole boat.
- show wake.
- show lake ahead.
- use damping.
- avoid clipping through boat or water.
- make forward direction readable.

Drive camera presets can include:

- Chase.
- Low Chase.
- High Map.
- OJ Mode.
- Vice City.

Even when cycling presets, Drive camera remains hard locked. `C` in Drive Mode is not the same as `C` in Frame Mode.

#### 6.2.4 Lake Boundaries

The boat must stay inside the lake.

If it reaches the edge:

- slow it down.
- gently push or turn it back.
- prevent driving into void.

Boundaries should be visually disguised by shore, fog, forest, mountains, reeds, and geography.

## 7. The Visual North Star

The scene should not look like a debug toy world.

It should look like a stylized but premium alpine environment.

The art direction is:

- Cinematic.
- Mysterious.
- Premium.
- Reflective.
- Alpine.
- Lush.
- Moody.
- Warm when serene.
- Ominous when stormy.
- Beautiful enough to leave open as ambient art.
- Fun enough to drive around.

Avoid:

- Toy cone trees.
- Simple green ovals.
- Low-poly debug triangles.
- Flat painted ground ribbons.
- Circular/snowglobe lake.
- Fake ring mountains hugging the lake.
- Floating mountains.
- Glass mountain panes.
- Zebra stripe mountains.
- Water-colored land leaks.
- Black tile blobs.
- Gray triangles around sandbars.
- Hidden under-lake land disks.
- Fake treeline reflection planes.
- Full-world filler planes showing through.
- Giant dark walls.
- One-note color palettes.
- Excessive purple/blue gradients.
- UI clutter.

## 8. Ideal Scene Composition

From the main boat/drive view, the eye should read:

1. Beautiful water in front.
2. Small boat as the subject.
3. Natural shoreline.
4. Grasses, rocks, reeds, beach pockets.
5. Readable foreground and midground conifers.
6. Darker, denser forest mass farther back.
7. Rising land/foothills.
8. Hero mountain range behind.
9. Sky and weather.

It should not read:

1. Water.
2. Shore.
3. Flat rings.
4. Black wall.
5. Floating mountains.
6. Sky gap.

The land around the lake should feel like a real alpine place:

- shore pockets.
- wet edges.
- grass shelves.
- meadow openings.
- forest floor.
- tree clusters.
- slope climb.
- mountain base.

The far mountains should be the hero backdrop, not a wall pressed against the lake.

## 9. Water Requirements

Water is the focal visual system of the whole project.

If only one thing looks great, it must be the water.

The water should be:

- Deep.
- Glossy.
- Reflective.
- Alive.
- Textured.
- Premium.
- Subtle when calm.
- Animated when windy.
- Rough when stormy.
- Readable in Drive Mode.
- Readable in scenic cameras.
- Supportive of wake, ripples, and splashes.

### 9.1 Calm Water

Calm/serene water should have:

- Deep blue/teal center.
- Softer turquoise shallows.
- Sky reflection.
- Treeline/mountain reflection impression.
- Subtle surface ripples.
- Small wind/breeze movement.
- Gentle glisten.
- No flat cyan.
- No black debug color.
- No sticker-like sandbar overlay.

### 9.2 Storm Water

Storm water should:

- darken.
- desaturate slightly.
- gain chop.
- gain stronger wind direction.
- show rougher surface.
- work with rain/lightning.
- remain readable.

Apocalyptic water can become violent and ominous, but avoid turning the whole lake into a black sheet.

### 9.3 Water Implementation Guidance

Use one main water mesh/material/shader as the default.

Avoid stacking many transparent full-lake overlay planes.

Avoid:

- full-world hidden land under the lake.
- cloud-shadow darkening planes.
- fake reflection planes.
- separate shallow cards around island/sandbar.
- transparent triangle fans.
- full planar reflection by default.

Preferred:

- one efficient shader surface.
- procedural normals/noise.
- Fresnel/glancing-angle reflection.
- depth/shallow blend.
- sandbar/island shallow influence inside shader.
- horizon color impression.
- subtle glint/specular.
- weather-driven uniforms.
- object pools for wake/splashes/rings.

Water should not create tile/chunk artifacts.

Water should not swallow wake blocks.

Water should not hide BTC rings.

Water should not leak outside the lake.

### 9.4 Wake

The boat has a rear motor.

Wake originates from the stern/motor only.

Wake style:

- white/blue-white foam.
- small 3D voxel/block-like chunks.
- slightly Minecraft-like but premium.
- V-shaped wake trail.
- follows actual boat path.
- more throttle means more wake.
- boost means brighter/larger/more intense wake.
- off throttle fades quickly.
- chunks fade/shrink/disappear.
- use pooling/instancing.

Wake never emits from the bow.

## 10. Terrain and Land Requirements

The land should be natural and dimensional.

Do not overfocus on the old zone/ribbon implementation. The lesson is this:

Every visible land layer must have a believable spatial purpose.

The land should feel like:

- waterline.
- wet sand.
- shore grass.
- raised bank.
- meadow.
- forest shelf.
- dark forest floor.
- rising foothill.
- mountain base.

But it should not be visibly drawn as hard rings.

### 10.1 Shoreline

Shoreline should:

- follow the organic lake shape.
- be smooth.
- be raised above water.
- have natural wet/dry transitions.
- include selective sand pockets.
- include rocks and reeds where appropriate.
- keep forest back from immediate waterline except intentional shoreline specimens.
- avoid jagged gray triangles.
- avoid broad beach around the whole lake.
- avoid water-colored land.

### 10.2 Sandbar and Island

Sandbar and island should feel premium and natural.

Sand:

- pale ivory/white dry top.
- subtle warm damp edge.
- smooth transition into turquoise shallows.
- no gray teeth.
- no detached rings.
- no sticker disc.
- no transparent overlay halos.

Island should feel grounded.

Sandbar should feel like shallow land under and above water.

### 10.3 Reeds, Rocks, Dock, Cove

Add memorable locations:

- Dock area.
- Reeds/wetland pocket.
- Sandbar.
- Island/rock cluster.
- Cove.
- Mountain/cove area.
- Rocky clusters.

These should be useful for navigation and composition.

Do not put 3D text labels in the scene. Labels belong in minimap/debug only.

## 11. Mountains

Mountains are emotionally central, but must be grounded and properly staged.

Use the Phase 98 mountain breakthrough as a directional reference if available:

`9c75617 Phase 98 hero mountain art pass`

The lesson from the build:

The best mountain direction was not "more low-poly blobs." It was a more art-directed hero mountain range with stronger granite, brighter highlights, dark cuts, and dramatic silhouette.

But the failures were also clear:

- mountains floated because their base did not meet the land.
- front rings looked like walls.
- quarter-pipe foothills looked artificial when no hero mountain sat behind them.
- pale slivers showed through when background surfaces were visible through gaps.
- glass/pane mountain systems looked terrible.
- zebra stripes on lower mountains looked fake and flickered.
- hidden flanges/skirts were hacks and not root fixes.

### 11.1 Mountain Target

Mountains should:

- sit behind forest and rising land.
- have grounded bases.
- be partially obscured by forest and foothills.
- have real ridgeline silhouette.
- show granite/rock contrast.
- have warm/cool highlight variation.
- include selective snow or light caps.
- include dark creases and gullies.
- be integrated with haze and sky.
- be majestic from low scenic cameras.
- be plausible from 360-degree drive views.

### 11.2 Mountain Composition

Avoid a ring of mountains hugging the lake.

Preferred composition:

- Lake in foreground.
- Meadow/forest land around lake.
- Trees climb away from shore.
- Foothills rise gradually.
- Hero mountains behind.

The north side can have the main dramatic mountain/backdrop composition.

The south/east/west sides still need beautiful distant land and hills, but not a weird repetitive mountain wall. They can use lower rolling terrain, forested slopes, atmospheric distance, and occasional far ridge hints.

### 11.3 Mountain Must-Nots

Do not use:

- vertical curtain panes.
- flat banner strips.
- black quarter-pipe wall.
- visible hard base line.
- bright sliver at mountain base.
- hidden skirt hack as the primary fix.
- long horizontal flat mountain bottom.
- toy blob hills.
- repeated zebra contour stripes.
- mountain geometry that intersects water.

If a mountain base has a visible gap, fix root geometry alignment and staging. Do not hide it with random filler.

## 12. Forest and Trees

Current weakness: toy trees.

Fable should not recreate the old cone/sphere tree language as final art.

The target is not photoreal individual trees, but a much more believable procedural forest.

### 12.1 Forest Composition

Use forest depth:

- sparse shoreline specimens.
- meadow trees and rocks near shore.
- clustered midground conifers.
- darker forest mass farther back.
- tree line climbing gently toward foothills.
- dense hero mountain-base forest.

Trees should form natural groups, not even spacing.

Forest should not be a row of props.

Forest should not be a black unreadable wall.

### 12.2 Tree Shape Requirements

Use multiple tree families:

- tall shoreline spruce/fir specimens.
- narrower young pines.
- mature conifers.
- broad evergreen clusters.
- background canopy masses.
- mountain-base dense conifer silhouettes.
- shrubs/understory.
- occasional deadwood or darker old-growth silhouettes if tasteful.

Avoid:

- identical cone fields.
- sphere-on-stick toy trees.
- huge mushroom blobs everywhere.
- needles so tall they look like spikes.
- dark props floating over ground.
- trees in water.

Trees should have:

- varied height.
- varied width.
- crown asymmetry.
- trunk visibility.
- layered branches.
- different green tones.
- clustered placement.
- deterministic placement.
- performance-safe instancing.

### 12.3 Forest Color

Use the inspiration references:

- foreground trees can catch warm light.
- mid trees should be lush green.
- far trees can be darker blue-green.
- mountain-base forest should be dense and shadowed.
- avoid pure black crush except silhouettes in storm/night.

## 13. Sky and Clouds

Sky should support the mood.

Serene:

- blue sky.
- warm light.
- soft clouds.
- heavenly but not cartoon.

Storm:

- darker sky.
- layered cloud cover.
- lightning.
- rain.
- tension.

Apocalyptic:

- black/red tint.
- fire weather/embers.
- dramatic but still composed.

Use Eastern Time baseline:

- morning/day/evening/night mood from America/New_York or America/Detroit logic.
- daylight can affect baseline lighting.
- storm darkness must override daylight.

Do not use sky cards or cloud planes that visibly intersect mountains.

Cloud shadows on water caused artifacts in previous attempts. If cloud influence touches water, make it very soft and shader-native, never a chunky overlay.

## 14. Weather Engine

The weather engine maps `stormIndex` 0-100 to visible world dials.

Storm stages:

- 0-20: Serene.
- 20-40: Slightly Uneasy.
- 40-60: Volatile.
- 60-80: Storm.
- 80-100: Apocalyptic.

Inputs that may influence stormIndex:

- BTC price trend.
- network health.
- fees.
- mempool congestion.
- data freshness/staleness.

Output dials:

- chop.
- wind.
- rain.
- lightning.
- skyDark.
- fog.
- fireWeather.
- boatInstability.
- cameraShake.
- ambientActivity.

### 14.1 Storm Darkness Rule

Storm darkness must be strong.

Use logic like:

`finalSkyDarkness = max(easternTimeDarkness, stormDarknessCurve)`

Storm darkness behavior:

- 0-30 mostly normal.
- 30-45 noticeable muted light.
- 45-60 sharp darkening.
- 60-80 heavy storm darkness.
- 80-100 black/red apocalyptic even during daytime.

Storm darkness should override daylight.

### 14.2 Stale Fog

Fog means stale or uncertain data.

Fog is not apocalypse.

If data is stale, heavy fog rolls over the scene.

Debug must show stale/fog status.

The app must keep rendering.

### 14.3 Manual Weather Events

Debug/manual controls:

- Crash: stormIndex sharply upward.
- Rally: stormIndex downward and optional distant fireworks.
- Gust: temporary wind/chop/camera/boat activity.
- Stale: fog rolling in.
- Resume Live: return to live/feed placeholder state.

## 15. Bitcoin Data and Meaning

HashLake should use live Bitcoin signals, but calmly.

### 15.1 Data Feeds

Feed rows and diagnostics should include:

- price.
- mempool.
- fees.
- whales.
- market.
- difficulty.
- hashrate.
- websocket.

Each feed should show:

- green/yellow/red dot.
- ok/stale/error/offline/reconnecting status.
- last updated timer like `0s ago`.
- source/live/cache state where useful.

### 15.2 Bottom-Left Bitcoin Pill

Keep a clean modern Bitcoin pill at bottom-left.

It should show:

- BTC price.
- fee rate, e.g. `1 sat/vB`.
- latest block height.
- live/cached/stale indicator.

It should be subtle, glassy, premium, and readable.

### 15.3 Mempool Whale Watch

Whale splashes should come from mempool.space recent transactions.

Endpoint:

- `https://mempool.space/api/mempool/recent`

Threshold:

- any transaction `>= 3 BTC`.

Polling:

- around 6 seconds, with graceful backoff if needed.

Rules:

- Deduplicate by txid.
- Do not replay cached whales.
- Keep seen txid set bounded.
- No constant strobing just because the listener is alive.
- No deprecated/broken language when there is simply no whale.

Status language:

- ok.
- cached.
- error.
- backoff.
- no recent whale.
- manual test.

Show:

- last poll age.
- last qualifying BTC amount.
- recent qualifying count.
- threshold `>= 3 BTC`.
- shortened last txid if available.

### 15.4 Whale Event Rules

Any recent transaction `>= 3 BTC` creates a local splash/ripple.

Scaling:

`scale = clamp(log10(BTC) / 1.2, 0.6, 2.6)`

Rules:

- 3-9.99 BTC: splash only, no caption by default.
- >=10 BTC: splash + caption.
- >=50 BTC: larger splash + caption.
- >=300 BTC: huge splash + caption.

Caption examples:

- `BTC moved - 12.4 BTC`
- `Large BTC move - 54 BTC`
- `Whale moved - 300 BTC`

No emojis.

No buy/sell coloring.

Neutral blue/white/teal splash language.

BTC amount must not affect:

- stormIndex.
- weather band.
- global screen color.
- fog.
- sky.
- post grade.
- stale state.

BTC amount may affect only:

- local splash height/size.
- ripple radius.
- ripple count.
- splash particle count.
- local water disturbance.
- optional boat bob if nearby.

### 15.5 New Block Event

New block event should:

- trigger from mempool.space block websocket or polling.
- show caption with block number.
- create teal/blue-white signal pulse.
- create ring wave.
- make boat lurch/hop briefly.
- be distinct from whale splash.
- not alter stormIndex.
- not darken screen.
- not clutter.

Manual Block button should trigger the same effect.

## 16. Event Effects

Use an event bus.

Supported event types:

- whale.
- newBlock.
- gust.
- crash.
- rally.
- stale.
- marketTick.
- marketHeartbeat.
- scenic.

Effects should be visible, pooled, and bounded.

### 16.1 Whale Splash / Fizzle

Effect target:

- local splash crown/spout.
- rising particles.
- falling/fading particles.
- expanding rings.
- fizzle out.
- proportional size.
- elegant, not messy.
- visible in Frame and Drive.
- never global color/weather.

Preserve land-aware ripple behavior:

- rings dissipate at shore, island, sandbar, and land masses.
- no rings through land.
- leading onion ring should be readable.
- ring should survive over dark/glossy water.

### 16.2 New Block Pulse

Effect target:

- sharper signal pulse.
- transparent fast ring.
- quick fade.
- boat hop.
- caption.
- no clutter.

### 16.3 Rally / Crash / Gust

Crash:

- stormIndex up.
- weather reacts.
- toast.

Rally:

- stormIndex down.
- distant fireworks or subtle celebratory sparkle.
- toast.

Gust:

- temporary wind/chop/wake/boat instability.
- toast.

Stale:

- fog.
- toast.

## 17. UI Surfaces

### 17.1 Loading Screen

Loading screen must be premium.

Text:

`Hashlake`

Subtitle examples:

- `Listening to the chain.`
- `Initializing Bitcoin weather.`
- `Reading the chain.`
- `Warming the lake.`

Style:

- near-black background.
- dark teal.
- muted cyan.
- white.
- faint green signal.
- subtle pulse/ripple/signal/waveform.
- no retro 1980s style.
- no clutter.

If WebGL fails, show the fallback in this same visual style.

### 17.2 Event Toasts / Captions

Toasts should be:

- glassy.
- calm.
- visible.
- readable.
- auto-fading.
- queued cleanly.
- no emojis.
- not behind canvas/debug/legend.

Placement:

- Drive Mode: bottom-right, preserving scenic view.
- Frame Mode: near top, aligned visually with phase/build pill level.

Do not cover the center composition.

### 17.3 Debug Mode

Press `D` toggles Debug.

Debug should be a Fable-style dashboard:

- dark translucent card.
- metric tiles.
- stormIndex section.
- contribution bars.
- weather dials.
- feed status rows.
- manual override area.
- FPS.
- active mode.
- boat speed.
- boat position.
- heading.
- camera preset.
- renderer/quality telemetry.
- tree/scenic asset status if useful.

Feed rows:

- price.
- mempool.
- fees.
- whales.
- market.
- difficulty.
- hashrate.
- websocket.

Manual override buttons:

- Crash.
- Rally.
- Whale.
- Block.
- Gust.
- Resume Live.
- Optional Whale test values: 3, 10, 50, 300, 1000 BTC.

Debug should not strobe.

Only pulse metrics on meaningful data changes or qualifying events.

Hidden Debug must not do expensive minimap/DOM work.

Visible Debug should update at a sane cadence.

### 17.4 Legend Mode

Press `L` toggles Legend.

Legend must explain:

- stormIndex stages.
- data/weather triggers.
- visual effects.
- controls.
- Bitcoin signal meanings.
- stale fog meaning.
- whale splashes are local only.

Controls shown:

- D = Debug.
- L = Legend.
- X = Drive Mode.
- F = Fullscreen.
- V = mountain truth/visual proof toggle if implemented.
- R = Reset camera.
- C = scenic cameras in Frame, drive presets in Drive.
- Arrow keys = Drive boat.
- Touch/drag = mobile drive.
- Shift = Boost.
- Ctrl+Shift = Super boost if implemented.
- Space = Anchor.
- Enter = Save tableau.
- Esc = Exit/cancel.

Legend must be readable on desktop and mobile.

### 17.5 Minimap

Include a debug/minimap surface.

It should show:

- lake outline.
- island.
- sandbar.
- dock.
- reeds.
- cove.
- boat direction.

Use this direction convention:

- North = top of minimap, primary mountain/backdrop side.
- South = bottom of minimap, foreground/sandbar/reeds side.
- East = right side of minimap, cove side.
- West = left side of minimap, dock/reeds side.

Do not place labels in the 3D scene. Labels belong in minimap/debug only.

## 18. Boat Visual

The boat should look like a small classic wooden speedboat/skiff.

It needs:

- clear pointed bow.
- clear stern.
- visible rear motor.
- wooden hull.
- warm wood tone.
- simple passenger/fisherman facing forward.
- optional flag/lantern details if tasteful.
- no oars unless they fit the final design.

Boat should be readable from:

- Drive camera.
- low scenic camera.
- helicopter/scenic camera.

The boat is not final photoreal, but it must be charming and clear.

## 19. Scenic Cameras

Provide two separate camera systems:

### 19.1 Frame/Scenic Cameras

Active outside Drive Mode.

`C` cycles:

- Hero Profile Low.
- Wide Reflection / Helicopter Truth View.
- Three-Quarter Boat Portrait.
- Cove / Environment Shot.

These should:

- frame current boat placement.
- favor sky/mountains/water.
- preserve boat as subject.
- feel art-directed.
- support wall-art viewing.
- show preset name briefly.
- persist last scenic preset in localStorage if appropriate.

### 19.2 Drive Cameras

Active only in Drive Mode.

`C` cycles hard-locked presets:

- Chase.
- Low Chase.
- High Map.
- OJ Mode.
- Vice City if useful.

They must never unlock the camera.

## 20. Persistence

Use localStorage for:

- saved tableau.
- saved boat position/yaw.
- saved Drive camera preset if useful.
- saved scenic camera preset.
- cached feed values.

Reload should restore the saved tableau if present.

If no saved tableau exists, use a strong default composition.

## 21. Recommended App Architecture

This is a suggested architecture. Fable can adapt, but the separation of concerns matters.

Suggested modules:

- `src/main.ts`
- `src/buildInfo.ts`
- `src/state/weatherEngine.ts`
- `src/state/liveBitcoinStore.ts`
- `src/state/eventBus.ts`
- `src/scene/createScene.ts`
- `src/scene/waterSystem.ts`
- `src/scene/terrainSystem.ts`
- `src/scene/forestSystem.ts`
- `src/scene/effects.ts`
- `src/scene/lakeMap.ts`
- `src/scene/artDirection.ts`
- `src/scene/postSystem.ts`
- `src/scene/rendererTelemetry.ts`
- `src/ui/debugPanel.ts`
- `src/ui/legendPanel.ts`
- `src/ui/eventToast.ts`
- `src/ui/mobileControls.ts`
- `src/styles.css`

Keep:

- weather state separate from Bitcoin data.
- effects separate from global weather.
- Drive physics separate from camera and rendering.
- data source logic separate from UI.
- visual systems modular enough to replace.

## 22. Quality and Performance

Use internal quality modes or a governor:

- Performance.
- Balanced.
- Scenic.

The user should not be forced to choose manually unless needed. The app may downgrade internally if FPS is low.

Telemetry should include:

- FPS.
- frame time.
- pixel ratio.
- render scale.
- quality preset.
- renderer path.
- Three.js version.
- WebGL/WebGPU capability if relevant.
- tree counts.
- effect counts.
- water mesh count.
- asset status if optional assets are used.

Performance rules:

- Use instanced meshes for trees.
- Use pooled objects for foam/splashes/rings.
- Avoid per-frame allocations.
- Avoid heavy DOM updates.
- Avoid expensive full-screen passes by default.
- Avoid large textures unless explicitly approved.
- Avoid loading failures breaking boot.

## 23. GitHub Pages Deployment

If deploying to GitHub Pages:

- Vite base should be `/HashLakeCodex/`.
- Add GitHub Actions Pages workflow.
- Build with `npm run build`.
- Deploy from Actions.

GitHub Pages UI settings:

- Repository Settings.
- Pages.
- Build and deployment.
- Source: GitHub Actions.

## 24. Important Failure Lessons

These lessons matter because they cost many iterations.

### 24.1 Do Not Build a Fake Lake Stage

Do not use hidden full-world land under the lake.

Do not use giant underlay planes.

Do not use transparent water/shore cards.

Do not use fake reflection planes.

These caused:

- black blobs.
- gray triangles.
- water leaks.
- second-lake artifacts.
- pale slivers.
- shore mismatch.

### 24.2 Do Not Make Mountain Rings

A mountain wall hugging the lake looks fake and causes gaps.

Use:

- rising land.
- forest shelves.
- foothills.
- hero mountain range behind.

### 24.3 Do Not Solve Floating Mountains With Skirts

If a mountain floats, fix:

- base alignment.
- terrain continuity.
- camera staging.
- forest occlusion.
- geometry placement.

Do not just add a flange/skirt/sliver to hide it.

### 24.4 Do Not Recreate Toy Trees

Old cone/sphere trees were useful as placeholders, not final art.

Use asset-like procedural tree forms:

- layered branches.
- varied crowns.
- trunks.
- clusters.
- canopy massing.
- foreground/midground/background differences.

### 24.5 Do Not Make Debug Strobe

Listeners can be alive without flashing UI.

Only meaningful changes should pulse.

### 24.6 Do Not Let BTC Whales Change Weather

Whales are local splashes.

Weather is controlled by stormIndex/feed contributions/manual controls.

Keep those systems separate.

### 24.7 Do Not Over-Strictly Copy the Old Implementation

The old project contains many good systems, but also many repair scars.

Build the desired outcome, not every old workaround.

## 25. What Must Feel Magical

These are the moments that make the project special:

1. The first load feels intentional and premium.
2. The water immediately looks alive.
3. The boat feels stable and fun to drive.
4. The camera makes driving readable.
5. A whale transaction creates a local splash in the lake.
6. A new block sends a clean pulse through the water.
7. Crash/Rally/Gust visibly change the weather.
8. Stale data rolls in as fog.
9. The bottom BTC pill quietly anchors the live data.
10. Debug reveals a technical dashboard without ruining the art.
11. Legend explains the Bitcoin weather world.
12. Scenic cameras produce background-worthy compositions.
13. StormIndex 80+ transforms the world dramatically.
14. Mobile Drive Mode works without a keyboard.
15. The scene feels like a place, not a prototype.

## 26. Detailed Acceptance Checklist

### 26.1 Build and Boot

- `npm run build` passes.
- app renders immediately.
- no blank screen.
- fallback screen works if WebGL unavailable.
- GitHub Pages deployment works.

### 26.2 Visual

- Water is clearly the hero.
- Water is glossy, textured, reflective, alive.
- Shoreline is natural and smooth.
- Sandbar/island are pale/white premium sand.
- No gray triangle halos.
- Forest is lush and not toy-like.
- Trees are varied and planted into terrain.
- Mountains are grounded and beautiful.
- No floating mountain gaps.
- No pale sliver at mountain base.
- No second lake.
- No fake ring wall.
- No glass panes.
- No zebra stripes.
- Scene has foreground/midground/background depth.
- Inspiration images are visibly honored.

### 26.3 Drive

- `X` enters Drive Mode.
- Up accelerates forward.
- Down brakes before reverse.
- Left/right steer boat only.
- Shift boost works.
- Super boost works if implemented.
- Space anchors.
- `C` cycles Drive presets without unlocking camera.
- `Enter` saves tableau.
- `Esc` exits without saving.
- `R` resets.
- Bow always leads.
- Wake emits from stern.
- Camera stays hard locked.
- Mobile Drive works smoothly.

### 26.4 Data

- BTC price populates or uses cache.
- fees populate or use cache.
- mempool count populates or uses cache.
- block height populates or uses cache.
- difficulty/hashrate populate or use cache.
- websocket status visible.
- no API keys.
- no CoinGecko.
- no paid APIs.
- data failures do not stop render.

### 26.5 Events

- 3 BTC manual whale creates splash only.
- 10 BTC creates splash + caption.
- 50 BTC creates larger splash + caption.
- 300 BTC creates huge splash + caption.
- BTC amount does not change weather/sky/fog.
- New Block creates pulse, caption, boat hop.
- Crash changes storm.
- Rally calms storm.
- Gust increases wind/chop temporarily.
- Stale creates fog.
- Resume Live returns to feed state.

### 26.6 UI

- Bottom-left BTC pill works.
- Debug opens with `D`.
- Legend opens with `L`.
- Mobile buttons exist.
- Toast placement changes by mode.
- Debug is calm, readable, not strobing.
- Legend readable desktop/mobile.
- Loading screen premium.

### 26.7 Performance

- FPS acceptable in Frame Mode.
- FPS acceptable in Drive Mode.
- no severe mobile risk.
- no unbounded particle growth.
- no excessive draw calls.
- no per-frame geometry generation.
- no giant hidden meshes doing nothing.

## 27. Suggested Development Order for a One-Shot Build

If building from scratch, prioritize:

1. Vite/TypeScript/Three.js shell with immediate render and styled fallback.
2. Lake, water shader, sky, and basic terrain composition.
3. Boat and Drive Mode with hard-locked camera.
4. Weather engine and Debug/Legend UI.
5. Bitcoin zero-cost data store and bottom pill.
6. Event bus, whale splashes, New Block pulse, toasts.
7. Scenic cameras and saved tableau.
8. Forest/mountain art pass guided by references.
9. Mobile controls.
10. Performance governor and polish.
11. GitHub Pages workflow.

Do not leave water to the end. Water is central.

Do not leave Drive Mode to the end. Drive feel is central.

Do not leave art direction as generic low-poly. The whole point is beauty.

## 28. Tone and Text

Use restrained, premium text.

Good:

- `Hashlake`
- `Listening to the chain.`
- `New block found - #955994`
- `BTC moved - 12.4 BTC`
- `Large BTC move - 54 BTC`
- `Whale moved - 300 BTC`
- `Stale feed - fog rolling in`
- `Storm front forming`
- `Network calm`

Avoid:

- emojis.
- jokey captions.
- aggressive trading language.
- "BUY" or "SELL".
- cluttered explanations in the scene.

## 29. Naming and Current Reference Points

If using the existing repo as context:

- Current package: `hashlake`.
- Current latest marker at time of this brief: `Hashlake Phase 127`.
- Important mountain art reference commit: `9c75617 Phase 98 hero mountain art pass`.
- Latest pushed runtime checkpoint before this brief: `f4047c3 Phase 127 terrain tree depth tune`.

These are references only. A new build should not copy all old tactical code or failed experiments.

## 30. Final Creative Direction

Build HashLake as if it is a premium living artwork first, and a technical demo second.

The scene should be beautiful even before the user touches anything.

The water should invite staring.

The boat should invite driving.

The Bitcoin data should feel like weather, not a spreadsheet.

The UI should feel like an instrument panel for a mysterious lake, not a web dashboard pasted over a game.

The mountains should feel far, grounded, and majestic.

The forest should feel alive and layered.

The shore should feel touchable.

The weather should feel meaningful.

The whole experience should feel like:

Someone built a small alpine world where the Bitcoin network breathes through the lake.

That is the project.

