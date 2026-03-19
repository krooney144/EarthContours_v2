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

import type { SkylineData, BandDetectedPeaks, RidgeStrand } from '../../core/types'
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

/** Terrain base colors by distance — visible contrast against dark sky background */
const TERRAIN_NEAR_COLOR: [number, number, number] = [8, 28, 42]     // Dark teal — distinct from sky
const TERRAIN_FAR_COLOR:  [number, number, number] = [14, 50, 75]    // Muted deep blue
const TERRAIN_MID_COLOR:  [number, number, number] = [12, 38, 58]    // Mid-range blue-grey

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
      if (elev[i] === -Infinity || elev[i] < -500) continue
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

    // First pass: compute band screen positions (always — painter's order handles
    // fill/stroke occlusion automatically). bandScreenY is the real projected Y
    // for every band, never set to H for occlusion purposes.
    for (let bi = 0; bi < numBands; bi++) {
      const angle = bandAngleAt(skyline, bi, bearingDeg, projected)
      const elev = bandElevAt(skyline, bi, bearingDeg)
      const dist = bandDistAt(skyline, bi, bearingDeg)

      bandAngles[bi] = angle
      bandElevs[bi] = elev
      bandDists[bi] = dist
      bandIsWater[bi] = elev !== -Infinity && elev >= -10 && elev < OCEAN_ELEV_M

      if (angle <= SENTINEL) {
        bandScreenY[bi] = H
      } else {
        const { y } = project(bearingDeg, angle, cam)
        bandScreenY[bi] = Math.round(Math.min(H, Math.max(0, y)))

        if (bandScreenY[bi] < silhouetteY) {
          silhouetteY = bandScreenY[bi]
        }
      }

      // Track the farthest visible band
      if (angle > SENTINEL && dist > farDist) {
        farDist = dist
        farBandIdx = bi
      }
    }

    // Second pass: compute per-ray occlusion envelope for contour lines.
    // Sweep near → far, tracking running max elevation angle. The envelope
    // tells the contour renderer: "at this column, any contour point from
    // band bi at an angle ≤ occlusionEnvelope[bi] is hidden behind closer
    // terrain." Fills and ridgeline strokes don't need this — painter's
    // order (far → near) handles their occlusion automatically.
    let maxOccAngle = SENTINEL
    for (let bi = 0; bi < numBands; bi++) {
      occlusionEnvelope[bi] = maxOccAngle
      const angle = bandAngles[bi]
      if (angle > maxOccAngle) {
        maxOccAngle = angle
      }
      // A band is "ridgeline-occluded" when its ridgeline stroke would be
      // hidden behind a closer band's fill. Used only for stroke skipping.
      bandOccluded[bi] = angle > SENTINEL && angle <= occlusionEnvelope[bi]
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
 * Render layered terrain with continuous distance-based coloring using
 * putImageData for per-pixel color control. No band color steps — every
 * column gets its own color based on distance, with atmospheric haze.
 *
 * Algorithm:
 *   1. Build an ImageData pixel buffer
 *   2. For each column, paint bands far→near (painter's order)
 *      - Each column fills from its own screenY down to the canvas bottom
 *      - Near bands overwrite far bands, providing natural occlusion
 *   3. Stamp the buffer with one putImageData call
 *
 *   Ridgeline strokes are NOT drawn here — they come from renderRidgeStrands
 *   which uses detected ridge features rather than band maxima.
 */
export function renderDepthTerrain(
  ctx: CanvasRenderingContext2D,
  buffer: SkylineBuffer,
  skyline: SkylineData,
  cam: CameraParams,
  _projected: ProjectedBands | null,
  _showBandLines: boolean = true,
  showFill: boolean = true,
): void {
  const { W, H } = cam
  const numBands = skyline.bands.length
  const { columns } = buffer

  if (!showFill) return

  // ── Pixel buffer — one putImageData call for all terrain fill ───────────
  const imageData = ctx.createImageData(W, H)
  const px = imageData.data

  for (let col = 0; col < W; col++) {
    const cd = columns[col]

    // Paint bands far → near (painter's algorithm per column)
    for (let bi = numBands - 1; bi >= 0; bi--) {
      const screenY = cd.bandScreenY[bi]
      if (screenY >= H) continue  // no terrain this band this column

      const dist  = cd.bandDists[bi]
      const isWater = cd.bandIsWater[bi]

      // Base color
      let baseR: number, baseG: number, baseB: number
      if (isWater) {
        if (cd.bandElevs[bi] < 2) {
          baseR = OCEAN_COLOR[0]; baseG = OCEAN_COLOR[1]; baseB = OCEAN_COLOR[2]
        } else {
          baseR = WATER_COLOR[0]; baseG = WATER_COLOR[1]; baseB = WATER_COLOR[2]
        }
      } else {
        const [r, g, b] = terrainColorForDist(dist)
        baseR = r; baseG = g; baseB = b
      }

      // Continuous atmospheric haze — no steps
      const haze = hazeFactor(dist)
      const finalR = Math.round(baseR + (HAZE_COLOR[0] - baseR) * haze)
      const finalG = Math.round(baseG + (HAZE_COLOR[1] - baseG) * haze)
      const finalB = Math.round(baseB + (HAZE_COLOR[2] - baseB) * haze)

      // Subtle vertical darkening for depth perception
      const bandH = Math.max(1, H - screenY)

      // Fill from screenY to H — near bands overwrite far bands
      for (let y = screenY; y < H; y++) {
        const yFrac = (y - screenY) / bandH
        const shade = 1 - yFrac * 0.15

        const idx = (y * W + col) * 4
        px[idx]     = Math.round(finalR * shade)
        px[idx + 1] = Math.round(finalG * shade)
        px[idx + 2] = Math.round(finalB * shade)
        px[idx + 3] = 255
      }
    }
  }

  // One single draw call for all terrain fill
  ctx.putImageData(imageData, 0, 0)
}

// ─── Ridge Strand Renderer ───────────────────────────────────────────────────

/**
 * Render ridge strands as variable-weight elevation-colored strokes.
 *
 * Each strand is a connected sequence of detected peak points across azimuths.
 * Stroke weight = baseThickness × sharpness × distanceFade
 * Stroke color  = elevToRidgeColor(tElev) with atmospheric haze
 *
 * Draw order: far strands first so near strands paint over them (painter's order).
 * Called after renderDepthTerrain fill, before contour lines.
 */
export function renderRidgeStrands(
  ctx:           CanvasRenderingContext2D,
  ridgeStrands:  RidgeStrand[],
  cam:           CameraParams,
  viewerElev:    number,
  globalElevMin: number,
  globalElevMax: number,
): void {
  const { W, H } = cam
  const scale     = cam.scale ?? 1
  const elevRange = globalElevMax - globalElevMin || 1

  // Per-band base thickness — thicker near, fading far
  const BASE_WIDTHS  = [4.5, 4.0, 3.2, 2.4, 1.0, 0.5]
  const BASE_ALPHAS  = [0.95, 0.92, 0.85, 0.72, 0.35, 0.18]

  // Sort strands far → near for correct painter's order
  const sorted = [...ridgeStrands].sort((a, b) => b.peakDist - a.peakDist)

  ctx.lineCap  = 'round'
  ctx.lineJoin = 'round'

  const SENTINEL = -Math.PI / 2 + 0.001

  for (const strand of sorted) {
    if (strand.points.length < 2) continue

    const bi        = strand.bandIndex
    const baseWidth = (BASE_WIDTHS[bi]  ?? 0.5) * scale
    const baseAlpha = BASE_ALPHAS[bi] ?? 0.18

    // Batched path rendering — only flush when width/alpha change significantly.
    // This eliminates visual gaps between segments and produces smooth continuous strokes.
    let pathOpen   = false
    let lastWidth  = 0
    let lastAlpha  = 0

    for (let i = 1; i < strand.points.length; i++) {
      const prev = strand.points[i - 1]
      const curr = strand.points[i]

      // Project both points to screen using current viewer elevation
      const curvDropPrev = (prev.dist * prev.dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const anglePrev    = Math.atan2(prev.elev - curvDropPrev - viewerElev, prev.dist)

      const curvDropCurr = (curr.dist * curr.dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const angleCurr    = Math.atan2(curr.elev - curvDropCurr - viewerElev, curr.dist)

      if (anglePrev <= SENTINEL || angleCurr <= SENTINEL) {
        if (pathOpen) { ctx.stroke(); pathOpen = false }
        continue
      }

      const p0 = project(prev.bearingDeg, anglePrev, cam)
      const p1 = project(curr.bearingDeg, angleCurr, cam)

      // Skip if both points off screen
      if ((p0.x < -10 && p1.x < -10) ||
          (p0.x > W+10 && p1.x > W+10) ||
          (p0.y > H    && p1.y > H)) {
        if (pathOpen) { ctx.stroke(); pathOpen = false }
        continue
      }

      // Use smoothed sharpness
      const sharpness = (prev.sharpness + curr.sharpness) * 0.5

      // Distance-based haze — continuous, no steps
      const avgDist = (prev.dist + curr.dist) * 0.5
      const tDist = Math.pow(Math.min(1, avgDist / MAX_DIST), 0.6)
      const haze  = tDist * 0.7

      // Final stroke weight
      const finalWidth = baseWidth * sharpness * (1 - tDist * 0.5)
      const finalAlpha = baseAlpha * sharpness * (1 - haze * 0.4)

      if (finalAlpha < 0.02 || finalWidth < 0.15) {
        if (pathOpen) { ctx.stroke(); pathOpen = false }
        continue
      }

      // Only flush and restart path when width/alpha change significantly
      const widthChanged = Math.abs(finalWidth - lastWidth) > lastWidth * 0.15
      const alphaChanged = Math.abs(finalAlpha - lastAlpha) > 0.08

      if (!pathOpen || widthChanged || alphaChanged) {
        if (pathOpen) ctx.stroke()

        // Elevation-based color with atmospheric haze
        const avgElev = (prev.elev + curr.elev) * 0.5
        const tElev  = Math.max(0, Math.min(1, (avgElev - globalElevMin) / elevRange))
        const colorStr = elevToRidgeColor(tElev)
        const rgb    = colorStr.match(/\d+/g)
        if (!rgb) { pathOpen = false; continue }

        const r = Math.round(+rgb[0] + (HAZE_COLOR[0] - +rgb[0]) * haze)
        const g = Math.round(+rgb[1] + (HAZE_COLOR[1] - +rgb[1]) * haze)
        const b = Math.round(+rgb[2] + (HAZE_COLOR[2] - +rgb[2]) * haze)

        ctx.globalAlpha = finalAlpha
        ctx.strokeStyle = `rgb(${r},${g},${b})`
        ctx.lineWidth   = finalWidth
        ctx.beginPath()
        ctx.moveTo(p0.x, p0.y)
        pathOpen  = true
        lastWidth = finalWidth
        lastAlpha = finalAlpha
      }

      ctx.lineTo(p1.x, p1.y)
    }

    if (pathOpen) ctx.stroke()
  }

  // Always restore globalAlpha
  ctx.globalAlpha = 1
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
