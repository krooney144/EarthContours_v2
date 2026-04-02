#!/usr/bin/env node
/**
 * Diagnostic: Spike Erosion Test
 *
 * Fetches real AWS Terrarium tiles, runs the proposed 2-pass 6/8 erosion,
 * and generates an HTML report with before/after visualization.
 *
 * Usage:  node diagnostic/erosion-test.mjs
 * Output: diagnostic/erosion-report.html (open in browser)
 *
 * NO dependencies beyond Node built-ins (fetch + fs + Buffer).
 * Does NOT modify any app code.
 */

import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AWS_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
const TILE_PX = 256

// ─── Test Locations ────────────────────────────────────────────────────────────

const TEST_LOCATIONS = [
  { name: 'Anchorage (z8 — far band)',  lat: 61.3252, lng: -149.8744, zoom: 8  },
  { name: 'Anchorage (z10 — mid band)', lat: 61.3252, lng: -149.8744, zoom: 10 },
  { name: 'Anchorage (z11 — mid-near)', lat: 61.3252, lng: -149.8744, zoom: 11 },
  { name: 'Hawaii Maui (z8 — far)',     lat: 20.7984, lng: -156.3319, zoom: 8  },
  { name: 'Hawaii Maui (z10 — mid)',    lat: 20.7984, lng: -156.3319, zoom: 10 },
  { name: 'Colorado Rockies (z8)',       lat: 39.1178, lng: -106.4453, zoom: 8  },
  { name: 'Colorado Rockies (z10)',      lat: 39.1178, lng: -106.4453, zoom: 10 },
  // Fire Island in Cook Inlet — small island, should NOT be eroded at z11
  { name: 'Fire Island AK (z11)',        lat: 61.17,   lng: -150.22,  zoom: 11 },
]

// ─── Tile Math (matches skylineWorker.ts exactly) ──────────────────────────────

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

// ─── Fetch & Decode a Terrarium Tile ───────────────────────────────────────────

async function fetchTile(z, x, y) {
  const url = `${AWS_BASE}/${z}/${x}/${y}.png`
  console.log(`  Fetching ${url}`)

  // Use curl because Node fetch may be blocked in some environments
  const { execSync } = await import('child_process')
  const buf = execSync(`curl -s "${url}"`, { maxBuffer: 10 * 1024 * 1024 })
  const pngBytes = new Uint8Array(buf)

  // Decode PNG using a minimal approach: extract IDAT chunks and inflate
  const pixels = await decodePNG(pngBytes)

  // Convert Terrarium RGB → elevation
  const elevations = new Float32Array(TILE_PX * TILE_PX)
  for (let i = 0; i < TILE_PX * TILE_PX; i++) {
    const r = pixels[i * 4]
    const g = pixels[i * 4 + 1]
    const b = pixels[i * 4 + 2]
    elevations[i] = r * 256 + g + b / 256 - 32768
  }
  return { elevations, pngBytes, pixels }
}

// ─── Minimal PNG decoder (no dependencies) ─────────────────────────────────────

import { createInflate } from 'zlib'

function decodePNG(pngBytes) {
  return new Promise((resolve, reject) => {
    // Verify PNG signature
    const sig = [137, 80, 78, 71, 13, 10, 26, 10]
    for (let i = 0; i < 8; i++) {
      if (pngBytes[i] !== sig[i]) return reject(new Error('Not a PNG'))
    }

    // Parse chunks, collect IDAT data
    let offset = 8
    let width = 0, height = 0, bitDepth = 0, colorType = 0
    const idatChunks = []

    while (offset < pngBytes.length) {
      const len = readU32(pngBytes, offset)
      const type = String.fromCharCode(
        pngBytes[offset + 4], pngBytes[offset + 5],
        pngBytes[offset + 6], pngBytes[offset + 7]
      )

      if (type === 'IHDR') {
        width = readU32(pngBytes, offset + 8)
        height = readU32(pngBytes, offset + 12)
        bitDepth = pngBytes[offset + 16]
        colorType = pngBytes[offset + 17]
      } else if (type === 'IDAT') {
        idatChunks.push(pngBytes.slice(offset + 8, offset + 8 + len))
      } else if (type === 'IEND') {
        break
      }

      offset += 12 + len // 4 len + 4 type + data + 4 crc
    }

    // Concatenate IDAT chunks and inflate
    const compressed = Buffer.concat(idatChunks.map(c => Buffer.from(c)))
    const inflate = createInflate()
    const chunks = []
    inflate.on('data', chunk => chunks.push(chunk))
    inflate.on('end', () => {
      const raw = Buffer.concat(chunks)
      // De-filter: each row has a filter byte + width * bytesPerPixel
      const bpp = colorType === 2 ? 3 : 4 // RGB=3, RGBA=4
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
            case 0: currRow[i] = x; break                          // None
            case 1: currRow[i] = (x + a) & 0xff; break            // Sub
            case 2: currRow[i] = (x + b) & 0xff; break            // Up
            case 3: currRow[i] = (x + ((a + b) >> 1)) & 0xff; break // Average
            case 4: currRow[i] = (x + paethPredictor(a, b, c)) & 0xff; break // Paeth
            default: currRow[i] = x
          }
        }

        // Copy to RGBA output
        for (let col = 0; col < width; col++) {
          const srcOff = col * bpp
          const dstOff = (row * width + col) * 4
          pixels[dstOff]     = currRow[srcOff]
          pixels[dstOff + 1] = currRow[srcOff + 1]
          pixels[dstOff + 2] = currRow[srcOff + 2]
          pixels[dstOff + 3] = bpp === 4 ? currRow[srcOff + 3] : 255
        }

        prevRow = currRow
      }

      resolve(pixels)
    })
    inflate.on('error', reject)
    inflate.end(compressed)
  })
}

