#!/usr/bin/env node
/**
 * Diagnostic: Three-way comparison — Erosion vs Flood-Fill vs Z5 Ocean Mask
 *
 * Method C (new): Fetch a z5 tile for the same area. Any pixel that's ocean
 * at z5 (~3km resolution) is definitively ocean — mudflats, tidal noise,
 * and SRTM artifacts all disappear at that scale. Apply that mask to the
 * higher-zoom tile: any land pixel whose z5 parent is ocean → force to 0.
 * Then run flood-fill on the remainder for edge cleanup.
 *
 * Usage:  node diagnostic/erosion-test.mjs
 * Output: diagnostic/erosion-report.html
 */

import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createInflate } from 'zlib'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AWS_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
const TILE_PX = 256
const OCEAN_THRESHOLD = 0
const MASK_ZOOM = 7  // Low-zoom level for ocean mask (~600m/px, Fire Island visible)

// ─── Test Locations ────────────────────────────────────────────────────────────

const TEST_LOCATIONS = [
  { name: 'Anchorage (z8 — far band)',   lat: 61.3252, lng: -149.8744, zoom: 8  },
  { name: 'Anchorage (z10 — mid band)',  lat: 61.3252, lng: -149.8744, zoom: 10 },
  { name: 'Anchorage (z11 — mid-near)',  lat: 61.3252, lng: -149.8744, zoom: 11 },
  { name: 'Hawaii Maui (z8 — far)',      lat: 20.7984, lng: -156.3319, zoom: 8  },
  { name: 'Hawaii Maui (z10 — mid)',     lat: 20.7984, lng: -156.3319, zoom: 10 },
  { name: 'Colorado Rockies (z8)',       lat: 39.1178, lng: -106.4453, zoom: 8  },
  { name: 'Colorado Rockies (z10)',      lat: 39.1178, lng: -106.4453, zoom: 10 },
  { name: 'Fire Island AK (z11)',        lat: 61.17,   lng: -150.22,  zoom: 11 },
]

// ─── Tile Math ─────────────────────────────────────────────────────────────────

function latLngToTileXY(lat, lng, zoom) {
  const x = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom))
  const latR = (lat * Math.PI) / 180
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * Math.pow(2, zoom)
  )
  return { x, y }
}

function tileTopLeft(x, y, zoom) {
  const n = Math.pow(2, zoom)
  const lng = (x / n) * 360 - 180
  const latR = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  return { lat: (latR * 180) / Math.PI, lng }
}

// ─── Fetch & Decode ────────────────────────────────────────────────────────────

const tileCache = new Map()

async function fetchTile(z, x, y) {
  const key = `${z}/${x}/${y}`
  if (tileCache.has(key)) return tileCache.get(key)

  const url = `${AWS_BASE}/${z}/${x}/${y}.png`
  console.log(`  Fetching ${url}`)
  const buf = execSync(`curl -s "${url}"`, { maxBuffer: 10 * 1024 * 1024 })
  const pngBytes = new Uint8Array(buf)
  const pixels = await decodePNG(pngBytes)
  const elevations = new Float32Array(TILE_PX * TILE_PX)
  for (let i = 0; i < TILE_PX * TILE_PX; i++) {
    elevations[i] = pixels[i * 4] * 256 + pixels[i * 4 + 1] + pixels[i * 4 + 2] / 256 - 32768
  }
  tileCache.set(key, elevations)
  return elevations
}

