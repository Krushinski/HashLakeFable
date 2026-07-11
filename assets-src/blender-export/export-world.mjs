globalThis.location={search:''};

// tools/export-world.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// src/core/noise.ts
function hash2(ix, iz, seed) {
  let h = ix * 374761393 + iz * 668265263 + seed * 1442695040888963300 | 0;
  h = h ^ h >> 13 | 0;
  h = Math.imul(h, 1274126177);
  h = h ^ h >> 16 | 0;
  return (h >>> 0) / 4294967296;
}
function smoothstep01(t) {
  return t * t * (3 - 2 * t);
}
function valueNoise2(x, z, seed = 1) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  const ux = smoothstep01(fx);
  const uz = smoothstep01(fz);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return (ab + (cd - ab) * uz) * 2 - 1;
}
function fbm2(x, z, opts = {}) {
  const { octaves = 4, lacunarity = 2, gain = 0.5, seed = 1 } = opts;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, z * freq, seed + i * 101) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223 >>> 0;
    return s / 4294967296;
  };
}

// src/scene/lakeMap.ts
var WATER_LEVEL = 0;
var SCALE_PROBE = Number(new URLSearchParams(location.search).get("scale"));
var LAKE_SCALE = SCALE_PROBE >= 0.5 && SCALE_PROBE <= 3 ? SCALE_PROBE : 0.75;
var LAKE_TEX_WORLD_SIZE = Math.ceil(2048 * LAKE_SCALE);
var MAX_LAKE_DEPTH = 11;
var GHOST_BLOBS = [
  { cx: 0, cz: 40, rx: 640, rz: 460 },
  // main body
  { cx: -140, cz: -430, rx: 260, rz: 240 },
  // north bay toward the mountain gateway
  { cx: 560, cz: 190, rx: 250, rz: 200 },
  // east cove
  { cx: -580, cz: 110, rx: 200, rz: 180 },
  // west dock inlet
  { cx: 190, cz: 470, rx: 380, rz: 230 },
  // south shallows reach
  // island back-channel: keeps the water behind the island deep enough
  // to thread at full speed (§user)
  { cx: -430, cz: 360, rx: 200, rz: 150 }
];
var LAKE_BLOBS = GHOST_BLOBS.map((b) => ({
  cx: b.cx * LAKE_SCALE,
  cz: b.cz * LAKE_SCALE,
  rx: b.rx * LAKE_SCALE,
  rz: b.rz * LAKE_SCALE
}));
var ISLAND = {
  cx: -235 * LAKE_SCALE,
  cz: 305 * LAKE_SCALE,
  r: 155 * LAKE_SCALE,
  // 2.6 not 3.6 (§user, turquoise pass): a lower, rounder dome gives a
  // gentler shore slope — the waterline contour wanders smoothly across
  // the 6 m terrain triangles instead of zigzagging, and the beach ring
  // widens
  crest: 2.6,
  landR: 74 * LAKE_SCALE
};
var SANDBAR = {
  cx: 230 * LAKE_SCALE,
  cz: 360 * LAKE_SCALE,
  rx: 105 * LAKE_SCALE,
  rz: 42 * LAKE_SCALE,
  rot: -0.35,
  crest: 0.7
};
function blobSdf(x, z, b) {
  const dx = (x - b.cx) / b.rx;
  const dz = (z - b.cz) / b.rz;
  const d = Math.hypot(dx, dz) - 1;
  return d * Math.min(b.rx, b.rz);
}
function smoothMin(a, b, k) {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b + (a - b) * h - k * h * (1 - h);
}
function shoreSdf(x, z) {
  let d = Infinity;
  for (const b of LAKE_BLOBS) {
    d = d === Infinity ? blobSdf(x, z, b) : smoothMin(d, blobSdf(x, z, b), 110 * LAKE_SCALE);
  }
  const wobble = fbm2(x * 16e-4, z * 16e-4, { octaves: 3, seed: 7 }) * 46 + fbm2(x * 8e-3, z * 8e-3, { octaves: 2, seed: 23 }) * 9;
  let s = d + wobble;
  const di = Math.hypot(x - ISLAND.cx, z - ISLAND.cz);
  const islandLand = ISLAND.landR - di + fbm2(x * 0.01, z * 0.01, { octaves: 2, seed: 71 }) * 8;
  s = Math.max(s, islandLand);
  const c = Math.cos(SANDBAR.rot);
  const sn = Math.sin(SANDBAR.rot);
  const dx = x - SANDBAR.cx;
  const dz = z - SANDBAR.cz;
  const lx = (dx * c - dz * sn) / SANDBAR.rx;
  const lz = (dx * sn + dz * c) / SANDBAR.rz;
  const barLand = (0.125 - Math.hypot(lx, lz)) * 70;
  s = Math.max(s, barLand);
  return s;
}
function gaussianBump(x, z, cx, cz, rx, rz, rot = 0) {
  const dx = x - cx;
  const dz = z - cz;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const lx = (dx * c - dz * s) / rx;
  const lz = (dx * s + dz * c) / rz;
  return Math.exp(-(lx * lx + lz * lz) * 2.2);
}
function bedHeight(x, z) {
  const sdf2 = shoreSdf(x, z);
  const t = Math.min(1, Math.max(0, -sdf2 / (380 * LAKE_SCALE)));
  let bed = -MAX_LAKE_DEPTH * Math.pow(t, 1.2);
  bed += fbm2(x * 3e-3, z * 3e-3, { octaves: 3, seed: 41 }) * 1.6 * t;
  const du = Math.hypot(x - ISLAND.cx, z - ISLAND.cz) / ISLAND.r;
  const islandG = Math.exp(-Math.pow(du, 2.4) * 1.4);
  bed = Math.max(
    bed,
    -MAX_LAKE_DEPTH + (ISLAND.crest + MAX_LAKE_DEPTH) * islandG
  );
  if (islandG > 0.5) {
    bed += (islandG - 0.5) * 2 * fbm2(x * 0.02, z * 0.02, { octaves: 3, seed: 91 }) * 2.2;
    bed += (islandG - 0.5) * 2 * Math.max(0, fbm2(x * 0.045, z * 0.045, { octaves: 2, seed: 17 })) * 1.1;
  }
  const bar = gaussianBump(
    x,
    z,
    SANDBAR.cx,
    SANDBAR.cz,
    SANDBAR.rx,
    SANDBAR.rz,
    SANDBAR.rot
  );
  bed = Math.max(bed, -MAX_LAKE_DEPTH + (SANDBAR.crest + MAX_LAKE_DEPTH) * bar);
  return bed;
}

