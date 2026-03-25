/// <reference lib="webworker" />

/**
 * EarthContours — Skyline Web Worker
 *
 * Pre-computes a full 360° terrain skyline for the SCAN screen.
 * Runs in a separate thread so the UI stays responsive during the
 * ~1–2 s computation.
 *
 * ── Algorithm ──────────────────────────────────────────────────────────────
 *
 *  Phase 1 — Tile prefetch:
 *    Fetch AWS Terrarium tiles for z15/z14/z13/z11/z9/z8 in parallel.
 *    Uses createImageBitmap + OffscreenCanvas for PNG decoding (worker-safe).
 *
 *  Phase 2 — Build distance step arrays:
 *    Standard pass (500m→400km @ 1.015×), hi-res pass (200m→31km @ 1.01×),
 *    ultra-near pass (20m→200m @ 1.005× at 360 azimuths).
 *
 *  Phase 3 — Standard resolution skyline (1440 azimuths, full range)
 *  Phase 4 — High-res pass (2880 azimuths, 0–31km for bands with resolution=8)
 *  Phase 4b — Ultra-near pass (360 azimuths, 20–200m for ultra-near band)
 *  Phase 5 — Pack crossing data into flat transferable arrays
 *
 *  Contour intervals: 50ft (ultra-near) → 100ft → 200ft → 500ft → 1000ft → 2000ft (far)
 *
 *  Output: SkylineData with transferable ArrayBuffers (zero-copy to main thread).
 *
 * ── Peak Refinement (second pass) ───────────────────────────────────────────
 *
 *  After the main skyline is delivered, the main thread identifies visible peaks
 *  and sends a 'refine-peaks' message with peak bearings + distances.
 *  The worker then:
 *    1. Fetches HIGHER-ZOOM tiles around each peak (e.g. z13 at 40km, not z11)
 *    2. Dense ray-march at 0.05° azimuth steps (5× finer than hi-res bands)
 *    3. Fine distance steps (1.005×) for the band containing each peak
 *    4. Sends back refined arcs with raw elevation/distance/GPS per sample
 *
 *  This gives genuinely more terrain detail around peaks, not just resampled data.
 *
 * ── Message Protocol ───────────────────────────────────────────────────────
 *
 *  Main → Worker:  SkylineRequest  (no type field — skyline computation)
 *  Main → Worker:  { type:'refine-peaks', peaks: PeakRefineItem[] }
 *  Worker → Main:  { type:'progress', phase, progress }
 *                  { type:'complete',  skyline: SkylineData }
 *                  { type:'refined-arcs', refinedArcs: RefinedArc[], timestamp }
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const AWS_BASE      = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
const TILE_PX       = 256
const EARTH_R       = 6_371_000   // metres
const REFRACTION_K  = 0.13
const DEG_TO_RAD    = Math.PI / 180
// NW-45° sun direction (ENU: x=east, y=up, z=north)
const LIGHT_X = -0.5, LIGHT_Y = 0.707, LIGHT_Z = 0.5

// ─── Contour Intervals Per Band ──────────────────────────────────────────────

/** Contour interval in metres for each depth band index.
 *  Progressive density: dense where visible (near), sparse where faded (far).
 *  ultra-near = 50ft, near = 100ft, mid-near = 200ft,
 *  mid = 200ft, mid-far = 500ft, far = 1000ft. */
const CONTOUR_INTERVALS_M: number[] = [
  15.24,   // ultra-near: 50ft
  30.48,   // near:       100ft
  60.96,   // mid-near:   200ft
  60.96,   // mid:        200ft
  152.4,   // mid-far:    500ft
  304.8,   // far:        1000ft
]

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SkylineRequest {
  viewerLat:    number
  viewerLng:    number
  /** Eye height above ground in metres (AGL). Worker resolves ground elevation from tiles. */
  viewerHeightM: number
  /** Steps per degree — 2 = 0.5°/step (720 azimuths) */
  resolution:   number
  /** Maximum ray distance in metres */
  maxRange:     number
}

/** Depth band distance config — mirrors DEPTH_BANDS from types.ts */
interface BandConfig {
  label:      string
  minDist:    number
  maxDist:    number
  resolution?: number   // Per-band azimuth resolution override
}

const DEPTH_BANDS: BandConfig[] = [
  { label: 'ultra-near', minDist: 0,       maxDist: 4_500,   resolution: 8 },  // 0–4.5 km   (0.125°, 2880 az)
  { label: 'near',       minDist: 4_000,   maxDist: 10_500,  resolution: 8 },  // 4–10.5 km  (0.125°, 2880 az)
  { label: 'mid-near',   minDist: 10_000,  maxDist: 31_000,  resolution: 8 },  // 10–31 km   (0.125°, 2880 az)
  { label: 'mid',        minDist: 30_000,  maxDist: 81_000  },                  // 30–81 km   (0.25°, 1440 az)
  { label: 'mid-far',    minDist: 80_000,  maxDist: 152_000 },                  // 80–152 km  (0.25°, 1440 az)
  { label: 'far',        minDist: 150_000, maxDist: 400_000 },                  // 150–400 km (0.25°, 1440 az)
]

interface SkylineBand {
  elevations:  Float32Array
  distances:   Float32Array
  ridgeLats:   Float32Array
  ridgeLngs:   Float32Array
  crossingData:    Float32Array
  crossingOffsets: Uint32Array
  resolution:  number      // Steps per degree for this band
  numAzimuths: number      // 360 × resolution
}

/** Refined arc: dense ray-march data around a detected ridgeline feature. */
interface RefinedArc {
  centerBearing: number
  halfWidth:     number
  numSamples:    number
  stepDeg:       number
  elevations:    Float32Array
  distances:     Float32Array
  ridgeLats:     Float32Array
  ridgeLngs:     Float32Array
  bandIndex:     number
  featureDist:   number
  featureElev:   number
  featureBearing: number
}

/** Packed silhouette candidates for depth-peeled terrain layers. */
interface SilhouetteDataW {
  candidateData:    Float32Array
  candidateOffsets: Uint32Array
  resolution:       number
  numAzimuths:      number
}

/** Near-field profile data produced by the worker (mirrors types.ts NearFieldProfile). */
interface NearFieldProfileW {
  profileData:    Float32Array
  sampleCounts:   Uint16Array
  resolution:     number
  numAzimuths:    number
  floatsPerSample: 2
}

export interface SkylineData {
  /** Max elevation angle (radians) at each azimuth step */
  angles:      Float32Array
  /** Distance to ridgeline (metres) */
  distances:   Float32Array
  /** Hill shade at ridgeline [0–1] */
  shading:     Float32Array
  /** Per-depth-band raw world data (near/mid/far) */
  bands:       SkylineBand[]
  /** Refined arcs — dense ray-march data around detected ridgeline features */
  refinedArcs: RefinedArc[]
  /** Depth-peeled silhouette candidates (AGL-independent, all azimuths) */
  silhouette:  SilhouetteDataW | null
  /** Dense near-field elevation profile (0–2km) for opaque terrain occlusion */
  nearProfile: NearFieldProfileW | null
  /** Steps per degree used during computation */
  resolution:  number
  /** Total azimuth steps (= 360 × resolution) */
  numAzimuths: number
  computedAt: { lat: number; lng: number; elev: number; groundElev: number; timestamp: number }
}

