// Prep the Blender web-integration bakes for shipping (Renaissance pass).
//
// Reads assets-src/blender-export/bakes/*.png, writes web-ready WebP to
// public/assets/textures/. Run from the repo root:
//
//   node tools/prep-bakes.mjs
//
// The pano crop rows printed at the end are baked into panoBackdrop.ts as
// the sphere-band angles — re-run this script and update those constants
// together if the pano bake ever changes.
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const BAKES = 'assets-src/blender-export/bakes'
const OUT = 'public/assets/textures'
await mkdir(OUT, { recursive: true })

const report = []
async function emit(pipeline, name, opts) {
  const out = path.join(OUT, name)
  const info = await pipeline.webp(opts).toFile(out)
  report.push(`${name}: ${info.width}x${info.height} ${(info.size / 1024).toFixed(0)} KB`)
  return info
}

/** Alpha-content row/column bounds (alpha > threshold anywhere in row/col). */
async function alphaBounds(file, threshold = 8) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  let top = height, bottom = -1, left = width, right = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] > threshold) {
        if (y < top) top = y
        if (y > bottom) bottom = y
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }
  return { top, bottom, left, right, width, height }
}

// ---- 1. shore panorama → horizon band ------------------------------------
// 4096x2048 equirect from lake center, alpha sky. Only the band around the
// horizon carries content: crop it, and fade the bottom rows to alpha 0 so
// the white lakebed below the baked waterline can never show as a sliver
// (the waterline sits within ~6 px below the equirect midline everywhere —
// depression angle atan(6 m / shore distance)).
{
  const src = `${BAKES}/pano_shores_alpha.png`
  const b = await alphaBounds(src)
  const HORIZON = b.height / 2 // row 1024
  const top = Math.max(0, (b.top & ~7) - 8) // snap up to a clean margin
  const bottom = HORIZON + 8
  const bandH = bottom - top

  // linear alpha ramp over the last 8 rows of the band
  const fade = Buffer.alloc(b.width * bandH * 4)
  const band = await sharp(src)
    .extract({ left: 0, top, width: b.width, height: bandH })
    .ensureAlpha()
    .raw()
    .toBuffer()
  band.copy(fade)
  for (let y = bandH - 8; y < bandH; y++) {
    const k = (bandH - y) / 8
    for (let x = 0; x < b.width; x++) {
      const i = (y * b.width + x) * 4 + 3
      fade[i] = Math.round(fade[i] * k)
    }
  }
  await emit(
    sharp(fade, { raw: { width: b.width, height: bandH, channels: 4 } }),
    'hl-pano-shores.webp',
    { quality: 82, alphaQuality: 100 },
  )
  report.push(
    `  pano content rows ${b.top}..${b.bottom} of ${b.height}; ` +
      `band crop rows ${top}..${bottom} → thetaStart=${((top / b.height) * 180).toFixed(2)}° ` +
      `thetaLength=${((bandH / b.height) * 180).toFixed(2)}°`,
  )
}

// ---- 2. terrain albedo → macro tint layer ---------------------------------
// The 4k bake carries only macro information (meadow tone, timberline
// gradient, beach ring) plus a periodic baked grass-instance grid — downsize
// hard and blur a touch so the grid melts into organic mottle.
await emit(
  sharp(`${BAKES}/terrain_albedo_4k.png`).resize(1024, 1024).blur(0.6).removeAlpha(),
  'hl-terrain-macro.webp',
  { quality: 80 },
)

// ---- 3. spruce impostor sheets --------------------------------------------
for (const [src, name] of [
  [`${BAKES}/spruce_impostor_top_hd.png`, 'hl-spruce-top.webp'],
  [`${BAKES}/spruce_impostor_side_hd.png`, 'hl-spruce-side-hd.webp'],
]) {
  const b = await alphaBounds(src)
  await emit(sharp(src), name, { quality: 85, alphaQuality: 100 })
  report.push(`  content bbox x ${b.left}..${b.right}, y ${b.top}..${b.bottom} (${b.width}x${b.height})`)
}

// re-encode the shipping side sheet (PNG → WebP, zero-visible-cost mandate)
{
  const src = 'public/assets/textures/hl-spruce-impostor.png'
  const b = await alphaBounds(src)
  await emit(sharp(src), 'hl-spruce-impostor.webp', { quality: 90, alphaQuality: 100 })
  report.push(`  content bbox x ${b.left}..${b.right}, y ${b.top}..${b.bottom} (${b.width}x${b.height})`)
}

console.log(report.join('\n'))
