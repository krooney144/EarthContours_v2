/**
 * EarthContours — Depth Renderer for SCAN Screen
 *
 * Replaces the flat band-fill system with a contour-driven depth and occlusion
 * rendering system that produces:
 *   - Layered terrain with atmospheric haze (distance-based color/opacity fade)
 *   - Correct valley occlusion (nearer terrain hides farther terrain)
 *   - Soft ridgeline fades at the far skyline boundary
 *   - Water feature rendering (ocean, lakes colored distinctly)
 *   - Distance-based landscape coloring beneath contour lines
 *
 * Rendering pipeline (called per frame):
 *   1. buildSkylineBuffer()   — pre-compute per-column occlusion + color data
 *   2. renderDepthTerrain()   — draw layered terrain with haze + occlusion
 *   3. renderFarSkylineGlow() — soft glow at the farthest visible ridgeline
 *
 * All functions are stateless — they take data in and produce output.
 * No React, no stores, no side effects.
 */

import type { SkylineData, BandDetectedPeaks } from '../../core/types'
import { DEPTH_BANDS } from '../../core/types'
import type { CameraParams, ProjectedBands, PrebuiltContourStrand } from './scanRendererCore'
import {
  project,
  getHorizonY,
  bandAngleAt,
  bandElevAt,
  bandDistAt,
  elevToRidgeColor,
  EARTH_R,
  REFRACTION_K,
  OCEAN_ELEV_M,
  DEG_TO_RAD,
  MAX_DIST,
} from './scanRendererCore'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Atmospheric haze parameters — distance controls how much terrain fades toward sky color */
const HAZE_COLOR: [number, number, number] = [12, 30, 48]  // Dark blue-grey haze (matches sky near horizon)
const HAZE_START_DIST = 20_000    // Haze begins at 20km
const HAZE_FULL_DIST  = 350_000   // Full haze at 350km
const HAZE_MAX_ALPHA  = 0.75      // Maximum haze opacity (never fully obscures)

/** Terrain base colors by distance — near terrain is darker, far terrain lighter */
const TERRAIN_NEAR_COLOR: [number, number, number] = [2, 10, 18]     // Near-black deep ocean
const TERRAIN_FAR_COLOR:  [number, number, number] = [14, 50, 75]    // Muted deep blue
const TERRAIN_MID_COLOR:  [number, number, number] = [8, 30, 48]     // Mid-range blue-grey

/** Water feature colors */
const WATER_COLOR: [number, number, number]  = [4, 18, 35]    // Dark blue for lakes/rivers
const OCEAN_COLOR: [number, number, number]  = [2, 8, 20]     // Near-black for ocean

/** Far skyline glow parameters */
const FAR_GLOW_WIDTH     = 3    // Pixels of glow above farthest ridgeline
const FAR_GLOW_INTENSITY = 0.35 // Peak opacity of far ridgeline glow

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-column rendering data for one screen column */
export interface ColumnData {
  /** Bearing in degrees for this column */
  bearingDeg: number
  /** Per-band: screen Y of ridgeline (top of filled region), -1 if no terrain */
  bandScreenY: number[]
  /** Per-band: elevation angle (radians) */
  bandAngles: number[]
  /** Per-band: distance to ridgeline (metres) */
  bandDists: number[]
  /** Per-band: raw elevation (metres) */
  bandElevs: number[]
  /** Per-band: is this column water (ocean/lake)? */
  bandIsWater: boolean[]
  /** Per-band: true if this band is hidden behind closer terrain at this column */
  bandOccluded: boolean[]
  /** Per-ray occlusion envelope: max elevation angle from all bands 0..bi-1 at this column.
   *  occlusionEnvelope[bi] = max angle seen from bands nearer than bi.
   *  Used by contour renderer to skip points hidden behind closer terrain. */
  occlusionEnvelope: number[]
  /** Overall max screen Y across all bands (the visible silhouette) */
  silhouetteY: number
  /** Distance to the farthest visible ridgeline at this column */
  farDist: number
  /** Band index of the farthest visible terrain at this column */
  farBandIdx: number
}

/** Pre-computed buffer of all columns for one frame */
export interface SkylineBuffer {
  columns: ColumnData[]
  globalElevMin: number
  globalElevMax: number
  horizonY: number
}