function decodePNG(pngBytes) {
  return new Promise((resolve, reject) => {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10]
    for (let i = 0; i < 8; i++) {
      if (pngBytes[i] !== sig[i]) return reject(new Error('Not a PNG'))
    }
    let offset = 8
    let width = 0, height = 0, colorType = 0
    const idatChunks = []
    while (offset < pngBytes.length) {
      const len = (pngBytes[offset] << 24 | pngBytes[offset+1] << 16 | pngBytes[offset+2] << 8 | pngBytes[offset+3]) >>> 0
      const type = String.fromCharCode(pngBytes[offset+4], pngBytes[offset+5], pngBytes[offset+6], pngBytes[offset+7])
      if (type === 'IHDR') {
        width = (pngBytes[offset+8] << 24 | pngBytes[offset+9] << 16 | pngBytes[offset+10] << 8 | pngBytes[offset+11]) >>> 0
        height = (pngBytes[offset+12] << 24 | pngBytes[offset+13] << 16 | pngBytes[offset+14] << 8 | pngBytes[offset+15]) >>> 0
        colorType = pngBytes[offset+17]
      } else if (type === 'IDAT') {
        idatChunks.push(pngBytes.slice(offset + 8, offset + 8 + len))
      } else if (type === 'IEND') { break }
      offset += 12 + len
    }
    const compressed = Buffer.concat(idatChunks.map(c => Buffer.from(c)))
    const inflate = createInflate()
    const chunks = []
    inflate.on('data', chunk => chunks.push(chunk))
    inflate.on('end', () => {
      const raw = Buffer.concat(chunks)
      const bpp = colorType === 2 ? 3 : 4
      const rowBytes = width * bpp
      const pixels = new Uint8Array(width * height * 4)
      let prevRow = new Uint8Array(rowBytes)
      for (let row = 0; row < height; row++) {
        const filterByte = raw[row * (rowBytes + 1)]
        const rowStart = row * (rowBytes + 1) + 1
        const currRow = new Uint8Array(rowBytes)
        for (let i = 0; i < rowBytes; i++) {
          const x = raw[rowStart + i]
          const a = i >= bpp ? currRow[i - bpp] : 0
          const b = prevRow[i]
          const c = i >= bpp ? prevRow[i - bpp] : 0
          switch (filterByte) {
            case 0: currRow[i] = x; break
            case 1: currRow[i] = (x + a) & 0xff; break
            case 2: currRow[i] = (x + b) & 0xff; break
            case 3: currRow[i] = (x + ((a + b) >> 1)) & 0xff; break
            case 4: { const p=a+b-c; const pa=Math.abs(p-a); const pb=Math.abs(p-b); const pc=Math.abs(p-c); currRow[i] = (x + (pa<=pb&&pa<=pc?a:pb<=pc?b:c)) & 0xff; break }
            default: currRow[i] = x
          }
        }
        for (let col = 0; col < width; col++) {
          const s = col * bpp, dd = (row * width + col) * 4
          pixels[dd] = currRow[s]; pixels[dd+1] = currRow[s+1]; pixels[dd+2] = currRow[s+2]; pixels[dd+3] = bpp === 4 ? currRow[s+3] : 255
        }
        prevRow = currRow
      }
      resolve(pixels)
    })
    inflate.on('error', reject)
    inflate.end(compressed)
  })
}

// ─── Method A: Neighbor Erosion ───────────────────────────────────────────────

function runErosion(elevations, zoom) {
  const N = TILE_PX, thresh = zoom <= 10 ? 6 : zoom <= 13 ? 7 : 9
  const result = new Float32Array(elevations)
  const eroded = []
  for (let pass = 0; pass < 2; pass++) {
    const snap = new Float32Array(result)
    let cnt = 0
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const idx = r * N + c
      if (snap[idx] <= OCEAN_THRESHOLD) continue
      let ocean = 0, nb = 0
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue
        const nr = r + dr, nc = c + dc
        if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue
        nb++; if (snap[nr * N + nc] <= OCEAN_THRESHOLD) ocean++
      }
      if (nb > 0 && ocean >= thresh) { result[idx] = 0; eroded.push({ row: r, col: c, origElev: elevations[idx] }); cnt++ }
    }
    console.log(`    [Erosion] Pass ${pass+1}: ${cnt}px`)
  }
  return { result, eroded }
}