// src/scene/terrainSystem.ts
var S = LAKE_SCALE;
var DOMAIN = Math.round(5120 * S);
var scaleRidges = (ridges) => ridges.map((rg) => ({
  ...rg,
  x1: rg.x1 * S,
  z1: rg.z1 * S,
  x2: rg.x2 * S,
  z2: rg.z2 * S,
  r: rg.r * S
}));
var RIDGES = scaleRidges([
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
  { x1: 60, z1: -2450, h1: 900, x2: 800, z2: -2250, h2: 700, r: 440 }
]);
function ridgedNoise(x, z, seed) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < 5; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, z * freq, seed + i * 37));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.55;
    freq *= 2.1;
  }
  return sum / norm;
}
function mountainHeight(x, z) {
  let h = 0;
  for (const rg of RIDGES) {
    const ax = x - rg.x1;
    const az = z - rg.z1;
    const bx = rg.x2 - rg.x1;
    const bz = rg.z2 - rg.z1;
    const len2 = bx * bx + bz * bz;
    let t = (ax * bx + az * bz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = rg.x1 + bx * t;
    const pz = rg.z1 + bz * t;
    const d = Math.hypot(x - px, z - pz) / rg.r;
    if (d > 2.6) continue;
    const crest = (rg.h1 + (rg.h2 - rg.h1) * t) * (1 - 0.18 * Math.sin(t * Math.PI) * (rg.h1 > 400 && rg.h2 > 400 ? 1 : 0));
    const flank = Math.pow(Math.max(0, 1 - d / 2.6), 1.8);
    const macro = ridgedNoise(x * 11e-4, z * 11e-4, 913);
    const micro = ridgedNoise(x * 48e-4, z * 48e-4, 407);
    const crag = ridgedNoise(x * 0.011, z * 0.011, 1207);
    const carved = crest * flank * (0.47 + 0.38 * macro + 0.24 * micro + 0.12 * crag);
    h = Math.max(h, carved);
  }
  return h;
}
function terrainHeight(x, z) {
  const sdf2 = shoreSdf(x, z);
  if (sdf2 < 0) {
    return bedHeight(x, z);
  }
  const shelf = Math.min(1, sdf2 / 420);
  let h = 0.25 + 4.2 * Math.pow(shelf, 1.35);
  h += fbm2(x * 22e-4, z * 22e-4, { octaves: 4, seed: 77 }) * 2.6 * Math.min(1, Math.max(0, (sdf2 - 26) / 150));
  h += fbm2(x * 8e-3, z * 8e-3, { octaves: 3, seed: 131 }) * 3.4 * Math.min(1, Math.max(0, (sdf2 - 26) / 130));
  const knoll = ridgedNoise(x * 4e-3, z * 4e-3, 555);
  h += Math.max(0, knoll - 0.62) * 46 * Math.min(1, Math.max(0, (sdf2 - 25) / 120));
  const north = Math.min(1, Math.max(0, (-z - 620 * S) / (900 * S)));
  h += north * north * 130;
  h += north * fbm2(x * 12e-4, z * 12e-4, { octaves: 3, seed: 55 }) * 46 * north;
  h = Math.max(h, mountainHeight(x, z));
  const radial = Math.hypot(x, z - 40 * S);
  const edge = Math.min(1, Math.max(0, (radial - 1350 * S) / (1e3 * S)));
  const southish = Math.max(0, z / Math.max(radial, 1));
  h += edge * edge * (55 + 60 * southish) * (0.7 + 0.6 * fbm2(x * 16e-4, z * 16e-4, { octaves: 3, seed: 99 }));
  return h;
}
var FAR_RIDGES = scaleRidges([
  { x1: -2900, z1: -3400, h1: 760, x2: -900, z2: -3750, h2: 1120, r: 950 },
  { x1: -900, z1: -3750, h1: 1120, x2: 1500, z2: -3500, h2: 880, r: 900 },
  { x1: 2300, z1: -2600, h1: 640, x2: 3600, z2: -1500, h2: 430, r: 760 },
  { x1: -3600, z1: -1300, h1: 540, x2: -2600, z2: -2300, h2: 730, r: 800 },
  // supporting ranges ringing the world (§user) — the due south stays
  // low and open so the basin still breathes
  { x1: 2700, z1: -600, h1: 480, x2: 3500, z2: 800, h2: 620, r: 720 },
  { x1: -3500, z1: 300, h1: 560, x2: -2700, z2: 1700, h2: 410, r: 700 },
  { x1: 1900, z1: 2700, h1: 300, x2: 3300, z2: 1800, h2: 440, r: 640 },
  { x1: -2400, z1: 2600, h1: 340, x2: -1300, z2: 3100, h2: 260, r: 600 }
]);

// tools/export-world.ts
var OUT = join(process.cwd(), "assets-src", "blender-export");
mkdirSync(OUT, { recursive: true });
var S2 = LAKE_SCALE;
var N = 1537;
var EXTENT = 3840;
var heights = new Float32Array(N * N);
var sdf = new Float32Array(N * N);
var hMin = Infinity;
var hMax = -Infinity;
for (let j = 0; j < N; j++) {
  const z = (j / (N - 1) - 0.5) * EXTENT;
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1) - 0.5) * EXTENT;
    const s = shoreSdf(x, z);
    const h = s < 0 ? bedHeight(x, z) : terrainHeight(x, z);
    heights[j * N + i] = h;
    sdf[j * N + i] = s;
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
}
writeFileSync(join(OUT, "heightfield.f32"), Buffer.from(heights.buffer));
writeFileSync(join(OUT, "shoresdf.f32"), Buffer.from(sdf.buffer));
console.log(`heightfield ${N}x${N} over ${EXTENT}m, h in [${hMin.toFixed(1)}, ${hMax.toFixed(1)}]`);
{
  const rand = seededRandom(48151623);
  const slots = [];
  const tryPlace = (x, z, minShore, maxShore, hero = false) => {
    const s = shoreSdf(x, z);
    if (s < minShore || s > maxShore) return false;
    for (const p of slots) {
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d2 < (hero ? 36 : 20)) return false;
    }
    slots.push({ x, z, scale: 0.85 + rand() * 0.6, rot: rand() * Math.PI * 2, hero });
    return true;
  };
  tryPlace(-80 * S2, 762 * S2, 4, 400 * S2, true);
  tryPlace(-350 * S2, 645 * S2, 4, 400 * S2, true);
  tryPlace(560 * S2, 630 * S2, 4, 400 * S2, true);
  tryPlace(640 * S2, 480 * S2, 4, 400 * S2, true);
  for (let i = 0; i < 3e3 && slots.length < 840; i++) {
    const ang = rand() * Math.PI * 2;
    const rad = (500 + rand() * 700) * S2;
    const cx = Math.sin(ang) * rad;
    const cz = Math.cos(ang) * rad * 0.92 + 40;
    const n = 2 + Math.floor(rand() * 5);
    for (let j = 0; j < n && slots.length < 840; j++) {
      const a = rand() * Math.PI * 2;
      const r = 3.5 + rand() * 13;
      tryPlace(cx + Math.sin(a) * r, cz + Math.cos(a) * r, 10, 320);
    }
  }
  const impSlots = [];
  for (let i = 0; i < 2e4 && impSlots.length < 1e4; i++) {
    const ang = rand() * Math.PI * 2;
    const rad = (640 + rand() * 1500) * S2;
    const cx = Math.sin(ang) * rad;
    const cz = Math.cos(ang) * rad * 0.92 + 40 * S2;
    const n = 3 + Math.floor(rand() * 6);
    for (let j = 0; j < n && impSlots.length < 1e4; j++) {
      const a = rand() * Math.PI * 2;
      const r = 2.5 + rand() * 8.5;
      const x = cx + Math.sin(a) * r;
      const z = cz + Math.cos(a) * r;
      const s = shoreSdf(x, z);
      if (s < 50 || s > 1200 * S2) continue;
      const h = terrainHeight(x, z);
      if (h > 140) continue;
      let ok = true;
      for (const p of impSlots) {
        if ((p.x - x) ** 2 + (p.z - z) ** 2 < 16) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      impSlots.push({ x, z, scale: 0.7 + rand() * 0.65, rot: rand() * Math.PI });
    }
  }
  const seat = (s) => terrainHeight(s.x, s.z);
  const forest = {
    hero: slots.filter((s) => s.hero).map((s) => ({ ...s, y: seat(s) })),
    instanced: slots.filter((s) => !s.hero).map((s) => ({ ...s, y: seat(s) })),
    impostor: impSlots.map((s) => ({ ...s, y: seat(s) }))
  };
  console.log(`forest: ${forest.hero.length} hero + ${forest.instanced.length} instanced + ${forest.impostor.length} impostor`);
  const drand = seededRandom(90210);
  const palmSlots = [];
  for (let i = 0; i < 120 && palmSlots.length < 9; i++) {
    const ang = drand() * Math.PI * 2;
    const rad = ISLAND.landR * (0.04 + drand() * 0.3);
    const x = ISLAND.cx + Math.sin(ang) * rad;
    const z = ISLAND.cz + Math.cos(ang) * rad;
    if (bedHeight(x, z) < 0.7) continue;
    if (palmSlots.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 42)) continue;
    palmSlots.push({ x, z });
  }
  const palms = palmSlots.map((s, i) => ({
    x: s.x,
    z: s.z,
    y: bedHeight(s.x, s.z) - 0.3,
    variantIndex: i,
    // app uses i % palmVariantCount (top-level roots of hl-palm.glb)
    rotY: drand() * Math.PI * 2,
    tiltX: (drand() - 0.5) * 0.12,
    scale: 1.7 + drand() * 0.9
  }));
  const heroRocks = [];
  const shoreRocks = [];
  for (let i = 0; i < 120 && heroRocks.length < 14; i++) {
    const ang = drand() * Math.PI * 2;
    const rad = ISLAND.landR * (0.85 + drand() * 0.45);
    const x = ISLAND.cx + Math.sin(ang) * rad;
    const z = ISLAND.cz + Math.cos(ang) * rad;
    if (heroRocks.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 90)) continue;
    heroRocks.push({ x, z, s: 2.6 + drand() * 3.2, rot: drand() * Math.PI * 2 });
  }
  for (let i = 0; i < 1500 && shoreRocks.length < 68; i++) {
    const ang = drand() * Math.PI * 2;
    const rad = (480 + drand() * 520) * S2;
    const x = Math.sin(ang) * rad;
    const z = Math.cos(ang) * rad * 0.92 + 40;
    const s = shoreSdf(x, z);
    if (s < -16 || s > 24) continue;
    if (terrainHeight(x, z) > 14) continue;
    if (shoreRocks.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 700)) continue;
    shoreRocks.push({ x, z, s: 1.4 + drand() * 2.6, rot: drand() * Math.PI * 2 });
  }
  const rocks = {
    hero: heroRocks.map((r) => ({ x: r.x, z: r.z, y: bedHeight(r.x, r.z) - 0.35 * r.s, scale: r.s, rotY: r.rot })),
    shore: shoreRocks.map((r) => ({ x: r.x, z: r.z, y: terrainHeight(r.x, r.z) - 0.3 * r.s, scale: r.s, rotY: r.rot }))
  };
  console.log(`dressing: ${palms.length} palms, ${rocks.hero.length}+${rocks.shore.length} rocks`);
  const sz = 110 * S2;
  let sx = -585 * S2;
  for (let i = 0; i < 400 && shoreSdf(sx, sz) < 0; i++) sx -= 2;
  if (shoreSdf(sx, sz) < 0) sx = -760 * S2;
  const startX = sx + 3;
  const LEN = 22;
  const deckY = 0.72;
  const dockRand = seededRandom(777333);
  const planks = [];
  for (let d = 0; d < LEN; d += 0.7) {
    planks.push({
      x: startX + 2 + d,
      y: deckY + (dockRand() - 0.5) * 0.016,
      z: sz + (dockRand() - 0.5) * 0.03,
      rotY: (dockRand() - 0.5) * 0.02
    });
  }
  const stringers = [-1, 0.98].map((side) => ({
    x: startX + 2 + LEN / 2 - 0.35,
    y: deckY - 0.1,
    z: sz + side,
    len: LEN + 1.4
  }));
  const piles = [];
  for (let d = 0.5; d < LEN + 1; d += 4.2) {
    for (const side of [-1.05, 1.05]) {
      piles.push({
        x: startX + 2 + d,
        y: deckY - 1.55,
        z: sz + side,
        rotZ: (dockRand() - 0.5) * 0.04,
        rotX: (dockRand() - 0.5) * 0.04
      });
    }
  }
  const cleats = [-0.9, 0.9].map((side) => ({
    x: startX + 2 + LEN - 0.6,
    y: deckY + 0.1,
    z: sz + side
  }));
  const dock = {
    startX,
    z: sz,
    deckY,
    len: LEN,
    plankSize: [0.62, 0.07, 2.4],
    stringerSize: [LEN + 1.4, 0.12, 0.16],
    pile: { rTop: 0.11, rBot: 0.135, h: 3.6 },
    planks,
    stringers,
    piles,
    cleats
  };
  console.log(`dock: startX=${startX.toFixed(2)} z=${sz} planks=${planks.length} piles=${piles.length}`);
  const buoys = [
    { x: 560 * S2, z: 190 * S2, name: "cove" },
    { x: -140 * S2, z: -430 * S2, name: "north bay" },
    { x: ISLAND.cx + ISLAND.landR + 26, z: ISLAND.cz + 30, name: "island mooring" }
  ];
  const boat = {
    x: 40 * S2,
    z: 420 * S2,
    y: 0,
    headingRad: 0,
    // 0 = facing north (-z)
    glbYawFixRad: Math.PI / 2,
    // runtime applies rotation.y = PI/2 to the GLB
    hiddenMeshPrefixes: ["Prop", "Rudder"]
  };
  const meta = {
    frame: "meters; origin lake center; +X east; -Z north; water y=0. Blender: (x, -z, y)",
    lakeScale: S2,
    extent: EXTENT,
    gridN: N,
    waterLevel: WATER_LEVEL,
    maxLakeDepth: MAX_LAKE_DEPTH,
    heightRange: [hMin, hMax],
    island: ISLAND,
    heightfield: "heightfield.f32 float32 little-endian, row-major, j=z rows i=x cols, [-extent/2..extent/2]",
    shoresdf: "shoresdf.f32 same layout; negative = inside lake"
  };
  writeFileSync(join(OUT, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(
    join(OUT, "placements.json"),
    JSON.stringify({ forest, palms, rocks, dock, buoys, boat }, null, 2)
  );
  console.log("wrote meta.json + placements.json ->", OUT);
}