// ─── Skyline Buffer Construction ─────────────────────────────────────────────

/**
 * Pre-compute per-column rendering data for the entire canvas width.
 * This builds the "skyline buffer" that the depth renderer draws from.
 * Run once per frame (or when camera/data changes).
 */
export function buildSkylineBuffer(
  skyline: SkylineData,
  cam: CameraParams,
  projected: ProjectedBands | null,
): SkylineBuffer {
  const { W, H } = cam
  const numBands = skyline.bands.length
  const horizonY = getHorizonY(cam)
  const SENTINEL = -Math.PI / 2 + 0.001

  // Global elevation range for color normalization
  let globalElevMin = Infinity
  let globalElevMax = -Infinity
  for (let bi = 0; bi < numBands; bi++) {
    const elev = skyline.bands[bi].elevations
    for (let i = 0; i < elev.length; i++) {
      if (elev[i] === -Infinity || elev[i] < OCEAN_ELEV_M) continue
      if (elev[i] < globalElevMin) globalElevMin = elev[i]
      if (elev[i] > globalElevMax) globalElevMax = elev[i]
    }
  }

  const columns: ColumnData[] = new Array(W)

  for (let col = 0; col < W; col++) {
    const bearingDeg = cam.heading_deg + (col / W - 0.5) * cam.hfov

    const bandScreenY: number[] = new Array(numBands)
    const bandAngles: number[] = new Array(numBands)
    const bandDists: number[] = new Array(numBands)
    const bandElevs: number[] = new Array(numBands)
    const bandIsWater: boolean[] = new Array(numBands)
    const bandOccluded: boolean[] = new Array(numBands)
    const occlusionEnvelope: number[] = new Array(numBands)

    let silhouetteY = H
    let farDist = 0
    let farBandIdx = numBands - 1

    // First pass: compute raw band angles
    for (let bi = 0; bi < numBands; bi++) {
      bandAngles[bi] = bandAngleAt(skyline, bi, bearingDeg, projected)
      bandElevs[bi] = bandElevAt(skyline, bi, bearingDeg)
      bandDists[bi] = bandDistAt(skyline, bi, bearingDeg)
      bandIsWater[bi] = bandElevs[bi] !== -Infinity && bandElevs[bi] < OCEAN_ELEV_M
    }

    // Per-ray depth occlusion: sweep near → far, track running max angle.
    // A farther band whose ridgeline falls below the max angle from closer
    // bands is fully occluded — closer terrain blocks the view.
    let maxOccAngle = SENTINEL
    for (let bi = 0; bi < numBands; bi++) {
      occlusionEnvelope[bi] = maxOccAngle
      const angle = bandAngles[bi]

      if (angle <= SENTINEL) {
        bandOccluded[bi] = false  // no terrain — nothing to occlude
        bandScreenY[bi] = H
      } else if (angle <= maxOccAngle) {
        // This band's ridgeline is hidden behind closer terrain
        bandOccluded[bi] = true
        bandScreenY[bi] = H
      } else {
        // Visible — update the occlusion envelope
        bandOccluded[bi] = false
        maxOccAngle = angle
        const { y } = project(bearingDeg, angle, cam)
        bandScreenY[bi] = Math.round(Math.min(H, Math.max(0, y)))

        if (bandScreenY[bi] < silhouetteY) {
          silhouetteY = bandScreenY[bi]
        }
      }

      // Track the farthest visible (non-occluded) band
      if (!bandOccluded[bi] && angle > SENTINEL && bandDists[bi] > farDist) {
        farDist = bandDists[bi]
        farBandIdx = bi
      }
    }

    columns[col] = {
      bearingDeg,
      bandScreenY,
      bandAngles,
      bandDists,
      bandElevs,
      bandIsWater,
      bandOccluded,
      occlusionEnvelope,
      silhouetteY,
      farDist,
      farBandIdx,
    }
  }

  return { columns, globalElevMin, globalElevMax, horizonY }
}

// ─── Distance-Based Color Helpers ────────────────────────────────────────────