// ─── Method B: Flood-Fill ─────────────────────────────────────────────────────

function floodFillClean(elevations, zoom) {
  const N = TILE_PX, total = N * N
  const result = new Float32Array(elevations)
  const labels = new Int32Array(total)
  const compSize = new Map(), compEdge = new Map(), compLand = new Map()
  let nextLabel = 1

  function bfs(start, isLand) {
    const label = nextLabel++
    const stack = [start]; labels[start] = label
    let size = 0, edge = false
    while (stack.length > 0) {
      const idx = stack.pop(); size++
      const r = (idx / N) | 0, c = idx % N
      if (r === 0 || r === N-1 || c === 0 || c === N-1) edge = true
      for (const ni of [idx-N, idx+N, idx-1, idx+1]) {
        if (ni < 0 || ni >= total) continue
        if (ni === idx-1 && c === 0) continue
        if (ni === idx+1 && c === N-1) continue
        if (labels[ni] !== 0) continue
        if ((result[ni] > OCEAN_THRESHOLD) === isLand) { labels[ni] = label; stack.push(ni) }
      }
    }
    compSize.set(label, size); compEdge.set(label, edge); compLand.set(label, isLand)
  }

  for (let i = 0; i < total; i++) { if (labels[i] === 0) bfs(i, result[i] > OCEAN_THRESHOLD) }

  const minPx = zoom <= 10 ? 8 : 16
  const eroded = []
  for (const [label, size] of compSize) {
    if (!compLand.get(label) || compEdge.get(label) || size >= minPx) continue
    for (let i = 0; i < total; i++) {
      if (labels[i] === label) { eroded.push({ row: (i/N)|0, col: i%N, origElev: elevations[i] }); result[i] = 0 }
    }
  }
  console.log(`    [FloodFill] ${eroded.length}px erased (threshold ${minPx}px)`)
  return { result, eroded }
}

// ─── Method C: Z5 Ocean Mask + Flood-Fill ─────────────────────────────────────
//
// 1. Fetch the z5 tile(s) that cover this higher-zoom tile's geographic extent
// 2. For each pixel in the high-zoom tile, look up the corresponding z5 pixel
// 3. If the z5 pixel is ocean (elev <= 0), force the high-zoom pixel to 0
// 4. Then run flood-fill to clean up edge fragments
//
// This kills ALL tidal noise in Knik Arm because at z5 (~3km/px) the entire
// inlet reads as ocean. Mudflat clusters of any size get flattened.