// ─── Silhouette Distance Bins (mirrors types.ts DISTANCE_BINS) ───────────────

/** [minDist_m, maxDist_m, maxCandidates] — must stay in sync with types.ts */
const SILHOUETTE_BINS: readonly [number, number, number][] = [
  [0,        1_000,   5],
  [1_000,    5_000,   5],
  [5_000,   15_000,   5],
  [15_000,  40_000,   4],
  [40_000, 100_000,   3],
  [100_000, 250_000,  2],
  [250_000, 400_000,  2],
]
const SILHOUETTE_FLOATS = 8  // per candidate: effElev, rawElev, dist, lat, lng, baseEffElev, baseDist, flags
const SILHOUETTE_RESOLUTION = 8  // 0.125° per step = 2880 azimuths (matches hi-res bands)
const SILHOUETTE_NUM_AZIMUTHS = 360 * SILHOUETTE_RESOLUTION  // 2880

/** Map a distance to its bin index. Returns -1 if outside all bins. */
function distToBin(distM: number): number {
  for (let i = 0; i < SILHOUETTE_BINS.length; i++) {
    if (distM >= SILHOUETTE_BINS[i][0] && distM < SILHOUETTE_BINS[i][1]) return i
  }
  // Check last bin's upper bound (inclusive)
  const last = SILHOUETTE_BINS.length - 1
  if (distM >= SILHOUETTE_BINS[last][0] && distM <= SILHOUETTE_BINS[last][1]) return last
  return -1
}

// ─── Silhouette Candidate Heap ───────────────────────────────────────────────

/** A silhouette candidate: a local elevation maximum along an azimuth ray. */
interface SilCandidate {
  effElev:     number  // rawElev - curvDrop (AGL-independent)
  rawElev:     number  // original DEM elevation
  dist:        number  // distance from viewer (m)
  lat:         number  // GPS
  lng:         number
  baseEffElev: number  // valley floor before this peak
  baseDist:    number  // distance to valley floor
  flags:       number  // bit 0 = isOcean
}

/** Per-bin min-heap keyed on effElev, capped at maxSize. */
class CandidateHeap {
  items: SilCandidate[] = []
  constructor(readonly maxSize: number) {}

  insert(c: SilCandidate): void {
    if (this.items.length < this.maxSize) {
      this.items.push(c)
      // Bubble up
      this._siftUp(this.items.length - 1)
    } else if (c.effElev > this.items[0].effElev) {
      // Replace min
      this.items[0] = c
      this._siftDown(0)
    }
  }

  /** Return items sorted by distance (near first) for packing. */
  sortedByDist(): SilCandidate[] {
    return this.items.slice().sort((a, b) => a.dist - b.dist)
  }

  private _siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.items[i].effElev < this.items[parent].effElev) {
        const tmp = this.items[i]; this.items[i] = this.items[parent]; this.items[parent] = tmp
        i = parent
      } else break
    }
  }

  private _siftDown(i: number): void {
    const n = this.items.length
    while (true) {
      let smallest = i
      const l = 2 * i + 1, r = 2 * i + 2
      if (l < n && this.items[l].effElev < this.items[smallest].effElev) smallest = l
      if (r < n && this.items[r].effElev < this.items[smallest].effElev) smallest = r
      if (smallest !== i) {
        const tmp = this.items[i]; this.items[i] = this.items[smallest]; this.items[smallest] = tmp
        i = smallest
      } else break
    }
  }
}

// ─── In-Worker Tile Cache ─────────────────────────────────────────────────────

const tileCacheW  = new Map<string, Float32Array>()
const pendingW    = new Map<string, Promise<Float32Array | null>>()

// ─── Module-level state for peak refinement ──────────────────────────────────
// Stored at end of each skyline computation so 'refine-peaks' can reuse them
// without the main thread resending the mesh data.

let lastViewerLat          = 0
let lastViewerLng          = 0
let lastCorrectedViewerElev = 0
let lastCosViewerLat       = 1
let lastSkylineComputed = false