/** Interpolate terrain base color by distance from viewer */
function terrainColorForDist(dist: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, dist / MAX_DIST))
  // Three-stop gradient: near → mid → far
  if (t < 0.3) {
    const s = t / 0.3
    return [
      Math.round(TERRAIN_NEAR_COLOR[0] + (TERRAIN_MID_COLOR[0] - TERRAIN_NEAR_COLOR[0]) * s),
      Math.round(TERRAIN_NEAR_COLOR[1] + (TERRAIN_MID_COLOR[1] - TERRAIN_NEAR_COLOR[1]) * s),
      Math.round(TERRAIN_NEAR_COLOR[2] + (TERRAIN_MID_COLOR[2] - TERRAIN_NEAR_COLOR[2]) * s),
    ]
  }
  const s = (t - 0.3) / 0.7
  return [
    Math.round(TERRAIN_MID_COLOR[0] + (TERRAIN_FAR_COLOR[0] - TERRAIN_MID_COLOR[0]) * s),
    Math.round(TERRAIN_MID_COLOR[1] + (TERRAIN_FAR_COLOR[1] - TERRAIN_MID_COLOR[1]) * s),
    Math.round(TERRAIN_MID_COLOR[2] + (TERRAIN_FAR_COLOR[2] - TERRAIN_MID_COLOR[2]) * s),
  ]
}

/** Compute atmospheric haze factor (0 = clear, HAZE_MAX_ALPHA = fully hazed) */
function hazeFactor(dist: number): number {
  if (dist <= HAZE_START_DIST) return 0
  if (dist >= HAZE_FULL_DIST) return HAZE_MAX_ALPHA
  const t = (dist - HAZE_START_DIST) / (HAZE_FULL_DIST - HAZE_START_DIST)
  // Ease-in curve for natural haze
  return t * t * HAZE_MAX_ALPHA
}

/** Mix two RGB colors with alpha blend */
function mixColors(
  base: [number, number, number],
  overlay: [number, number, number],
  alpha: number,
): [number, number, number] {
  return [
    Math.round(base[0] + (overlay[0] - base[0]) * alpha),
    Math.round(base[1] + (overlay[1] - base[1]) * alpha),
    Math.round(base[2] + (overlay[2] - base[2]) * alpha),
  ]
}

// ─── Main Depth Terrain Renderer ─────────────────────────────────────────────

/**
 * Render layered terrain with atmospheric haze, valley occlusion, and
 * distance-based coloring. Replaces the old flat band-fill system.
 *
 * Algorithm:
 *   For each band (far → near, painter's order):
 *     1. Compute terrain base color from distance
 *     2. Apply atmospheric haze (blend toward sky color)
 *     3. Apply water coloring for ocean/lake areas
 *     4. Fill below ridgeline with the hazed color
 *     5. Draw ridgeline stroke with elevation-based color + haze
 *
 *   Valley occlusion: each nearer band's fill covers farther bands,
 *   naturally hiding terrain behind closer ridgelines (painter's algorithm).
 */