async function z5MaskClean(elevations, zoom, tx, ty) {
  const N = TILE_PX

  // Get geographic bounds of this tile
  const nw = tileTopLeft(tx, ty, zoom)
  const se = tileTopLeft(tx + 1, ty + 1, zoom)

  // For each pixel in the high-zoom tile, find the corresponding z5 elevation
  const result = new Float32Array(elevations)
  let maskForced = 0
  const maskedPixels = []

  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = row * N + col
      if (result[idx] <= OCEAN_THRESHOLD) continue  // already ocean

      // Geographic position of this pixel
      const lat = nw.lat - (row / (N - 1)) * (nw.lat - se.lat)
      const lng = nw.lng + (col / (N - 1)) * (se.lng - nw.lng)

      // Look up z5 tile and sample
      const { x: z5x, y: z5y } = latLngToTileXY(lat, lng, MASK_ZOOM)
      const z5elev = await fetchTile(MASK_ZOOM, z5x, z5y)

      // Find pixel position within the z5 tile
      const z5nw = tileTopLeft(z5x, z5y, MASK_ZOOM)
      const z5se = tileTopLeft(z5x + 1, z5y + 1, MASK_ZOOM)
      const z5col = Math.min(N-1, Math.max(0, Math.round((lng - z5nw.lng) / (z5se.lng - z5nw.lng) * (N-1))))
      const z5row = Math.min(N-1, Math.max(0, Math.round((z5nw.lat - lat) / (z5nw.lat - z5se.lat) * (N-1))))

      const z5val = z5elev[z5row * N + z5col]

      if (z5val <= OCEAN_THRESHOLD) {
        // z5 says this is ocean — force to 0
        maskedPixels.push({ row, col, origElev: elevations[idx] })
        result[idx] = 0
        maskForced++
      }
    }
  }

  console.log(`    [Z5 Mask] ${maskForced}px forced to ocean by z${MASK_ZOOM} mask`)

  // Now run flood-fill on the masked result to clean edges
  // Use a more aggressive threshold since z5 already handled the big areas
  const total = N * N
  const labels = new Int32Array(total)
  const compSize = new Map(), compEdge = new Map(), compLand = new Map()
  let nextLabel = 1

  function bfs(start, isLand) {
    const label = nextLabel++
    const stack = [start]; labels[start] = label
    let size = 0, edge = false
    while (stack.length > 0) {
      const i = stack.pop(); size++
      const r = (i / N) | 0, c = i % N
      if (r === 0 || r === N-1 || c === 0 || c === N-1) edge = true
      for (const ni of [i-N, i+N, i-1, i+1]) {
        if (ni < 0 || ni >= total) continue
        if (ni === i-1 && c === 0) continue
        if (ni === i+1 && c === N-1) continue
        if (labels[ni] !== 0) continue
        if ((result[ni] > OCEAN_THRESHOLD) === isLand) { labels[ni] = label; stack.push(ni) }
      }
    }
    compSize.set(label, size); compEdge.set(label, edge); compLand.set(label, isLand)
  }

  for (let i = 0; i < total; i++) { if (labels[i] === 0) bfs(i, result[i] > OCEAN_THRESHOLD) }

  // After z5 masking, remaining isolated fragments are edge artifacts — use smaller threshold
  const minPx = 4
  let floodExtra = 0
  for (const [label, size] of compSize) {
    if (!compLand.get(label) || compEdge.get(label) || size >= minPx) continue
    for (let i = 0; i < total; i++) {
      if (labels[i] === label) { maskedPixels.push({ row: (i/N)|0, col: i%N, origElev: elevations[i] }); result[i] = 0; floodExtra++ }
    }
  }
  console.log(`    [Z5 Mask] + ${floodExtra}px flood-fill cleanup = ${maskedPixels.length}px total`)

  return { result, eroded: maskedPixels, maskForced, floodExtra }
}

// ─── Statistics ────────────────────────────────────────────────────────────────

function tileStats(elevations) {
  let oceanPx = 0, landPx = 0, minElev = Infinity, maxElev = -Infinity
  for (let i = 0; i < elevations.length; i++) {
    if (elevations[i] <= OCEAN_THRESHOLD) oceanPx++; else landPx++
    if (elevations[i] < minElev) minElev = elevations[i]
    if (elevations[i] > maxElev) maxElev = elevations[i]
  }
  return { oceanPx, landPx, minElev, maxElev, total: elevations.length }
}

// ─── HTML Report ───────────────────────────────────────────────────────────────

