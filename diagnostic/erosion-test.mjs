#!/usr/bin/env node
/**
 * Diagnostic: Spike Erosion vs Flood-Fill Comparison
 *
 * Fetches real AWS Terrarium tiles, runs BOTH approaches:
 *   A) 2-pass neighbor erosion (zoom-adaptive threshold)
 *   B) Flood-fill ocean mask (connected-component, size-thresholded)
 * Generates an HTML report with 4 canvases per tile for visual comparison.
 *
 * Usage:  node diagnostic/erosion-test.mjs
 * Output: diagnostic/erosion-report.html (open in browser)
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
  // Knik Arm directly — the noisiest area
  { name: 'Knik Arm center (z11)',       lat: 61.35,   lng: -150.05,  zoom: 11 },
  { name: 'Knik Arm center (z8)',        lat: 61.35,   lng: -150.05,  zoom: 8  },
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

async function fetchTile(z, x, y) {
  const url = `${AWS_BASE}/${z}/${x}/${y}.png`
  console.log(`  Fetching ${url}`)
  const buf = execSync(`curl -s "${url}"`, { maxBuffer: 10 * 1024 * 1024 })
  const pngBytes = new Uint8Array(buf)
  const pixels = await decodePNG(pngBytes)
  const elevations = new Float32Array(TILE_PX * TILE_PX)
  for (let i = 0; i < TILE_PX * TILE_PX; i++) {
    elevations[i] = pixels[i * 4] * 256 + pixels[i * 4 + 1] + pixels[i * 4 + 2] / 256 - 32768
  }
  return { elevations }
}

function decodePNG(pngBytes) {
  return new Promise((resolve, reject) => {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10]
    for (let i = 0; i < 8; i++) {
      if (pngBytes[i] !== sig[i]) return reject(new Error('Not a PNG'))
    }
    let offset = 8
    let width = 0, height = 0, bitDepth = 0, colorType = 0
    const idatChunks = []
    while (offset < pngBytes.length) {
      const len = (pngBytes[offset] << 24 | pngBytes[offset+1] << 16 | pngBytes[offset+2] << 8 | pngBytes[offset+3]) >>> 0
      const type = String.fromCharCode(pngBytes[offset+4], pngBytes[offset+5], pngBytes[offset+6], pngBytes[offset+7])
      if (type === 'IHDR') {
        width = (pngBytes[offset+8] << 24 | pngBytes[offset+9] << 16 | pngBytes[offset+10] << 8 | pngBytes[offset+11]) >>> 0
        height = (pngBytes[offset+12] << 24 | pngBytes[offset+13] << 16 | pngBytes[offset+14] << 8 | pngBytes[offset+15]) >>> 0
        bitDepth = pngBytes[offset+16]; colorType = pngBytes[offset+17]
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
          const s = col * bpp, d = (row * width + col) * 4
          pixels[d] = currRow[s]; pixels[d+1] = currRow[s+1]; pixels[d+2] = currRow[s+2]; pixels[d+3] = bpp === 4 ? currRow[s+3] : 255
        }
        prevRow = currRow
      }
      resolve(pixels)
    })
    inflate.on('error', reject)
    inflate.end(compressed)
  })
}

// ─── Method A: Neighbor Erosion (zoom-adaptive) ───────────────────────────────

function spikeThresholdForZoom(zoom) {
  if (zoom <= 10) return 6
  if (zoom <= 13) return 7
  return 9
}

function runErosion(elevations, zoom) {
  const N = TILE_PX
  const result = new Float32Array(elevations)
  const erodedPixels = []
  for (let pass = 0; pass < 2; pass++) {
    const snap = new Float32Array(result)
    let cnt = 0
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const idx = r * N + c
        if (snap[idx] <= OCEAN_THRESHOLD) continue
        let ocean = 0, neighbors = 0
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue
          const nr = r + dr, nc = c + dc
          if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue
          neighbors++
          if (snap[nr * N + nc] <= OCEAN_THRESHOLD) ocean++
        }
        if (neighbors > 0 && ocean >= spikeThresholdForZoom(zoom)) {
          result[idx] = 0
          erodedPixels.push({ row: r, col: c, origElev: elevations[idx] })
          cnt++
        }
      }
    }
    console.log(`    [Erosion] Pass ${pass+1}: ${cnt} pixels`)
  }
  return { result, erodedPixels }
}

// ─── Method B: Flood-Fill Connected Component ─────────────────────────────────
//
// 1. Flood-fill from every EDGE pixel with elevation <= 0 → "connected ocean"
// 2. Flood-fill from every EDGE pixel with elevation > 0 → "connected land"
// 3. Any land pixel NOT connected to edge = isolated fragment
//    If fragment size < threshold → erase (set to 0)
//
// Size threshold scales with zoom: at z8 (610m/px), 16px = ~10km (way bigger
// than noise). At z11 (36m/px), 16px = ~576m.

function floodFillClean(elevations, zoom) {
  const N = TILE_PX
  const total = N * N
  const result = new Float32Array(elevations)

  // Label array: 0 = unvisited, positive = component ID
  const labels = new Int32Array(total)
  const componentSizes = new Map()   // componentId -> pixel count
  const componentIsEdge = new Map()  // componentId -> touches tile edge?
  const componentIsLand = new Map()  // componentId -> land or ocean?
  let nextLabel = 1

  // BFS flood fill
  function bfs(startIdx, isLand) {
    const label = nextLabel++
    const queue = [startIdx]
    labels[startIdx] = label
    let size = 0
    let touchesEdge = false

    while (queue.length > 0) {
      const idx = queue.pop()  // DFS-style for speed (stack not queue)
      size++
      const r = (idx / N) | 0
      const c = idx % N

      if (r === 0 || r === N - 1 || c === 0 || c === N - 1) touchesEdge = true

      // 4-connected neighbors (faster, sufficient for flood fill)
      const neighbors = []
      if (r > 0)     neighbors.push(idx - N)
      if (r < N - 1) neighbors.push(idx + N)
      if (c > 0)     neighbors.push(idx - 1)
      if (c < N - 1) neighbors.push(idx + 1)

      for (const ni of neighbors) {
        if (labels[ni] !== 0) continue
        const niIsLand = result[ni] > OCEAN_THRESHOLD
        if (niIsLand === isLand) {
          labels[ni] = label
          queue.push(ni)
        }
      }
    }

    componentSizes.set(label, size)
    componentIsEdge.set(label, touchesEdge)
    componentIsLand.set(label, isLand)
    return label
  }

  // Pass 1: Label all connected components
  for (let i = 0; i < total; i++) {
    if (labels[i] !== 0) continue
    const isLand = result[i] > OCEAN_THRESHOLD
    bfs(i, isLand)
  }

  // Size threshold: land fragments smaller than this get erased
  // At z8: 16px * 610m = ~10km — generous, only erases tiny noise
  // At z11: 16px * 36m = ~576m — catches mudflat noise, preserves real features
  // Fire Island (~3km x 1km at z11) = ~80x27 = 2160 pixels — well above threshold
  const MIN_ISLAND_PX = zoom <= 10 ? 8 : 16

  // Erase isolated small land fragments
  const erodedPixels = []
  let erasedComponents = 0
  for (const [label, size] of componentSizes) {
    if (!componentIsLand.get(label)) continue  // skip ocean components
    if (componentIsEdge.get(label)) continue   // connected to edge = real land
    if (size >= MIN_ISLAND_PX) continue        // big enough to be a real island

    // This is a small isolated land fragment — erase it
    erasedComponents++
    for (let i = 0; i < total; i++) {
      if (labels[i] === label) {
        erodedPixels.push({ row: (i / N) | 0, col: i % N, origElev: elevations[i] })
        result[i] = 0
      }
    }
  }

  // Stats
  let totalComponents = 0, landComponents = 0, edgeLand = 0, isolatedLand = 0, preservedIslands = 0
  for (const [label, ] of componentSizes) {
    totalComponents++
    if (componentIsLand.get(label)) {
      landComponents++
      if (componentIsEdge.get(label)) edgeLand++
      else {
        isolatedLand++
        if (componentSizes.get(label) >= MIN_ISLAND_PX) preservedIslands++
      }
    }
  }

  console.log(`    [FloodFill] ${totalComponents} components (${landComponents} land, ${totalComponents - landComponents} ocean)`)
  console.log(`    [FloodFill] Land: ${edgeLand} edge-connected, ${isolatedLand} isolated (${erasedComponents} erased, ${preservedIslands} preserved as islands)`)
  console.log(`    [FloodFill] ${erodedPixels.length} pixels erased (threshold: ${MIN_ISLAND_PX}px)`)

  return { result, erodedPixels, stats: { totalComponents, landComponents, edgeLand, isolatedLand, erasedComponents, preservedIslands, minIslandPx: MIN_ISLAND_PX } }
}

// ─── Statistics ────────────────────────────────────────────────────────────────

function tileStats(elevations) {
  let oceanPx = 0, landPx = 0, minElev = Infinity, maxElev = -Infinity
  for (let i = 0; i < elevations.length; i++) {
    if (elevations[i] <= OCEAN_THRESHOLD) oceanPx++
    else landPx++
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
    const erosionPxJson = JSON.stringify(r.erosionPixels.map(p => [p.row, p.col]))
    const floodPxJson = JSON.stringify(r.floodPixels.map(p => [p.row, p.col]))

    return `
    <div class="tile-pair">
      <h2>${r.name}</h2>
      <p>Tile: z${r.zoom}/${r.tx}/${r.ty} &nbsp;|&nbsp;
         ${r.stats.oceanPx} ocean (${(r.stats.oceanPx / r.stats.total * 100).toFixed(1)}%)
         &nbsp;|&nbsp; ${r.stats.landPx} land
         &nbsp;|&nbsp; Elev: ${r.stats.minElev.toFixed(0)}m to ${r.stats.maxElev.toFixed(0)}m</p>
      <p>Neighbor erosion: <strong class="eroded">${r.erosionPixels.length} pixels</strong> erased
         &nbsp;|&nbsp; Flood-fill: <strong class="flood">${r.floodPixels.length} pixels</strong> erased
         ${r.floodStats ? `(${r.floodStats.erasedComponents} fragments, threshold ${r.floodStats.minIslandPx}px, ${r.floodStats.preservedIslands} islands preserved)` : ''}</p>
      <div class="canvases">
        <div><h3>Raw DEM</h3><canvas id="c${idx}a" width="256" height="256"></canvas></div>
        <div><h3>Neighbor Erosion (red = erased)</h3><canvas id="c${idx}b" width="256" height="256"></canvas></div>
        <div><h3>Flood-Fill Clean (magenta = erased)</h3><canvas id="c${idx}c" width="256" height="256"></canvas></div>
        <div><h3>Side-by-side diff</h3><canvas id="c${idx}d" width="256" height="256"></canvas></div>
      </div>
      ${r.floodPixels.length > 0 ? `
      <details><summary>Flood-fill erased elevations (${r.floodPixels.length} px)</summary>
        <p style="font-size:11px;max-height:100px;overflow:auto">${r.floodPixels.map(p => p.origElev.toFixed(1)+'m').join(', ')}</p>
      </details>` : ''}
      <script>(function(){
        const N=256, rawB64="${rawB64}", erosionB64="${erosionB64}", floodB64="${floodB64}";
        const erosionPx=${erosionPxJson}, floodPx=${floodPxJson};
        function d(b){const s=atob(b),a=new ArrayBuffer(s.length),u=new Uint8Array(a);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return new Float32Array(a)}
        function elRange(e){let mn=Infinity,mx=-Infinity;for(let i=0;i<e.length;i++){if(e[i]>0){if(e[i]<mn)mn=e[i];if(e[i]>mx)mx=e[i]}}return[mn,mx-mn||1]}
        function draw(id,elev,highlights,hColor){
          const cv=document.getElementById(id),ctx=cv.getContext('2d'),img=ctx.createImageData(N,N);
          const[mn,rng]=elRange(elev);
          for(let i=0;i<N*N;i++){const o=i*4;if(elev[i]<=0){img.data[o]=5;img.data[o+1]=15;img.data[o+2]=40}else{const t=(elev[i]-mn)/rng;img.data[o]=Math.round(40+160*t);img.data[o+1]=Math.round(120+80*(1-t));img.data[o+2]=Math.round(30+30*(1-t))}img.data[o+3]=255}
          if(highlights)for(const[r,c]of highlights){const o=(r*N+c)*4;img.data[o]=hColor[0];img.data[o+1]=hColor[1];img.data[o+2]=hColor[2]}
          ctx.putImageData(img,0,0);
        }
        function drawDiff(id,raw,erosionPx,floodPx){
          const cv=document.getElementById(id),ctx=cv.getContext('2d'),img=ctx.createImageData(N,N);
          for(let i=0;i<N*N;i++){const o=i*4;if(raw[i]<=0){img.data[o]=2;img.data[o+1]=5;img.data[o+2]=15}else{img.data[o]=30;img.data[o+1]=40;img.data[o+2]=20}img.data[o+3]=255}
          // Flood-fill only: magenta
          const floodSet=new Set(floodPx.map(([r,c])=>r*N+c));
          const erosionSet=new Set(erosionPx.map(([r,c])=>r*N+c));
          for(const idx of floodSet){if(!erosionSet.has(idx)){const o=idx*4;img.data[o]=255;img.data[o+1]=0;img.data[o+2]=255}}
          // Erosion only: red
          for(const idx of erosionSet){if(!floodSet.has(idx)){const o=idx*4;img.data[o]=255;img.data[o+1]=0;img.data[o+2]=0}}
          // Both: yellow
          for(const idx of floodSet){if(erosionSet.has(idx)){const o=idx*4;img.data[o]=255;img.data[o+1]=255;img.data[o+2]=0}}
          ctx.putImageData(img,0,0);
        }
        const raw=d(rawB64),erosion=d(erosionB64),flood=d(floodB64);
        draw('c${idx}a',raw,null,[0,0,0]);
        draw('c${idx}b',erosion,erosionPx,[255,0,0]);
        draw('c${idx}c',flood,floodPx,[255,0,255]);
        drawDiff('c${idx}d',raw,erosionPx,floodPx);
      })()</script>
    </div>`
  }).join('\n')

  return `<!DOCTYPE html><html><head><title>Erosion vs Flood-Fill Comparison</title>
<style>
  body{background:#1a1a2e;color:#e0e0e0;font-family:monospace;max-width:1600px;margin:0 auto;padding:20px}
  h1{color:#84d1db} h2{color:#a0d0a0;border-bottom:1px solid #333;padding-bottom:8px} h3{color:#ccc;font-size:13px}
  .tile-pair{margin-bottom:40px;background:#0f0f23;padding:20px;border-radius:8px}
  .canvases{display:flex;gap:16px;flex-wrap:wrap} .canvases>div{text-align:center}
  canvas{border:1px solid #333;image-rendering:pixelated;width:256px;height:256px}
  p{color:#aaa;font-size:13px} strong{color:#ff6b6b}
  .flood{color:#ff44ff}
  .summary-box{background:#0a1a2a;padding:15px;border-radius:8px;margin-bottom:30px;border:1px solid #234}
  .summary-box h2{border:none;margin:0 0 10px 0}
  details{margin-top:8px} summary{cursor:pointer;color:#84d1db}
</style></head><body>
  <h1>Spike Removal: Neighbor Erosion vs Flood-Fill</h1>
  <div class="summary-box">
    <h2>Two approaches compared</h2>
    <p><strong style="color:#ff6666">Method A — Neighbor Erosion:</strong> For each land pixel, count ocean neighbors.
       z8-z10: erase if >= 6/8 ocean. z11-z13: >= 7/8. Two passes.</p>
    <p><strong style="color:#ff44ff">Method B — Flood-Fill:</strong> Label all connected land components.
       Any land fragment NOT connected to the tile edge AND smaller than threshold (z8-z10: 8px, z11+: 16px) is erased.</p>
    <p>Diff canvas: <span style="color:#f00">red</span> = erosion only,
       <span style="color:#f0f">magenta</span> = flood-fill only,
       <span style="color:#ff0">yellow</span> = both agree</p>
  </div>
  ${tiles}
</body></html>`
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Erosion vs Flood-Fill Comparison ===\n')
  const results = []

  for (const loc of TEST_LOCATIONS) {
    console.log(`\n${loc.name}:`)
    const { x: tx, y: ty } = latLngToTileXY(loc.lat, loc.lng, loc.zoom)
    console.log(`  Tile: z${loc.zoom}/${tx}/${ty}`)
    const nw = tileTopLeft(tx, ty, loc.zoom)
    const se = tileTopLeft(tx + 1, ty + 1, loc.zoom)
    const pixelSize = ((nw.lat - se.lat) * 111132) / 256
    console.log(`  Pixel: ~${pixelSize.toFixed(1)}m`)

    try {
      const { elevations } = await fetchTile(loc.zoom, tx, ty)
      const stats = tileStats(elevations)
      console.log(`  Ocean: ${stats.oceanPx}, Land: ${stats.landPx}, Elev: ${stats.minElev.toFixed(0)} to ${stats.maxElev.toFixed(0)}m`)

      if (stats.oceanPx === 0) {
        console.log(`  No ocean — skipped`)
        results.push({ name: loc.name, zoom: loc.zoom, tx, ty, raw: elevations,
          erosionResult: elevations, erosionPixels: [],
          floodResult: elevations, floodPixels: [], floodStats: null, stats })
        continue
      }

      console.log(`  --- Method A: Neighbor Erosion ---`)
      const erosion = runErosion(elevations, loc.zoom)

      console.log(`  --- Method B: Flood-Fill ---`)
      const flood = floodFillClean(elevations, loc.zoom)

      results.push({ name: loc.name, zoom: loc.zoom, tx, ty, raw: elevations,
        erosionResult: erosion.result, erosionPixels: erosion.erodedPixels,
        floodResult: flood.result, floodPixels: flood.erodedPixels,
        floodStats: flood.stats, stats })
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