export function renderDepthTerrain(
  ctx: CanvasRenderingContext2D,
  buffer: SkylineBuffer,
  skyline: SkylineData,
  cam: CameraParams,
  projected: ProjectedBands | null,
  showBandLines: boolean = true,
  showFill: boolean = true,
): void {
  const { W, H } = cam
  const scale = cam.scale ?? 1
  const numBands = skyline.bands.length
  const { columns, globalElevMin, globalElevMax } = buffer
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1

  // Ridgeline stroke widths per band (near=thick, far=thin)
  const BAND_STROKE_WIDTHS: [number, number][] = [
    [5, 4.5],    // ultra-near
    [4.5, 3.5],  // near
    [3.5, 3],    // mid-near
    [3, 2.5],    // mid
    [2.5, 2],    // mid-far
    [2, 1],      // far
  ]

  // Ridgeline opacity per band
  const BAND_OPACITIES = [0.90, 0.80, 0.65, 0.50, 0.35, 0.25]

  // Segment sizes for color/width update frequency
  const SEGMENT_SIZES = [3, 4, 6, 12, 24, 48].map(s => Math.round(s * scale))

  for (let bi = numBands - 1; bi >= 0; bi--) {
    const bandCfg = DEPTH_BANDS[bi]
    const segSize = SEGMENT_SIZES[bi] ?? 24
    const bandOpacity = BAND_OPACITIES[bi] ?? 0.25

    // ── Fill below this band's ridgeline ────────────────────────────────────
    if (showFill) {
      // Use ImageData for per-column coloring (avoids hundreds of fillRect calls)
      // But for simplicity and performance, draw column-by-column with fillRect
      // batching adjacent columns with same color.

      let batchStartCol = -1
      let batchColor = ''
      let lastScreenY = H

      for (let col = 0; col < W; col++) {
        const cd = columns[col]
        const screenY = cd.bandScreenY[bi]

        if (screenY >= H) {
          // No terrain — flush batch
          if (batchStartCol >= 0) {
            ctx.fillStyle = batchColor
            ctx.fillRect(batchStartCol, lastScreenY, col - batchStartCol, H - lastScreenY)
            batchStartCol = -1
          }
          continue
        }

        // Compute fill color for this column
        const dist = cd.bandDists[bi]
        const isWater = cd.bandIsWater[bi]

        let baseColor: [number, number, number]
        if (isWater) {
          baseColor = cd.bandElevs[bi] < 2 ? OCEAN_COLOR : WATER_COLOR
        } else {
          baseColor = terrainColorForDist(dist)
        }

        // Apply atmospheric haze
        const haze = hazeFactor(dist)
        const finalColor = haze > 0 ? mixColors(baseColor, HAZE_COLOR, haze) : baseColor
        const colorStr = `rgb(${finalColor[0]},${finalColor[1]},${finalColor[2]})`

        // Batch: if color changed or first column, flush old batch
        if (batchStartCol < 0 || colorStr !== batchColor || Math.abs(screenY - lastScreenY) > 1) {
          if (batchStartCol >= 0) {
            ctx.fillStyle = batchColor
            ctx.fillRect(batchStartCol, lastScreenY, col - batchStartCol, H - lastScreenY)
          }
          batchStartCol = col
          batchColor = colorStr
          lastScreenY = screenY
        }
      }
      // Flush remaining batch
      if (batchStartCol >= 0) {
        ctx.fillStyle = batchColor
        ctx.fillRect(batchStartCol, lastScreenY, W - batchStartCol, H - lastScreenY)
      }
    }

    // ── Ridgeline stroke ───────────────────────────────────────────────────
    if (showBandLines) {
      ctx.lineCap = 'butt'
      ctx.lineJoin = 'round'

      const widths = BAND_STROKE_WIDTHS[bi] || [2, 1]
      const lwNear = widths[0]
      const lwFar = widths[1]
      const lwMin = bandCfg.minDist
      const lwMax = bandCfg.maxDist
      const lwRange = lwMax - lwMin

      let segStartCol = -1

      for (let col = 0; col < W; col++) {
        const cd = columns[col]
        const screenY = cd.bandScreenY[bi]

        if (screenY >= H) {
          if (segStartCol >= 0) ctx.stroke()
          segStartCol = -1
          continue
        }

        if (segStartCol < 0) {
          // Start new segment
          const elev = cd.bandElevs[bi]
          const dist = cd.bandDists[bi]
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange : 0.5
          const tDist = lwRange > 0 ? Math.max(0, Math.min(1, (dist - lwMin) / lwRange)) : 0
          const lw = (lwNear + tDist * (lwFar - lwNear)) * scale

          // Apply haze to ridgeline color
          const baseRidgeColor = elevToRidgeColor(tElev)
          const haze = hazeFactor(dist)
          const rgbMatch = baseRidgeColor.match(/\d+/g)

          if (rgbMatch) {
            const r = parseInt(rgbMatch[0]), g = parseInt(rgbMatch[1]), b = parseInt(rgbMatch[2])
            const hr = Math.round(r + (HAZE_COLOR[0] - r) * haze * 0.5)
            const hg = Math.round(g + (HAZE_COLOR[1] - g) * haze * 0.5)
            const hb = Math.round(b + (HAZE_COLOR[2] - b) * haze * 0.5)
            ctx.strokeStyle = `rgba(${hr},${hg},${hb},${bandOpacity})`
          } else {
            ctx.strokeStyle = `rgba(132,209,219,${bandOpacity})`
          }

          ctx.lineWidth = lw
          ctx.beginPath()
          ctx.moveTo(col, screenY)
          segStartCol = col
        } else if (col - segStartCol >= segSize) {
          // Flush segment and start new one with updated color/width
          ctx.lineTo(col, screenY)
          ctx.stroke()

          const elev = cd.bandElevs[bi]
          const dist = cd.bandDists[bi]
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange : 0.5
          const tDist = lwRange > 0 ? Math.max(0, Math.min(1, (dist - lwMin) / lwRange)) : 0
          const lw = (lwNear + tDist * (lwFar - lwNear)) * scale

          const baseRidgeColor = elevToRidgeColor(tElev)
          const haze = hazeFactor(dist)
          const rgbMatch = baseRidgeColor.match(/\d+/g)

          if (rgbMatch) {
            const r = parseInt(rgbMatch[0]), g = parseInt(rgbMatch[1]), b = parseInt(rgbMatch[2])
            const hr = Math.round(r + (HAZE_COLOR[0] - r) * haze * 0.5)
            const hg = Math.round(g + (HAZE_COLOR[1] - g) * haze * 0.5)
            const hb = Math.round(b + (HAZE_COLOR[2] - b) * haze * 0.5)
            ctx.strokeStyle = `rgba(${hr},${hg},${hb},${bandOpacity})`
          } else {
            ctx.strokeStyle = `rgba(132,209,219,${bandOpacity})`
          }

          ctx.lineWidth = lw
          ctx.beginPath()
          ctx.moveTo(col, screenY)
          segStartCol = col
        } else {
          ctx.lineTo(col, screenY)
        }
      }

      if (segStartCol >= 0) ctx.stroke()
    }
  }
}