async function fetchWorkerTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`
  if (tileCacheW.has(key)) return tileCacheW.get(key)!
  if (pendingW.has(key))   return pendingW.get(key)!

  const p = (async (): Promise<Float32Array | null> => {
    try {
      const resp = await fetch(`${AWS_BASE}/${key}.png`)
      if (!resp.ok) return null
      const blob   = await resp.blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(TILE_PX, TILE_PX)
      const ctx    = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0, TILE_PX, TILE_PX)
      const { data } = ctx.getImageData(0, 0, TILE_PX, TILE_PX)
      const elevations = new Float32Array(TILE_PX * TILE_PX)
      for (let i = 0; i < TILE_PX * TILE_PX; i++) {
        elevations[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768
      }
      tileCacheW.set(key, elevations)
      return elevations
    } catch { return null }
  })()

  pendingW.set(key, p)
  const result = await p
  pendingW.delete(key)
  return result
}

// ─── Math Helpers ─────────────────────────────────────────────────────────────

function latLngToTileXY(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const x    = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom))
  const latR = (lat * Math.PI) / 180
  const y    = Math.floor(
    ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * Math.pow(2, zoom),
  )
  return { x, y }
}

function tileTopLeft(x: number, y: number, zoom: number): { lat: number; lng: number } {
  const n    = Math.pow(2, zoom)
  const lng  = (x / n) * 360 - 180
  const latR = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  return { lat: (latR * 180) / Math.PI, lng }
}

function distToZoom(distM: number): number {
  if (distM < 1_000)   return 15   // ultra-near detail — ~4.8 m/px, 50ft contours
  if (distM < 4_500)   return 14   // ultra-near outer — ~9.5 m/px
  if (distM < 10_500)  return 13   // near — ~19 m/px
  if (distM < 31_000)  return 11   // mid-near — ~76 m/px
  if (distM < 81_000)  return 10   // mid — ~152 m/px
  if (distM < 152_000) return 9    // mid-far — ~305 m/px
  return 8                         // far — ~610 m/px
}

/** Higher-zoom tile selection for peak refinement (1–2 zoom levels above standard).
 *  Provides genuinely more terrain detail around peaks, not just resampled data. */
function distToRefinedZoom(distM: number): number {
  if (distM < 1_000)   return 15   // already max zoom
  if (distM < 4_500)   return 15   // standard=14 → refined=15
  if (distM < 10_500)  return 14   // standard=13 → refined=14
  if (distM < 31_000)  return 13   // standard=11 → refined=13 (+2 levels)
  if (distM < 81_000)  return 11   // standard=10 → refined=11
  if (distM < 152_000) return 10   // standard=9  → refined=10
  return 9                         // standard=8  → refined=9
}

function sampleTileGrid(
  grid: Float32Array, lat: number, lng: number,
  zoom: number, tx: number, ty: number,
): number {
  const nw = tileTopLeft(tx, ty, zoom)
  const se = tileTopLeft(tx + 1, ty + 1, zoom)
  const nx = (lng - nw.lng) / (se.lng - nw.lng)
  const ny = (nw.lat - lat) / (nw.lat - se.lat)
  const sx = Math.max(0, Math.min(TILE_PX - 1, nx * (TILE_PX - 1)))
  const sy = Math.max(0, Math.min(TILE_PX - 1, ny * (TILE_PX - 1)))
  const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, TILE_PX - 1)
  const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, TILE_PX - 1)
  const fx = sx - x0, fy = sy - y0
  return (
    grid[y0 * TILE_PX + x0] * (1 - fx) * (1 - fy) +
    grid[y0 * TILE_PX + x1] * fx       * (1 - fy) +
    grid[y1 * TILE_PX + x0] * (1 - fx) * fy +
    grid[y1 * TILE_PX + x1] * fx       * fy
  )
}

/** Best-available elevation: tile cache first, sea-level fallback.
 *  Clamps to 0 — ocean/negative elevations are treated as sea level. */
function sampleBest(lat: number, lng: number, zoom: number): number {
  const { x: tx, y: ty } = latLngToTileXY(lat, lng, zoom)
  const grid = tileCacheW.get(`${zoom}/${tx}/${ty}`)
  if (grid) return Math.max(0, sampleTileGrid(grid, lat, lng, zoom, tx, ty))
  return 0  // No tile cached — assume sea level (tiles are prefetched so this rarely fires)
}

/** Hill shade at a terrain point (NW-45° light). */
function hillShade(lat: number, lng: number, zoom: number): number {
  const STEP   = zoom >= 11 ? 0.0005 : 0.002
  const cosLat = Math.cos(lat * DEG_TO_RAD)
  const dx_m   = STEP * 111_320 * cosLat
  const dy_m   = STEP * 111_132

  const eE = sampleBest(lat,        lng + STEP, zoom)
  const eW = sampleBest(lat,        lng - STEP, zoom)
  const eN = sampleBest(lat + STEP, lng,        zoom)
  const eS = sampleBest(lat - STEP, lng,        zoom)

  const dzdx = (eE - eW) / (2 * dx_m)
  const dzdy = (eN - eS) / (2 * dy_m)
  const nx = -dzdx, ny = 1.0, nz = -dzdy
  const mag = Math.sqrt(nx * nx + ny * ny + nz * nz)
  return Math.max(0, (nx * LIGHT_X + ny * LIGHT_Y + nz * LIGHT_Z) / mag)
}

// ─── Contour Crossing Detection ──────────────────────────────────────────────

/**
 * Detect elevation crossings between two consecutive ray steps.
 * Pushes 5 floats per crossing: [elevation_m, distance_m, lat, lng, direction].
 * direction: +1.0 = terrain rising outward (up-crossing),
 *            -1.0 = terrain falling outward (down-crossing).
 * prevElev/prevDist are the FARTHER sample (march is far-to-near).
 */
function detectCrossings(
  prevElev: number, prevDist: number, prevLat: number, prevLng: number,
  currElev: number, currDist: number, currLat: number, currLng: number,
  interval: number,
  crossings: number[],  // output: push [elev, dist, lat, lng, dir] tuples
): void {
  if (prevElev === -Infinity || currElev === -Infinity) return
  // Skip crossings involving ocean/sea-level on EITHER side — avoids coastline spike artifacts.
  // Ocean-to-land transitions generate many spurious crossings that render as vertical columns.
  if (prevElev <= 0 || currElev <= 0) return

  const dElev = currElev - prevElev
  if (Math.abs(dElev) < 0.01) return  // Flat — no crossings

  // Direction: prev is farther, curr is nearer.
  // Going outward (curr→prev): if prevElev > currElev terrain rises → up-crossing
  const dir = prevElev > currElev ? 1.0 : -1.0

  const loElev = Math.min(prevElev, currElev)
  const hiElev = Math.max(prevElev, currElev)

  const firstLevel = Math.ceil(loElev / interval) * interval
  if (firstLevel > hiElev) return

  for (let level = firstLevel; level <= hiElev; level += interval) {
    const t = (level - prevElev) / dElev
    if (t < 0 || t > 1) continue

    const cDist = prevDist + t * (currDist - prevDist)
    const cLat  = prevLat  + t * (currLat  - prevLat)
    const cLng  = prevLng  + t * (currLng  - prevLng)

    crossings.push(level, cDist, cLat, cLng, dir)
  }
}

// ─── Worker Message Handler ───────────────────────────────────────────────────

// ─── Peak Refinement Item (from main thread) ────────────────────────────────

interface PeakRefineItem {
  /** Peak bearing from viewer (degrees, 0=N, 90=E) */
  bearing: number
  /** Distance from viewer to peak (metres) */
  distance: number
  /** Which depth band this peak was matched to */
  bandIndex: number
  /** Peak name (for debug logging) */
  name: string
}

// ─── Peak Refinement Handler ─────────────────────────────────────────────────
//
// Called when main thread sends { type: 'refine-peaks', peaks: PeakRefineItem[] }.
// For each peak:
//   1. Determine higher-zoom tile level via distToRefinedZoom()
//   2. Prefetch tiles around the peak's GPS position at that zoom
//   3. Dense ray-march at 0.05° azimuth steps, ±6° around the peak bearing
//   4. Fine distance steps (1.005×) through the peak's band distance range
//   5. Build RefinedArc with raw elevation/distance/GPS per sample
//
// Sends back { type: 'refined-arcs', refinedArcs, timestamp }.

const REFINED_STEP_DEG = 0.05   // ~20 samples/degree (5× finer than hi-res 0.125°)
const REFINED_HALF_DEG = 6      // ±6° centered on peak = 12° total = ~240 samples

async function handleRefinePeaks(peaks: PeakRefineItem[]): Promise<void> {
  if (!lastSkylineComputed) {
    // No skyline computed yet — nothing to refine against
    self.postMessage({ type: 'refined-arcs', refinedArcs: [], timestamp: Date.now() })
    return
  }

  const viewerLat  = lastViewerLat
  const viewerLng  = lastViewerLng
  const correctedViewerElev = lastCorrectedViewerElev
  const cosViewerLat = lastCosViewerLat

  self.postMessage({ type: 'refine-progress', phase: 'tiles', total: peaks.length, done: 0 })

  // ── Step 1: Prefetch higher-zoom tiles around each peak ─────────────────
  // Deduplicate tile requests across all peaks to avoid redundant fetches.
  const tileSet = new Set<string>()
  for (const peak of peaks) {
    const refinedZoom = distToRefinedZoom(peak.distance)
    const azRad = peak.bearing * DEG_TO_RAD
    const peakLat = viewerLat + (Math.cos(azRad) * peak.distance) / 111_132
    const peakLng = viewerLng + (Math.sin(azRad) * peak.distance) / (111_320 * cosViewerLat)

    // Fetch tiles covering the arc span (±6° at peak distance)
    const arcSpanM = peak.distance * Math.tan(REFINED_HALF_DEG * DEG_TO_RAD)
    const dLat = (arcSpanM / 111_132) * 1.3
    const dLng = (arcSpanM / (111_320 * cosViewerLat)) * 1.3
    const sw = latLngToTileXY(peakLat - dLat, peakLng - dLng, refinedZoom)
    const ne = latLngToTileXY(peakLat + dLat, peakLng + dLng, refinedZoom)
    const minX = Math.min(sw.x, ne.x), maxX = Math.max(sw.x, ne.x)
    const minY = Math.min(sw.y, ne.y), maxY = Math.max(sw.y, ne.y)
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        tileSet.add(`${refinedZoom}/${x}/${y}`)
      }
    }
  }

  // Fetch all unique tiles in parallel
  const tileFetches = Array.from(tileSet).map(key => {
    const [z, x, y] = key.split('/').map(Number)
    return fetchWorkerTile(z, x, y)
  })
  await Promise.all(tileFetches)

  self.postMessage({ type: 'refine-progress', phase: 'march', total: peaks.length, done: 0 })

  // ── Step 2: Dense ray-march around each peak ───────────────────────────
  // Optimization: only march ±40% around the peak's known distance (from first
  // pass) instead of the entire band range.  The ridgeline near a peak is at
  // roughly the same distance; ±40% margin catches any adjacent terrain.
  const refinedArcs: RefinedArc[] = []

  for (let pi = 0; pi < peaks.length; pi++) {
    const peak = peaks[pi]
    const numSamples = Math.round((REFINED_HALF_DEG * 2) / REFINED_STEP_DEG) + 1
    const elevations = new Float32Array(numSamples).fill(-Infinity)
    const dists      = new Float32Array(numSamples)
    const lats       = new Float32Array(numSamples)
    const lngs       = new Float32Array(numSamples)

    // Narrow distance range: ±40% of peak distance, clamped to band bounds
    const bandCfg = DEPTH_BANDS[peak.bandIndex]
    const bandMin = bandCfg.minDist || 20
    const bandMax = bandCfg.maxDist
    const marchMin = Math.max(bandMin, peak.distance * 0.6)
    const marchMax = Math.min(bandMax, peak.distance * 1.4)

    // Build fine distance steps — 1.005× for maximum resolution
    const arcDists: number[] = []
    let arcD = Math.max(20, marchMin)
    while (arcD <= marchMax) {
      arcDists.push(arcD)
      arcD *= 1.005
    }
    arcDists.reverse()  // far → near (nearer terrain wins)

    const refinedZoom = distToRefinedZoom(peak.distance)

    for (let si = 0; si < numSamples; si++) {
      const bearingOffset = -REFINED_HALF_DEG + si * REFINED_STEP_DEG
      const azDeg = peak.bearing + bearingOffset
      const azRad = azDeg * DEG_TO_RAD
      const sinA  = Math.sin(azRad)
      const cosA  = Math.cos(azRad)

      let bestAngle = -Math.PI / 2
      let bestDist  = 0
      let bestLat   = viewerLat
      let bestLng   = viewerLng
      let bestElev  = -Infinity as number

      for (const dist of arcDists) {
        const sLat = viewerLat + (cosA * dist) / 111_132
        const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)
        // Use REFINED zoom (higher than standard) for better terrain detail
        const zoom = distToRefinedZoom(dist)
        const rawElev = sampleBest(sLat, sLng, zoom)
        const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
        const effElev  = rawElev - curvDrop
        const elevAngle = Math.atan2(effElev - correctedViewerElev, dist)

        if (elevAngle > Math.PI / 3) continue  // Sanity cap

        if (elevAngle > bestAngle) {
          bestAngle = elevAngle
          bestDist  = dist
          bestLat   = sLat
          bestLng   = sLng
          bestElev  = rawElev
        }
      }

      elevations[si] = bestElev
      dists[si]      = bestDist
      lats[si]       = bestLat
      lngs[si]       = bestLng
    }

    refinedArcs.push({
      centerBearing:  peak.bearing,
      halfWidth:      REFINED_HALF_DEG,
      numSamples,
      stepDeg:        REFINED_STEP_DEG,
      elevations,
      distances:      dists,
      ridgeLats:      lats,
      ridgeLngs:      lngs,
      bandIndex:      peak.bandIndex,
      featureDist:    peak.distance,
      featureElev:    elevations[Math.floor(numSamples / 2)],  // Center sample elevation
      featureBearing: peak.bearing,
    })

    // Report progress every 5 peaks (avoid flooding main thread)
    if ((pi + 1) % 5 === 0 || pi === peaks.length - 1) {
      self.postMessage({ type: 'refine-progress', phase: 'march', total: peaks.length, done: pi + 1 })
    }
  }

  // Transfer refined arc buffers (zero-copy)
  const transferables: Transferable[] = []
  for (const arc of refinedArcs) {
    transferables.push(
      arc.elevations.buffer as ArrayBuffer,
      arc.distances.buffer as ArrayBuffer,
      arc.ridgeLats.buffer as ArrayBuffer,
      arc.ridgeLngs.buffer as ArrayBuffer,
    )
  }
  self.postMessage({ type: 'refined-arcs', refinedArcs, timestamp: Date.now() }, transferables)
}

// ─── Message Dispatch ────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const data = e.data

  // Dispatch by message type
  if (data && data.type === 'refine-peaks') {
    // Second pass: peak-driven refinement using higher-zoom tiles
    await handleRefinePeaks(data.peaks as PeakRefineItem[])
    return
  }

  // Default: standard skyline computation (no type field)
  await computeSkyline(data as SkylineRequest)
}

async function computeSkyline(req: SkylineRequest): Promise<void> {
  const {
    viewerLat, viewerLng, viewerHeightM,
    resolution, maxRange,
  } = req

  const cosViewerLat = Math.cos(viewerLat * DEG_TO_RAD)
  const numAzimuths  = Math.round(360 * resolution)

  // ── Phase 1: Prefetch tiles ───────────────────────────────────────────────

  self.postMessage({ type: 'progress', phase: 'tiles', progress: 0 })

  const zoomBands: Array<{ zoom: number; radiusM: number }> = [
    { zoom: 15, radiusM: 1_000 },
    { zoom: 14, radiusM: 4_500 },
    { zoom: 13, radiusM: 10_500 },
    { zoom: 11, radiusM: 31_000 },
    { zoom: 10, radiusM: 81_000 },
    { zoom:  9, radiusM: 152_000 },
    { zoom:  8, radiusM: maxRange },
  ]

  for (const { zoom, radiusM } of zoomBands) {
    const dLat = (radiusM / 111_132) * 1.1
    const dLng = (radiusM / (111_320 * cosViewerLat)) * 1.1
    const sw   = latLngToTileXY(viewerLat - dLat, viewerLng - dLng, zoom)
    const ne   = latLngToTileXY(viewerLat + dLat, viewerLng + dLng, zoom)
    const minX = Math.min(sw.x, ne.x), maxX = Math.max(sw.x, ne.x)
    const minY = Math.min(sw.y, ne.y), maxY = Math.max(sw.y, ne.y)
    const batch: Promise<Float32Array | null>[] = []
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        batch.push(fetchWorkerTile(zoom, x, y))
      }
    }
    await Promise.all(batch)
  }

  self.postMessage({ type: 'progress', phase: 'tiles', progress: 1, tilesLoaded: tileCacheW.size })

  // ── Ground elevation from Z15 tiles (~10m resolution) ────────────────────
  // Tiles are already prefetched above, so sampleBest will hit the cache.
  const tileGround = sampleBest(viewerLat, viewerLng, 15)
  const correctedViewerElev = tileGround + viewerHeightM

  // ── Phase 2: Build log-step distance arrays ─────────────────────────────────

  // Full-range log steps for the standard pass
  const logDists: number[] = []
  let d = 500
  while (d <= maxRange) {
    logDists.push(d)
    d *= 1.015
  }
  logDists.reverse()  // far → near so nearer terrain wins

  // Short-range log steps for the high-res near pass (extends to 31km for mid-near band)
  const HIRES_MAX_DIST = 31_000
  const hiresLogDists: number[] = []
  let d2 = 200  // Start closer for near detail
  while (d2 <= HIRES_MAX_DIST) {
    hiresLogDists.push(d2)
    d2 *= 1.01  // Finer distance steps for near bands
  }
  hiresLogDists.reverse()

  // Ultra-near log steps: 20m → 200m at 1.005× step (very fine for cliff faces)
  // Uses 360 azimuths (1° per step) — sufficient for close terrain
  const ULTRA_NEAR_MAX_DIST = 200
  const ultraNearLogDists: number[] = []
  let d3 = 20
  while (d3 <= ULTRA_NEAR_MAX_DIST) {
    ultraNearLogDists.push(d3)
    d3 *= 1.005
  }
  ultraNearLogDists.reverse()
  const ULTRA_NEAR_AZIMUTHS = 360  // 1° per step for 20–200m range

  // Determine which bands are high-res vs standard
  const HIRES_RESOLUTION = 8  // 0.125° per step
  const hiresNumAzimuths = Math.round(360 * HIRES_RESOLUTION)
  const standardBandIndices: number[] = []
  const hiresBandIndices: number[] = []
  for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
    if (DEPTH_BANDS[bi].resolution && DEPTH_BANDS[bi].resolution! > resolution) {
      hiresBandIndices.push(bi)
    } else {
      standardBandIndices.push(bi)
    }
  }

  // ── Phase 3: Compute 360° skyline — standard resolution pass ──────────────

  const angles    = new Float32Array(numAzimuths)
  const distances = new Float32Array(numAzimuths)
  const shading   = new Float32Array(numAzimuths)

  // Allocate per-band arrays with per-band resolution
  const bands: SkylineBand[] = DEPTH_BANDS.map((cfg) => {
    const bandRes = cfg.resolution || resolution
    const bandAz  = Math.round(360 * bandRes)
    return {
      elevations:      new Float32Array(bandAz).fill(-Infinity),
      distances:       new Float32Array(bandAz),
      ridgeLats:       new Float32Array(bandAz),
      ridgeLngs:       new Float32Array(bandAz),
      crossingData:    new Float32Array(0),  // Will be packed after march
      crossingOffsets: new Uint32Array(bandAz + 1),
      resolution:      bandRes,
      numAzimuths:     bandAz,
    }
  })

  // Temp storage for crossings: per-band, per-azimuth
  // bandCrossingsTemp[bi][ai] = [elev, dist, lat, lng, elev, dist, lat, lng, ...]
  const bandCrossingsTemp: number[][][] = DEPTH_BANDS.map((cfg) => {
    const bandAz = Math.round(360 * (cfg.resolution || resolution))
    return Array.from({ length: bandAz }, () => [])
  })

  // Pass 1: Standard resolution (720 azimuths) — populates overall skyline + standard bands
  for (let ai = 0; ai < numAzimuths; ai++) {
    const azDeg  = ai / resolution
    const azRad  = azDeg * DEG_TO_RAD
    const sinA   = Math.sin(azRad)
    const cosA   = Math.cos(azRad)

    let maxAngle  = -Math.PI / 2
    let ridgeDist = maxRange / 2
    let ridgeLat  = viewerLat
    let ridgeLng  = viewerLng

    // Per-standard-band tracking
    const bandMaxAngles: number[] = []
    const bandRidgeDist: number[] = []
    const bandRidgeLat:  number[] = []
    const bandRidgeLng:  number[] = []
    const bandRidgeElev: number[] = []
    for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
      bandMaxAngles[bi] = -Math.PI / 2
      bandRidgeDist[bi] = 0
      bandRidgeLat[bi]  = viewerLat
      bandRidgeLng[bi]  = viewerLng
      bandRidgeElev[bi] = -Infinity
    }

    // Per-band previous-step tracking for crossing detection
    const bandPrevElev: number[] = new Array(DEPTH_BANDS.length).fill(-Infinity)
    const bandPrevDist: number[] = new Array(DEPTH_BANDS.length).fill(0)
    const bandPrevLat:  number[] = new Array(DEPTH_BANDS.length).fill(viewerLat)
    const bandPrevLng:  number[] = new Array(DEPTH_BANDS.length).fill(viewerLng)

    for (const dist of logDists) {
      const sLat = viewerLat + (cosA * dist) / 111_132
      const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)

      const zoom    = distToZoom(dist)
      const rawElev = sampleBest(sLat, sLng, zoom)

      const curvDrop  = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const effElev   = rawElev - curvDrop
      const elevAngle = Math.atan2(effElev - correctedViewerElev, dist)

      if (elevAngle > Math.PI / 3) continue

      // Overall maximum
      if (elevAngle > maxAngle) {
        maxAngle  = elevAngle
        ridgeDist = dist
        ridgeLat  = sLat
        ridgeLng  = sLng
      }

      // Per-band: ridgeline tracking + crossing detection (standard-res bands only)
      for (const bi of standardBandIndices) {
        const band = DEPTH_BANDS[bi]
        if (dist < band.minDist || dist > band.maxDist) continue

        // Ridgeline: track maximum elevation angle
        if (elevAngle > bandMaxAngles[bi]) {
          bandMaxAngles[bi] = elevAngle
          bandRidgeDist[bi] = dist
          bandRidgeLat[bi]  = sLat
          bandRidgeLng[bi]  = sLng
          bandRidgeElev[bi] = rawElev
        }

        // Crossing detection — uses raw (uncorrected) elevation for contour levels
        const interval = CONTOUR_INTERVALS_M[bi] || 152.4
        if (bandPrevElev[bi] !== -Infinity) {
          detectCrossings(
            bandPrevElev[bi], bandPrevDist[bi], bandPrevLat[bi], bandPrevLng[bi],
            rawElev, dist, sLat, sLng,
            interval,
            bandCrossingsTemp[bi][ai],
          )
        }
        bandPrevElev[bi] = rawElev
        bandPrevDist[bi] = dist
        bandPrevLat[bi]  = sLat
        bandPrevLng[bi]  = sLng
      }
    }

    // Overall ridgeline shade
    const ridgeZoom = distToZoom(ridgeDist)
    const shade = hillShade(ridgeLat, ridgeLng, ridgeZoom)

    angles[ai]    = maxAngle
    distances[ai] = ridgeDist
    shading[ai]   = shade

    // Populate standard-res band arrays (ridgeline only — crossings packed later)
    for (const bi of standardBandIndices) {
      bands[bi].elevations[ai] = bandRidgeElev[bi]
      bands[bi].distances[ai]  = bandRidgeDist[bi]
      bands[bi].ridgeLats[ai]  = bandRidgeLat[bi]
      bands[bi].ridgeLngs[ai]  = bandRidgeLng[bi]
    }

    if (ai % 45 === 0) {
      self.postMessage({ type: 'progress', phase: 'skyline', progress: ai / numAzimuths * 0.7 })
    }
  }

  // ── Phase 4: High-res pass (2880 azimuths, 0–31km) for near bands ────────

  if (hiresBandIndices.length > 0) {
    for (let ai = 0; ai < hiresNumAzimuths; ai++) {
      const azDeg = ai / HIRES_RESOLUTION
      const azRad = azDeg * DEG_TO_RAD
      const sinA  = Math.sin(azRad)
      const cosA  = Math.cos(azRad)

      // Per high-res band tracking
      const bandMaxAngles: number[] = []
      const bandRidgeDist: number[] = []
      const bandRidgeLat:  number[] = []
      const bandRidgeLng:  number[] = []
      const bandRidgeElev: number[] = []
      for (const bi of hiresBandIndices) {
        bandMaxAngles[bi] = -Math.PI / 2
        bandRidgeDist[bi] = 0
        bandRidgeLat[bi]  = viewerLat
        bandRidgeLng[bi]  = viewerLng
        bandRidgeElev[bi] = -Infinity
      }

      // Per-band previous-step tracking for crossing detection
      const bandPrevElev: number[] = new Array(DEPTH_BANDS.length).fill(-Infinity)
      const bandPrevDist: number[] = new Array(DEPTH_BANDS.length).fill(0)
      const bandPrevLat:  number[] = new Array(DEPTH_BANDS.length).fill(viewerLat)
      const bandPrevLng:  number[] = new Array(DEPTH_BANDS.length).fill(viewerLng)

      for (const dist of hiresLogDists) {
        const sLat = viewerLat + (cosA * dist) / 111_132
        const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)

        const zoom    = distToZoom(dist)
        const rawElev = sampleBest(sLat, sLng, zoom)

        const curvDrop  = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
        const effElev   = rawElev - curvDrop
        const elevAngle = Math.atan2(effElev - correctedViewerElev, dist)

        if (elevAngle > Math.PI / 3) continue

        for (const bi of hiresBandIndices) {
          const band = DEPTH_BANDS[bi]
          if (dist < band.minDist || dist > band.maxDist) continue

          // Ridgeline: track maximum elevation angle
          if (elevAngle > bandMaxAngles[bi]) {
            bandMaxAngles[bi] = elevAngle
            bandRidgeDist[bi] = dist
            bandRidgeLat[bi]  = sLat
            bandRidgeLng[bi]  = sLng
            bandRidgeElev[bi] = rawElev
          }

          // Crossing detection
          const interval = CONTOUR_INTERVALS_M[bi] || 60.96
          if (bandPrevElev[bi] !== -Infinity) {
            detectCrossings(
              bandPrevElev[bi], bandPrevDist[bi], bandPrevLat[bi], bandPrevLng[bi],
              rawElev, dist, sLat, sLng,
              interval,
              bandCrossingsTemp[bi][ai],
            )
          }
          bandPrevElev[bi] = rawElev
          bandPrevDist[bi] = dist
          bandPrevLat[bi]  = sLat
          bandPrevLng[bi]  = sLng
        }
      }

      // Populate high-res band arrays (ridgeline only)
      for (const bi of hiresBandIndices) {
        bands[bi].elevations[ai] = bandRidgeElev[bi]
        bands[bi].distances[ai]  = bandRidgeDist[bi]
        bands[bi].ridgeLats[ai]  = bandRidgeLat[bi]
        bands[bi].ridgeLngs[ai]  = bandRidgeLng[bi]
      }

      if (ai % 90 === 0) {
        self.postMessage({ type: 'progress', phase: 'skyline', progress: 0.7 + (ai / hiresNumAzimuths) * 0.2 })
      }
    }
  }

  // ── Phase 4b: Ultra-near pass (360 azimuths, 20–200m) ─────────────────────
  // Fills the ultra-near band (index 0) with close-range terrain that the
  // hi-res pass (starting at 200m) would miss.  Uses coarser 1° azimuth
  // resolution since features at 20–200m subtend large angular spans.
  // Results are merged into every 8th slot of the 2880-element band arrays.

  if (ultraNearLogDists.length > 0 && DEPTH_BANDS[0].maxDist > 0) {
    const ultraBandIdx = 0  // ultra-near is always band 0
    const band = bands[ultraBandIdx]

    for (let uai = 0; uai < ULTRA_NEAR_AZIMUTHS; uai++) {
      const azDeg = uai  // 1° steps
      const azRad = azDeg * DEG_TO_RAD
      const sinA  = Math.sin(azRad)
      const cosA  = Math.cos(azRad)

      // Map 360-azimuth index to 2880-element band array index (every 8th slot)
      const bandAi = uai * HIRES_RESOLUTION  // 8 hi-res steps per degree

      let bestAngle = band.elevations[bandAi] > -Infinity
        ? Math.atan2(band.elevations[bandAi] - (band.distances[bandAi] * band.distances[bandAi]) / (2 * EARTH_R) * (1 - REFRACTION_K) - correctedViewerElev, band.distances[bandAi])
        : -Math.PI / 2

      let bestDist = band.distances[bandAi]
      let bestLat  = band.ridgeLats[bandAi]
      let bestLng  = band.ridgeLngs[bandAi]
      let bestElev = band.elevations[bandAi]

      // Previous-step tracking for crossing detection
      let prevElev = -Infinity as number
      let prevDist = 0
      let prevLat  = viewerLat
      let prevLng  = viewerLng

      for (const dist of ultraNearLogDists) {
        const sLat = viewerLat + (cosA * dist) / 111_132
        const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)

        const zoom    = distToZoom(dist)
        const rawElev = sampleBest(sLat, sLng, zoom)

        const curvDrop  = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
        const effElev   = rawElev - curvDrop
        const elevAngle = Math.atan2(effElev - correctedViewerElev, dist)

        if (elevAngle > Math.PI / 3) continue

        if (elevAngle > bestAngle) {
          bestAngle = elevAngle
          bestDist  = dist
          bestLat   = sLat
          bestLng   = sLng
          bestElev  = rawElev
        }

        // Crossing detection for ultra-near band
        const interval = CONTOUR_INTERVALS_M[ultraBandIdx] || 15.24
        if (prevElev !== -Infinity) {
          detectCrossings(
            prevElev, prevDist, prevLat, prevLng,
            rawElev, dist, sLat, sLng,
            interval,
            bandCrossingsTemp[ultraBandIdx][bandAi],
          )
        }
        prevElev = rawElev
        prevDist = dist
        prevLat  = sLat
        prevLng  = sLng
      }

      // Only update if ultra-near pass found a higher ridgeline than hi-res pass
      if (bestElev > -Infinity && bestAngle > (band.elevations[bandAi] > -Infinity
        ? Math.atan2(band.elevations[bandAi] - (band.distances[bandAi] * band.distances[bandAi]) / (2 * EARTH_R) * (1 - REFRACTION_K) - correctedViewerElev, band.distances[bandAi])
        : -Math.PI / 2)) {
        band.elevations[bandAi] = bestElev
        band.distances[bandAi]  = bestDist
        band.ridgeLats[bandAi]  = bestLat
        band.ridgeLngs[bandAi]  = bestLng
      }
    }

    self.postMessage({ type: 'progress', phase: 'skyline', progress: 0.90 })
  }

  // ── Phase 4c: Silhouette candidate collection (2880 azimuths, 20m–400km) ──
  //
  // Dedicated pass that collects terrain samples along each azimuth ray and
  // detects local elevation maxima (hilltops/ridgetops).  These are stored in
  // per-bin min-heaps keyed on effElev (AGL-independent).
  //
  // The march reuses tiles already in cache — no new fetches.  Marches
  // NEAR → FAR so we can track valley floors on the viewer side of each peak.

  // Build combined distance steps: ultra-near (20-200m @ 1.005×) + near (200m-31km @ 1.01×) + far (500m-400km @ 1.015×)
  const silDists: number[] = []
  {
    let sd = 20
    while (sd <= 200) { silDists.push(sd); sd *= 1.005 }
    sd = 200
    while (sd <= 31_000) { silDists.push(sd); sd *= 1.01 }
    sd = 31_000
    while (sd <= maxRange) { silDists.push(sd); sd *= 1.015 }
  }
  // Sort near → far (ascending distance)
  silDists.sort((a, b) => a - b)
  // Deduplicate (distances from overlapping ranges)
  const silDistsDeduped: number[] = [silDists[0]]
  for (let i = 1; i < silDists.length; i++) {
    if (silDists[i] - silDistsDeduped[silDistsDeduped.length - 1] > 1) {
      silDistsDeduped.push(silDists[i])
    }
  }

  // Per-azimuth silhouette candidate heaps
  const silCandidatesTemp: SilCandidate[][] = new Array(SILHOUETTE_NUM_AZIMUTHS)

  for (let ai = 0; ai < SILHOUETTE_NUM_AZIMUTHS; ai++) {
    const azDeg = ai / SILHOUETTE_RESOLUTION
    const azRad = azDeg * DEG_TO_RAD
    const sinA  = Math.sin(azRad)
    const cosA  = Math.cos(azRad)

    // Per-bin heaps
    const binHeaps: CandidateHeap[] = SILHOUETTE_BINS.map(b => new CandidateHeap(b[2]))

    // State for local maxima detection (near → far)
    let prevEffElev = -Infinity
    let wasRising = false
    // Track previous step data for recording the peak (which is one step behind)
    let prevRawElev = 0, prevDist = 0, prevLat = viewerLat, prevLng = viewerLng
    // Valley floor tracking (lowest point between viewer/previous peak and current position)
    let valleyEffElev = Infinity, valleyDist = 0

    for (let si = 0; si < silDistsDeduped.length; si++) {
      const dist = silDistsDeduped[si]
      const sLat = viewerLat + (cosA * dist) / 111_132
      const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)

      const zoom    = distToZoom(dist)
      const rawElev = sampleBest(sLat, sLng, zoom)
      const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const effElev  = rawElev - curvDrop

      // Detect local maxima: effElev was rising, now falling
      if (wasRising && effElev < prevEffElev) {
        // Previous step was a local maximum — insert into bin heap
        const binIdx = distToBin(prevDist)
        if (binIdx >= 0) {
          const isOcean = prevRawElev < 2.0  // sampleBest clamps ocean to 0; coast interpolation can yield 0-2m
          binHeaps[binIdx].insert({
            effElev:     prevEffElev,
            rawElev:     prevRawElev,
            dist:        prevDist,
            lat:         prevLat,
            lng:         prevLng,
            baseEffElev: valleyEffElev === Infinity ? prevEffElev : valleyEffElev,
            baseDist:    valleyEffElev === Infinity ? prevDist : valleyDist,
            flags:       isOcean ? 1 : 0,
          })
        }
        // Reset valley tracking after recording a peak
        valleyEffElev = effElev
        valleyDist    = dist
      }

      // Track rising/falling
      if (effElev > prevEffElev) {
        wasRising = true
      } else if (effElev < prevEffElev) {
        wasRising = false
      }

      // Track valley floor (lowest point since last peak)
      if (effElev < valleyEffElev) {
        valleyEffElev = effElev
        valleyDist    = dist
      }

      // Save current as previous for next iteration
      prevEffElev = effElev
      prevRawElev = rawElev
      prevDist    = dist
      prevLat     = sLat
      prevLng     = sLng
    }

    // Handle edge case: if the last sample was still rising (peak at max range)
    if (wasRising && prevEffElev > -Infinity) {
      const binIdx = distToBin(prevDist)
      if (binIdx >= 0) {
        const isOcean = prevRawElev < 2.0
        binHeaps[binIdx].insert({
          effElev: prevEffElev, rawElev: prevRawElev, dist: prevDist,
          lat: prevLat, lng: prevLng,
          baseEffElev: valleyEffElev === Infinity ? prevEffElev : valleyEffElev,
          baseDist: valleyEffElev === Infinity ? prevDist : valleyDist,
          flags: isOcean ? 1 : 0,
        })
      }
    }

    // Flatten all bins into a single sorted-by-distance candidate list
    const allCandidates: SilCandidate[] = []
    for (const heap of binHeaps) {
      for (const c of heap.sortedByDist()) {
        allCandidates.push(c)
      }
    }
    // Sort near → far for the front-to-back sweep at render time
    allCandidates.sort((a, b) => a.dist - b.dist)
    silCandidatesTemp[ai] = allCandidates

    if (ai % 360 === 0) {
      self.postMessage({ type: 'progress', phase: 'silhouette', progress: ai / SILHOUETTE_NUM_AZIMUTHS })
    }
  }

  self.postMessage({ type: 'progress', phase: 'skyline', progress: 0.95 })

  // ── Phase 5: Pack crossing data into flat arrays ──────────────────────────

  for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
    const azCrossings = bandCrossingsTemp[bi]
    const bandAz = bands[bi].numAzimuths
    const offsets = new Uint32Array(bandAz + 1)

    // Count total crossings (each crossing = 4 floats)
    let totalFloats = 0
    for (let ai = 0; ai < bandAz; ai++) {
      offsets[ai] = totalFloats
      totalFloats += azCrossings[ai].length  // Already in groups of 4
    }
    offsets[bandAz] = totalFloats

    // Pack into flat Float32Array
    const data = new Float32Array(totalFloats)
    let idx = 0
    for (let ai = 0; ai < bandAz; ai++) {
      const c = azCrossings[ai]
      for (let j = 0; j < c.length; j++) {
        data[idx++] = c[j]
      }
    }

    bands[bi].crossingData = data
    bands[bi].crossingOffsets = offsets
  }

  // ── Phase 5b: Pack silhouette candidates into flat transferable arrays ────

  const silOffsets = new Uint32Array(SILHOUETTE_NUM_AZIMUTHS + 1)
  let silTotalFloats = 0
  for (let ai = 0; ai < SILHOUETTE_NUM_AZIMUTHS; ai++) {
    silOffsets[ai] = silTotalFloats
    silTotalFloats += silCandidatesTemp[ai].length * SILHOUETTE_FLOATS
  }
  silOffsets[SILHOUETTE_NUM_AZIMUTHS] = silTotalFloats

  const silData = new Float32Array(silTotalFloats)
  let silIdx = 0
  let silTotalCandidates = 0
  for (let ai = 0; ai < SILHOUETTE_NUM_AZIMUTHS; ai++) {
    for (const c of silCandidatesTemp[ai]) {
      silData[silIdx++] = c.effElev
      silData[silIdx++] = c.rawElev
      silData[silIdx++] = c.dist
      silData[silIdx++] = c.lat
      silData[silIdx++] = c.lng
      silData[silIdx++] = c.baseEffElev
      silData[silIdx++] = c.baseDist
      silData[silIdx++] = c.flags
      silTotalCandidates++
    }
  }

  console.log(`[SILHOUETTE] Packed ${silTotalCandidates} candidates across ${SILHOUETTE_NUM_AZIMUTHS} azimuths (${(silTotalFloats * 4 / 1024).toFixed(0)} KB)`)

  // ── Phase 5c: Near-field occlusion profile (2880 azimuths, 20m–2km) ─────
  //
  // Stores the full terrain elevation at ~50 evenly-log-spaced distance
  // samples per azimuth.  This gives the main thread the actual terrain
  // SURFACE shape (not just ridgeline maxima) so it can render an opaque
  // fill that properly blocks all far terrain behind near hills.
  //
  // Reuses tiles already in cache from Phases 3–4.  No new fetches.

  const NEAR_PROFILE_SAMPLES = 50
  const NEAR_PROFILE_MAX_DIST = 2000  // metres
  const NEAR_PROFILE_FPS = 2  // floats per sample: rawElev, dist

  // Build log-spaced distance steps: 20m → 2000m, exactly NEAR_PROFILE_SAMPLES steps
  const nearProfileDists: number[] = []
  {
    const logStart = Math.log(20)
    const logEnd   = Math.log(NEAR_PROFILE_MAX_DIST)
    const logStep  = (logEnd - logStart) / (NEAR_PROFILE_SAMPLES - 1)
    for (let i = 0; i < NEAR_PROFILE_SAMPLES; i++) {
      nearProfileDists.push(Math.exp(logStart + i * logStep))
    }
  }

  // Fixed-stride layout: each azimuth gets NEAR_PROFILE_SAMPLES × 2 floats.
  // Unused slots have rawElev = -Infinity (sentinel).
  // sampleCounts tracks actual valid samples per azimuth.
  const npTotalFloats = SILHOUETTE_NUM_AZIMUTHS * NEAR_PROFILE_SAMPLES * NEAR_PROFILE_FPS
  const npData = new Float32Array(npTotalFloats)
  npData.fill(-Infinity)  // sentinel for empty slots
  const npCounts = new Uint16Array(SILHOUETTE_NUM_AZIMUTHS)

  for (let ai = 0; ai < SILHOUETTE_NUM_AZIMUTHS; ai++) {
    const azDeg = ai / SILHOUETTE_RESOLUTION
    const azRad = azDeg * DEG_TO_RAD
    const sinA  = Math.sin(azRad)
    const cosA  = Math.cos(azRad)

    const base = ai * NEAR_PROFILE_SAMPLES * NEAR_PROFILE_FPS
    let count = 0
    for (let si = 0; si < nearProfileDists.length; si++) {
      const dist = nearProfileDists[si]
      const sLat = viewerLat + (cosA * dist) / 111_132
      const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)

      const zoom    = distToZoom(dist)
      const rawElev = sampleBest(sLat, sLng, zoom)

      // Skip ocean/invalid samples
      if (rawElev < 2.0) continue

      const off = base + count * NEAR_PROFILE_FPS
      npData[off]     = rawElev
      npData[off + 1] = dist
      count++
    }
    npCounts[ai] = count
  }

  const npValidSamples = npCounts.reduce((s, c) => s + c, 0)
  console.log(`[NEAR-PROFILE] ${npValidSamples} valid samples across ${SILHOUETTE_NUM_AZIMUTHS} azimuths (${(npTotalFloats * 4 / 1024).toFixed(0)} KB)`)

  // Phase 6 removed — refined arcs now computed on-demand via 'refine-peaks' message.
  // See handleRefinePeaks() below.

  self.postMessage({ type: 'progress', phase: 'skyline', progress: 1.0 })

  // Store viewer state for refinement reuse — the 'refine-peaks' handler
  // reuses these so it doesn't need the mesh/bounds resent.
  lastViewerLat          = viewerLat
  lastViewerLng          = viewerLng
  lastCorrectedViewerElev = correctedViewerElev
  lastCosViewerLat       = cosViewerLat
  lastSkylineComputed    = true

  const silhouette: SilhouetteDataW = {
    candidateData:    silData,
    candidateOffsets: silOffsets,
    resolution:       SILHOUETTE_RESOLUTION,
    numAzimuths:      SILHOUETTE_NUM_AZIMUTHS,
  }

  const nearProfile: NearFieldProfileW = {
    profileData:    npData,
    sampleCounts:   npCounts,
    resolution:     SILHOUETTE_RESOLUTION,
    numAzimuths:    SILHOUETTE_NUM_AZIMUTHS,
    floatsPerSample: NEAR_PROFILE_FPS as 2,
  }

  const skyline: SkylineData = {
    angles,
    distances,
    shading,
    bands,
    refinedArcs: [],  // Arcs now come via separate 'refine-peaks' → 'refined-arcs' flow
    silhouette,
    nearProfile,
    resolution,
    numAzimuths,
    computedAt: {
      lat:       viewerLat,
      lng:       viewerLng,
      elev:      correctedViewerElev,
      groundElev: tileGround,
      timestamp: Date.now(),
    },
  }

  // Transfer ArrayBuffers (zero-copy) — include band + silhouette + near-profile buffers
  const transferables: Transferable[] = [
    angles.buffer as ArrayBuffer,
    distances.buffer as ArrayBuffer,
    shading.buffer as ArrayBuffer,
    silData.buffer as ArrayBuffer,
    silOffsets.buffer as ArrayBuffer,
    npData.buffer as ArrayBuffer,
    npCounts.buffer as ArrayBuffer,
  ]
  for (const band of bands) {
    transferables.push(
      band.elevations.buffer as ArrayBuffer,
      band.distances.buffer as ArrayBuffer,
      band.ridgeLats.buffer as ArrayBuffer,
      band.ridgeLngs.buffer as ArrayBuffer,
      band.crossingData.buffer as ArrayBuffer,
      band.crossingOffsets.buffer as ArrayBuffer,
    )
  }
  self.postMessage({ type: 'complete', skyline }, transferables)
}