function generateHTML(results) {
  const tiles = results.map((r, idx) => {
    const rawB64 = Buffer.from(r.raw.buffer).toString('base64')
    const erosionB64 = Buffer.from(r.erosionResult.buffer).toString('base64')
    const floodB64 = Buffer.from(r.floodResult.buffer).toString('base64')
    const z5B64 = Buffer.from(r.z5Result.buffer).toString('base64')
    const erosionPxJ = JSON.stringify(r.erosionPixels.map(p => [p.row, p.col]))
    const floodPxJ = JSON.stringify(r.floodPixels.map(p => [p.row, p.col]))
    const z5PxJ = JSON.stringify(r.z5Pixels.map(p => [p.row, p.col]))

    return `
    <div class="tile-pair">
      <h2>${r.name}</h2>
      <p>Tile: z${r.zoom}/${r.tx}/${r.ty} &nbsp;|&nbsp;
         ${r.stats.oceanPx} ocean (${(r.stats.oceanPx / r.stats.total * 100).toFixed(1)}%)
         &nbsp;|&nbsp; ${r.stats.landPx} land
         &nbsp;|&nbsp; Elev: ${r.stats.minElev.toFixed(0)}m to ${r.stats.maxElev.toFixed(0)}m</p>
      <p>
        <span class="ero">Erosion: ${r.erosionPixels.length}px</span> &nbsp;|&nbsp;
        <span class="fld">Flood-fill: ${r.floodPixels.length}px</span> &nbsp;|&nbsp;
        <span class="z5c">Z5 mask + flood: ${r.z5Pixels.length}px</span>
      </p>
      <div class="canvases">
        <div><h3>Raw DEM</h3><canvas id="c${idx}a" width="256" height="256"></canvas></div>
        <div><h3>Erosion only <span class="ero">(${r.erosionPixels.length}px)</span></h3><canvas id="c${idx}b" width="256" height="256"></canvas></div>
        <div><h3>Flood-fill only <span class="fld">(${r.floodPixels.length}px)</span></h3><canvas id="c${idx}c" width="256" height="256"></canvas></div>
        <div><h3>Z5 mask + flood <span class="z5c">(${r.z5Pixels.length}px)</span></h3><canvas id="c${idx}d" width="256" height="256"></canvas></div>
      </div>
      <script>(function(){
        const N=256;
        function d(b){const s=atob(b),a=new ArrayBuffer(s.length),u=new Uint8Array(a);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return new Float32Array(a)}
        function draw(id,elev,highlights,hc){
          const cv=document.getElementById(id),ctx=cv.getContext('2d'),img=ctx.createImageData(N,N);
          let mn=Infinity,mx=-Infinity;
          for(let i=0;i<elev.length;i++){if(elev[i]>0){if(elev[i]<mn)mn=elev[i];if(elev[i]>mx)mx=elev[i]}}
          const rng=mx-mn||1;
          for(let i=0;i<N*N;i++){const o=i*4;if(elev[i]<=0){img.data[o]=5;img.data[o+1]=15;img.data[o+2]=40}else{const t=(elev[i]-mn)/rng;img.data[o]=Math.round(40+160*t);img.data[o+1]=Math.round(120+80*(1-t));img.data[o+2]=Math.round(30+30*(1-t))}img.data[o+3]=255}
          if(highlights)for(const[r,c]of highlights){const o=(r*N+c)*4;img.data[o]=hc[0];img.data[o+1]=hc[1];img.data[o+2]=hc[2]}
          ctx.putImageData(img,0,0);
        }
        const raw=d("${rawB64}");
        draw('c${idx}a',raw,null,[0,0,0]);
        draw('c${idx}b',d("${erosionB64}"),${erosionPxJ},[255,60,60]);
        draw('c${idx}c',d("${floodB64}"),${floodPxJ},[255,0,255]);
        draw('c${idx}d',d("${z5B64}"),${z5PxJ},[0,255,200]);
      })()</script>
    </div>`
  }).join('\n')

  return `<!DOCTYPE html><html><head><title>Three-Way Spike Removal Comparison</title>
<style>
  body{background:#1a1a2e;color:#e0e0e0;font-family:monospace;max-width:1600px;margin:0 auto;padding:20px}
  h1{color:#84d1db} h2{color:#a0d0a0;border-bottom:1px solid #333;padding-bottom:8px} h3{color:#ccc;font-size:13px}
  .tile-pair{margin-bottom:40px;background:#0f0f23;padding:20px;border-radius:8px}
  .canvases{display:flex;gap:16px;flex-wrap:wrap} .canvases>div{text-align:center}
  canvas{border:1px solid #333;image-rendering:pixelated;width:256px;height:256px}
  p{color:#aaa;font-size:13px}
  .ero{color:#ff4444;font-weight:bold} .fld{color:#ff44ff;font-weight:bold} .z5c{color:#00ffc8;font-weight:bold}
  .summary-box{background:#0a1a2a;padding:15px;border-radius:8px;margin-bottom:30px;border:1px solid #234}
  .summary-box h2{border:none;margin:0 0 10px 0}
</style></head><body>
  <h1>Three-Way Spike Removal Comparison</h1>
  <div class="summary-box">
    <h2>Three approaches</h2>
    <p><span class="ero">A — Neighbor Erosion:</span> 2-pass, erase pixels with 6-7/8 ocean neighbors. Fast but misses clusters.</p>
    <p><span class="fld">B — Flood-Fill:</span> Erase isolated land fragments &lt;16px not connected to tile edge. Catches clusters but preserves large mudflat blobs.</p>
    <p><span class="z5c">C — Z5 Ocean Mask + Flood-Fill:</span> Fetch z5 tile (~3km/px). Any pixel whose z5 parent is ocean → forced to 0.
       Then flood-fill with 4px threshold for edge cleanup. Kills ALL tidal noise because z5 sees clean ocean.</p>
    <p>Highlighted pixels show what each method erased. The "after" elevation map shows the cleaned result.</p>
  </div>
  ${tiles}
</body></html>`
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Three-Way Comparison: Erosion vs Flood-Fill vs Z5 Mask ===\n')
  const results = []

  for (const loc of TEST_LOCATIONS) {
    console.log(`\n${loc.name}:`)
    const { x: tx, y: ty } = latLngToTileXY(loc.lat, loc.lng, loc.zoom)
    console.log(`  Tile: z${loc.zoom}/${tx}/${ty}`)
    const nw = tileTopLeft(tx, ty, loc.zoom)
    const se = tileTopLeft(tx + 1, ty + 1, loc.zoom)
    const pixelSize = ((nw.lat - se.lat) * 111132) / 256
    console.log(`  Pixel: ~${pixelSize.toFixed(1)}m | Bounds: ${nw.lat.toFixed(3)}N,${nw.lng.toFixed(3)}E → ${se.lat.toFixed(3)}N,${se.lng.toFixed(3)}E`)

    try {
      const elevations = await fetchTile(loc.zoom, tx, ty)
      const stats = tileStats(elevations)
      console.log(`  Ocean: ${stats.oceanPx}, Land: ${stats.landPx}`)

      if (stats.oceanPx === 0) {
        console.log(`  No ocean — all methods skipped`)
        results.push({ name: loc.name, zoom: loc.zoom, tx, ty, raw: elevations,
          erosionResult: elevations, erosionPixels: [],
          floodResult: elevations, floodPixels: [],
          z5Result: elevations, z5Pixels: [], stats })
        continue
      }

      console.log(`  --- A: Neighbor Erosion ---`)
      const erosion = runErosion(elevations, loc.zoom)

      console.log(`  --- B: Flood-Fill ---`)
      const flood = floodFillClean(elevations, loc.zoom)

      console.log(`  --- C: Z5 Ocean Mask + Flood-Fill ---`)
      const z5 = await z5MaskClean(elevations, loc.zoom, tx, ty)

      results.push({ name: loc.name, zoom: loc.zoom, tx, ty, raw: elevations,
        erosionResult: erosion.result, erosionPixels: erosion.eroded,
        floodResult: flood.result, floodPixels: flood.eroded,
        z5Result: z5.result, z5Pixels: z5.eroded, stats })
    } catch (err) {
      console.error(`  FAILED: ${err.message}`)
    }
  }

  const html = generateHTML(results)
  const outPath = join(__dirname, 'erosion-report.html')
  writeFileSync(outPath, html)
  console.log(`\n✓ Report: ${outPath}`)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