// ─── Far Skyline Glow ────────────────────────────────────────────────────────

/**
 * Draw a soft glow at the farthest visible ridgeline to make mountains stand
 * out against the sky. The glow follows the silhouette of the outermost
 * visible terrain, creating a subtle atmospheric luminance effect.
 */
export function renderFarSkylineGlow(
  ctx: CanvasRenderingContext2D,
  buffer: SkylineBuffer,
  cam: CameraParams,
): void {
  const { W, H } = cam
  const { columns } = buffer

  // Draw a soft luminous edge along the farthest visible ridgeline
  ctx.save()

  // Pass 1: Wider, dimmer glow
  ctx.lineWidth = FAR_GLOW_WIDTH * 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = `rgba(132, 209, 219, ${(FAR_GLOW_INTENSITY * 0.3).toFixed(3)})`

  let inPath = false
  ctx.beginPath()
  for (let col = 0; col < W; col++) {
    const cd = columns[col]
    // Use the farthest band's screen Y as the glow line
    const farY = cd.bandScreenY[cd.farBandIdx]
    if (farY >= H || cd.farDist < 30_000) {
      if (inPath) { ctx.stroke(); ctx.beginPath(); inPath = false }
      continue
    }

    if (!inPath) {
      ctx.moveTo(col, farY)
      inPath = true
    } else {
      ctx.lineTo(col, farY)
    }
  }
  if (inPath) ctx.stroke()

  // Pass 2: Narrower, brighter glow
  ctx.lineWidth = FAR_GLOW_WIDTH
  ctx.strokeStyle = `rgba(132, 209, 219, ${(FAR_GLOW_INTENSITY * 0.6).toFixed(3)})`

  inPath = false
  ctx.beginPath()
  for (let col = 0; col < W; col++) {
    const cd = columns[col]
    const farY = cd.bandScreenY[cd.farBandIdx]
    if (farY >= H || cd.farDist < 30_000) {
      if (inPath) { ctx.stroke(); ctx.beginPath(); inPath = false }
      continue
    }

    if (!inPath) {
      ctx.moveTo(col, farY)
      inPath = true
    } else {
      ctx.lineTo(col, farY)
    }
  }
  if (inPath) ctx.stroke()

  ctx.restore()
}

// ─── Contour Renderer with Depth Haze ────────────────────────────────────────