function readU32(buf, off) {
  return (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0
}

function paethPredictor(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

// ─── Erosion Logic (proposed algorithm) ────────────────────────────────────────

const OCEAN_THRESHOLD = 0     // elevation <= this is ocean

// Zoom-adaptive thresholds: how many of 8 neighbors must be ocean to erode
function spikeThresholdForZoom(zoom) {
  if (zoom <= 10) return 6   // z8-z10 (150-610m/px): aggressive — no real 1px features
  if (zoom <= 13) return 7   // z11-z13 (19-76m/px): conservative — narrow peninsulas possible
  return 9                    // z14-z15: effectively disabled (can't have 9/8)
}

function runErosion(elevations, passes = 2, zoom = 8) {
  const N = TILE_PX
  const result = new Float32Array(elevations)  // copy
  const erodedPixels = []  // track what we erode for visualization

  for (let pass = 0; pass < passes; pass++) {
    const snapshot = new Float32Array(result)  // read from snapshot, write to result
    let passEroded = 0

    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        const idx = row * N + col
        if (snapshot[idx] <= OCEAN_THRESHOLD) continue  // already ocean

        // Count ocean neighbors (8-connected)
        let oceanCount = 0
        let neighborCount = 0
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue
            const nr = row + dr, nc = col + dc
            if (nr < 0 || nr >= N || nc < 0 || nc >= N) {
              // Edge pixels: treat tile boundary as unknown (not ocean)
              continue
            }
            neighborCount++
            if (snapshot[nr * N + nc] <= OCEAN_THRESHOLD) oceanCount++
          }
        }

        if (neighborCount > 0 && oceanCount >= spikeThresholdForZoom(zoom)) {
          result[idx] = 0
          erodedPixels.push({ row, col, pass, origElev: elevations[idx], oceanNeighbors: oceanCount })
          passEroded++
        }
      }
    }
    console.log(`    Pass ${pass + 1}: eroded ${passEroded} pixels`)
  }

  return { eroded: result, erodedPixels }
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

// ─── HTML Report Generator ─────────────────────────────────────────────────────

function generateHTML(results) {
  const tileCanvases = results.map((r, idx) => {
    // Encode elevation data as base64 for the browser to render
    const rawB64 = Buffer.from(r.raw.buffer).toString('base64')
    const erodedB64 = Buffer.from(r.eroded.buffer).toString('base64')
    // Encode eroded pixel coordinates
    const erodedPxJson = JSON.stringify(r.erodedPixels)

    return `
    <div class="tile-pair" id="tile-${idx}">
      <h2>${r.name}</h2>
      <p>Tile: z${r.zoom}/${r.tx}/${r.ty} &nbsp;|&nbsp;
         ${r.stats.oceanPx} ocean px (${(r.stats.oceanPx / r.stats.total * 100).toFixed(1)}%)
         &nbsp;|&nbsp; ${r.stats.landPx} land px
         &nbsp;|&nbsp; Elev range: ${r.stats.minElev.toFixed(1)}m to ${r.stats.maxElev.toFixed(1)}m
         &nbsp;|&nbsp; <strong>${r.erodedPixels.length} pixels eroded</strong></p>
      <div class="canvases">
        <div>
          <h3>Before (raw DEM)</h3>
          <canvas id="before-${idx}" width="256" height="256"></canvas>
        </div>
        <div>
          <h3>After (eroded) — red = eroded pixels</h3>
          <canvas id="after-${idx}" width="256" height="256"></canvas>
        </div>
        <div>
          <h3>Diff only (eroded pixels highlighted)</h3>
          <canvas id="diff-${idx}" width="256" height="256"></canvas>
        </div>
      </div>
      ${r.erodedPixels.length > 0 ? `
      <details>
        <summary>Eroded pixel details (${r.erodedPixels.length} pixels)</summary>
        <table>
          <tr><th>Row</th><th>Col</th><th>Pass</th><th>Original Elev (m)</th><th>Ocean Neighbors</th></tr>
          ${r.erodedPixels.map(p =>
            `<tr><td>${p.row}</td><td>${p.col}</td><td>${p.pass + 1}</td><td>${p.origElev.toFixed(2)}</td><td>${p.oceanNeighbors}/8</td></tr>`
          ).join('')}
        </table>
      </details>` : ''}
      <script>
        (function() {
          const rawB64 = "${rawB64}";
          const erodedB64 = "${erodedB64}";
          const erodedPx = ${erodedPxJson};
          const N = 256;

          function b64ToF32(b64) {
            const bin = atob(b64);
            const buf = new ArrayBuffer(bin.length);
            const u8 = new Uint8Array(buf);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            return new Float32Array(buf);
          }

          function drawElevation(canvasId, elevData, highlightPixels) {
            const canvas = document.getElementById(canvasId);
            const ctx = canvas.getContext('2d');
            const imgData = ctx.createImageData(N, N);

            // Find elevation range for this tile
            let minE = Infinity, maxE = -Infinity;
            for (let i = 0; i < elevData.length; i++) {
              if (elevData[i] > 0) {
                if (elevData[i] < minE) minE = elevData[i];
                if (elevData[i] > maxE) maxE = elevData[i];
              }
            }
            const range = maxE - minE || 1;

            for (let i = 0; i < N * N; i++) {
              const off = i * 4;
              if (elevData[i] <= 0) {
                // Ocean: dark blue
                imgData.data[off]     = 5;
                imgData.data[off + 1] = 15;
                imgData.data[off + 2] = 40;
              } else {
                // Land: green-to-brown elevation ramp
                const t = (elevData[i] - minE) / range;
                imgData.data[off]     = Math.round(40 + 160 * t);
                imgData.data[off + 1] = Math.round(120 + 80 * (1 - t));
                imgData.data[off + 2] = Math.round(30 + 30 * (1 - t));
              }
              imgData.data[off + 3] = 255;
            }

            // Highlight eroded pixels in bright red
            if (highlightPixels) {
              for (const p of highlightPixels) {
                const off = (p.row * N + p.col) * 4;
                imgData.data[off]     = 255;
                imgData.data[off + 1] = 0;
                imgData.data[off + 2] = 0;
                imgData.data[off + 3] = 255;
              }
            }

            ctx.putImageData(imgData, 0, 0);
          }

          function drawDiff(canvasId, rawData, erodedPx) {
            const canvas = document.getElementById(canvasId);
            const ctx = canvas.getContext('2d');
            const imgData = ctx.createImageData(N, N);

            // Dim background
            for (let i = 0; i < N * N; i++) {
              const off = i * 4;
              if (rawData[i] <= 0) {
                imgData.data[off] = 2; imgData.data[off+1] = 5; imgData.data[off+2] = 15;
              } else {
                imgData.data[off] = 30; imgData.data[off+1] = 40; imgData.data[off+2] = 20;
              }
              imgData.data[off + 3] = 255;
            }

            // Bright red for eroded, yellow halo for their neighbors
            for (const p of erodedPx) {
              // Yellow halo (3x3 around eroded pixel)
              for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                  const nr = p.row + dr, nc = p.col + dc;
                  if (nr >= 0 && nr < N && nc >= 0 && nc < N) {
                    const off = (nr * N + nc) * 4;
                    if (imgData.data[off] < 200) {  // don't overwrite red
                      imgData.data[off] = 255; imgData.data[off+1] = 255; imgData.data[off+2] = 0;
                    }
                  }
                }
              }
              // Red center
              const off = (p.row * N + p.col) * 4;
              imgData.data[off] = 255; imgData.data[off+1] = 0; imgData.data[off+2] = 0;
            }

            ctx.putImageData(imgData, 0, 0);
          }

          const raw = b64ToF32(rawB64);
          const eroded = b64ToF32(erodedB64);
          drawElevation('before-${idx}', raw, null);
          drawElevation('after-${idx}', eroded, erodedPx);
          drawDiff('diff-${idx}', raw, erodedPx);
        })();
      </script>
    </div>`
  }).join('\n')

  return `<!DOCTYPE html>
<html>
<head>
  <title>Spike Erosion Diagnostic</title>
  <style>
    body { background: #1a1a2e; color: #e0e0e0; font-family: monospace; max-width: 1400px; margin: 0 auto; padding: 20px; }
    h1 { color: #84d1db; }
    h2 { color: #a0d0a0; border-bottom: 1px solid #333; padding-bottom: 8px; }
    h3 { color: #ccc; font-size: 14px; }
    .tile-pair { margin-bottom: 40px; background: #0f0f23; padding: 20px; border-radius: 8px; }
    .canvases { display: flex; gap: 20px; flex-wrap: wrap; }
    .canvases > div { text-align: center; }
    canvas { border: 1px solid #333; image-rendering: pixelated; width: 256px; height: 256px; }
    table { border-collapse: collapse; margin-top: 10px; font-size: 12px; }
    th, td { border: 1px solid #444; padding: 4px 8px; text-align: right; }
    th { background: #1a2a1a; }
    details { margin-top: 10px; }
    summary { cursor: pointer; color: #84d1db; }
    p { color: #aaa; }
    strong { color: #ff6b6b; }
    .summary-box { background: #0a1a2a; padding: 15px; border-radius: 8px; margin-bottom: 30px; border: 1px solid #234; }
    .summary-box h2 { border: none; margin: 0 0 10px 0; }
    .pass { color: #ffd700; }
    .safe { color: #4caf50; }
    .eroded { color: #ff6b6b; }
  </style>
</head>
<body>
  <h1>Spike Erosion Diagnostic Report</h1>
  <div class="summary-box">
    <h2>Algorithm: 2-pass, zoom-adaptive neighbor threshold</h2>
    <p>For each land pixel (elevation > 0), count how many of its 8 immediate neighbors have elevation ≤ 0.
       Threshold: z8-z10 → 6/8, z11-z13 → 7/8, z14-z15 → disabled. Run twice to catch small clusters.</p>
    <p>Color key: <span style="color:#050f28">■</span> ocean &nbsp;
       <span style="color:#78a030">■</span> land &nbsp;
       <span class="eroded">■</span> eroded pixel &nbsp;
       <span style="color:#ffff00">■</span> halo (context around eroded)</p>
  </div>
  ${tileCanvases}
</body>
</html>`
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Spike Erosion Diagnostic ===\n')
  const results = []

  for (const loc of TEST_LOCATIONS) {
    console.log(`\n${loc.name}:`)
    const { x: tx, y: ty } = latLngToTileXY(loc.lat, loc.lng, loc.zoom)
    console.log(`  Tile coords: z${loc.zoom}/${tx}/${ty}`)

    // Compute tile geographic bounds
    const nw = tileTopLeft(tx, ty, loc.zoom)
    const se = tileTopLeft(tx + 1, ty + 1, loc.zoom)
    console.log(`  Bounds: ${nw.lat.toFixed(4)}°N ${nw.lng.toFixed(4)}°E → ${se.lat.toFixed(4)}°N ${se.lng.toFixed(4)}°E`)
    const pixelSize = ((nw.lat - se.lat) * 111132) / 256
    console.log(`  Pixel size: ~${pixelSize.toFixed(1)}m`)

    try {
      const { elevations } = await fetchTile(loc.zoom, tx, ty)
      const stats = tileStats(elevations)
      console.log(`  Stats: ${stats.oceanPx} ocean, ${stats.landPx} land, elev ${stats.minElev.toFixed(1)} to ${stats.maxElev.toFixed(1)}m`)

      if (stats.oceanPx === 0) {
        console.log(`  ✓ No ocean pixels — erosion skipped (early-out)`)
        results.push({
          name: loc.name, zoom: loc.zoom, tx, ty,
          raw: elevations, eroded: elevations,
          erodedPixels: [], stats,
        })
        continue
      }

      const { eroded, erodedPixels } = runErosion(elevations, 2, loc.zoom)
      console.log(`  → ${erodedPixels.length} total pixels eroded`)

      if (erodedPixels.length > 0) {
        console.log(`  Eroded pixel elevations: ${erodedPixels.map(p => p.origElev.toFixed(1) + 'm').join(', ')}`)
      }

      results.push({
        name: loc.name, zoom: loc.zoom, tx, ty,
        raw: elevations, eroded, erodedPixels, stats,
      })
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`)
    }
  }

  // Generate HTML report
  const html = generateHTML(results)
  const outPath = join(__dirname, 'erosion-report.html')
  writeFileSync(outPath, html)
  console.log(`\n✓ Report written to: ${outPath}`)
  console.log('  Open in a browser to see before/after visualizations.')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