/**
 * Render contour lines with atmospheric haze applied. Contours farther away
 * fade toward the haze color, naturally reducing visual density at distance.
 * Also handles occlusion: contour points behind nearer terrain are hidden.
 */
export function renderDepthContours(
  ctx: CanvasRenderingContext2D,
  strands: PrebuiltContourStrand[],
  cam: CameraParams,
  globalElevMin: number,
  globalElevMax: number,
  buffer: SkylineBuffer | null,
): void {
  const { W, H } = cam
  const scale = cam.scale ?? 1
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1

  const WIDTH_MIN = 0.5 * scale
  const WIDTH_MAX = 5 * scale
  const WIDTH_RANGE = WIDTH_MAX - WIDTH_MIN
  const WIDTH_POWER = 0.2

  // Base opacity per band (before haze reduction)
  const CONTOUR_OPACITIES = [0.65, 0.55, 0.45, 0.35, 0.25, 0.15]

  const WIDTH_FLUSH_RATIO = 0.2

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const strand of strands) {
    if (strand.points.length < 2) continue

    const bi = strand.bandIdx
    const baseOpacity = CONTOUR_OPACITIES[bi] ?? 0.15

    const tElev = hasElevRange
      ? Math.max(0, Math.min(1, (strand.level - globalElevMin) / elevRange))
      : 0.5
    const baseColor = elevToRidgeColor(tElev)
    const rgbMatch = baseColor.match(/\d+/g)
    if (!rgbMatch) continue

    const baseR = parseInt(rgbMatch[0])
    const baseG = parseInt(rgbMatch[1])
    const baseB = parseInt(rgbMatch[2])

    let pathStarted = false
    let currentWidth = 0

    for (let i = 0; i < strand.points.length; i++) {
      const pt = strand.points[i]

      // Per-ray depth occlusion: use precomputed occlusion envelope from buffer.
      // The envelope stores the max elevation angle from all nearer bands at each
      // screen column. If this contour point's angle is below that, it's hidden
      // behind closer terrain.
      if (bi > 0 && buffer) {
        const col = Math.round((pt.bearingDeg - cam.heading_deg) / cam.hfov * W + W * 0.5)
        if (col >= 0 && col < W) {
          const cd = buffer.columns[col]
          if (cd.occlusionEnvelope[bi] > -Math.PI / 2 + 0.001 &&
              pt.elevAngleRad <= cd.occlusionEnvelope[bi]) {
            if (pathStarted) { ctx.stroke(); pathStarted = false }
            continue
          }
        }
      }

      const { x, y } = project(pt.bearingDeg, pt.elevAngleRad, cam)
      const onScreen = x >= -10 && x <= W + 10 && y >= 0 && y < H

      if (!onScreen) {
        if (pathStarted) { ctx.stroke(); pathStarted = false }
        continue
      }

      // Apply haze to contour color
      const haze = hazeFactor(pt.dist)
      const opacity = baseOpacity * (1 - haze * 0.6)  // Fade opacity with haze
      const hr = Math.round(baseR + (HAZE_COLOR[0] - baseR) * haze * 0.4)
      const hg = Math.round(baseG + (HAZE_COLOR[1] - baseG) * haze * 0.4)
      const hb = Math.round(baseB + (HAZE_COLOR[2] - baseB) * haze * 0.4)

      const tDist = Math.min(1, pt.dist / MAX_DIST)
      const lw = WIDTH_MIN + WIDTH_RANGE * (1 - Math.pow(tDist, WIDTH_POWER))

      if (!pathStarted) {
        ctx.strokeStyle = `rgba(${hr},${hg},${hb},${opacity.toFixed(3)})`
        ctx.lineWidth = lw
        currentWidth = lw
        ctx.beginPath()
        ctx.moveTo(x, y)
        pathStarted = true
      } else if (Math.abs(lw - currentWidth) > currentWidth * WIDTH_FLUSH_RATIO) {
        ctx.lineTo(x, y)
        ctx.stroke()
        ctx.strokeStyle = `rgba(${hr},${hg},${hb},${opacity.toFixed(3)})`
        ctx.lineWidth = lw
        currentWidth = lw
        ctx.beginPath()
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }

    if (pathStarted) ctx.stroke()
  }
}
