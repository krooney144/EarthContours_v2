// Placeholder removed — full SCAN implementation below.

/**
 * EarthContours — SCAN Screen  (v2.2)
 *
 * First-person terrain panorama with depth-layered ridgeline rendering.
 *
 * ── Architecture (3 layers) ──────────────────────────────────────────────────
 *
 *  Layer 1 — THE CAMERA (pure math, no drawing):
 *    project(bearingDeg, elevAngleRad, cam) → {x, y}
 *    Single source of truth for all bearing/elevation → screen conversions.
 *    Ridgeline, peak dots, peak labels all call this ONE function.
 *
 *  Layer 2 — SCENE DATA (what exists in the world):
 *    Worker produces SkylineData with 6 depth bands
 *    (ultra-near/near/mid-near/mid/mid-far/far).
 *    Each band stores raw elevation + distance per azimuth.
 *    Main-thread reprojectBands() re-derives angles when AGL changes
 *    — no worker round-trip needed.
 *
 *  Layer 3 — THE RENDERER (draws the scene in painter's order):
 *    renderTerrain() draws bands far→near with depth cues:
 *      - Far: thin lines (1px), low opacity (0.15), light fill
 *      - Mid: medium lines (2.5px), mid opacity (0.4), medium fill
 *      - Near: thick lines (4.5px), high opacity (0.8), dark fill
 *      - Ultra-near: thickest lines (5px), vivid opacity (0.9), deep fill
 *    Adding bands = pushing to DEPTH_BANDS array; renderer auto-scales.
 *
 * ── Painter's order ─────────────────────────────────────────────────────────
 *   1  Sky gradient + stars
 *   2  Far band fill + stroke
 *   3  Mid band fill + stroke
 *   4  Near band fill + stroke
 *   5  Horizon glow
 *   6  Peak dots (snapped to ridgeline via project())
 *   7  Peak label cards (HTML overlay)
 *
 * ── Peak visibility ──────────────────────────────────────────────────────────
 *   isPeakVisible() compares peak elevation angle against the ridgeline.
 *   Dots snap to the max per-band ridgeline angle at the peak's bearing,
 *   ensuring they match exactly what's drawn on screen.  Snap is upward-only:
 *   if the peak's true angle is above all bands, its real position is kept.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useCameraStore, useLocationStore, useTerrainStore, useSettingsStore,
} from '../../store'
import { createLogger } from '../../core/logger'
import {
  COMPASS_DIRECTIONS, COMPASS_ITEM_WIDTH,
  MAX_HEIGHT_M, MIN_HEIGHT_M,
} from '../../core/constants'
import {
  formatElevation, formatDistance, calculateBearing,
  headingToCompass, clamp, metersToFeet,
} from '../../core/utils'
import { fetchPeaksNear }                from '../../data/peakLoader'
import type { Peak, SkylineData, SkylineBand, SkylineRequest, RefinedArc, PeakRefineItem, SilhouetteLayer, SilhouetteData, NearFieldProfile } from '../../core/types'
import { DEPTH_BANDS, SILHOUETTE_FLOATS_PER_CANDIDATE, NEAR_PROFILE_SAMPLES, NEAR_PROFILE_AGL_LIMIT } from '../../core/types'
import { NavigateHint } from '../../components/NavigateHint/NavigateHint'
import { TutorialOverlay } from '../../components/TutorialOverlay/TutorialOverlay'
import styles from './ScanScreen.module.css'

const log = createLogger('SCREEN:SCAN')

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_DIST          = 400_000     // Maximum render distance (m) — extended for high-AGL viewing
const MAX_PEAK_DIST     = 400_000     // Max distance for peak label display (m)
const EARTH_R           = 6_371_000  // Earth radius (m)
const REFRACTION_K      = 0.13       // Atmospheric refraction coefficient
const DEG_TO_RAD        = Math.PI / 180
const SKYLINE_RESOLUTION = 4         // 0.25° per step = 1440 azimuths for full 360°

// ─── Unified Terrain Fill ─────────────────────────────────────────────────────
// Single flat base color for ALL terrain surfaces (band fills, silhouette fills,
// near-field occlusion). Contour/ridgeline strokes sit on top with elevation-based
// coloring. One color per theme eliminates blocky multi-band fill appearance.
const TERRAIN_FILL_DARK  = 'rgb(4, 10, 18)'     // Deep navy — darker than sky gradient, contour lines visible
const TERRAIN_FILL_LIGHT = 'rgb(175, 185, 170)'  // Cool sage/grey-green

// ─── Re-Projection (AGL changes without worker round-trip) ────────────────────

/**
 * Per-band projected elevation angles — computed on the main thread from
 * the worker's raw elevation/distance data whenever viewerElev changes.
 * This avoids a ~2s worker recompute when the user drags the AGL slider.
 */
interface ProjectedBands {
  /** Per-band elevation angles (radians) at each azimuth. Index matches DEPTH_BANDS. */
  bandAngles: Float32Array[]
  /** Overall max angle per azimuth (across all bands) — replaces skylineData.angles for rendering */
  overallAngles: Float32Array
  /** The viewer elevation these were computed for (used to detect staleness) */
  viewerElev: number
}

/**
 * Re-project band elevation angles from raw world data for a new viewer elevation.
 * Handles per-band resolution (high-res near bands have more azimuth samples).
 * Sub-millisecond even with mixed resolutions.
 */
function reprojectBands(
  skyline: SkylineData,
  viewerElev: number,
): ProjectedBands {
  const { numAzimuths, bands } = skyline
  const bandAngles: Float32Array[] = []
  const overallAngles = new Float32Array(numAzimuths)
  overallAngles.fill(-Math.PI / 2)

  for (let bi = 0; bi < bands.length; bi++) {
    const band = bands[bi]
    const bandAz = band.numAzimuths
    const bandRes = band.resolution
    const angles = new Float32Array(bandAz)

    for (let ai = 0; ai < bandAz; ai++) {
      const elev = band.elevations[ai]
      const dist = band.distances[ai]

      if (elev === -Infinity || elev <= 0 || dist <= 0) {
        angles[ai] = -Math.PI / 2
        continue
      }

      const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const effElev  = elev - curvDrop
      angles[ai] = Math.atan2(effElev - viewerElev, dist)

      // Map this high-res azimuth back to the standard-res overall array
      // For standard-res bands (same resolution), this is 1:1
      // For high-res bands, multiple high-res samples map to one standard sample
      const overallIdx = Math.round((ai / bandRes) * skyline.resolution) % numAzimuths
      if (angles[ai] > overallAngles[overallIdx]) {
        overallAngles[overallIdx] = angles[ai]
      }
    }

    bandAngles.push(angles)
  }

  return { bandAngles, overallAngles, viewerElev }
}

// ─── Refined Arc Re-Projection ──────────────────────────────────────────────

/**
 * Pre-computed elevation angles for each refined arc sample.
 * Recomputed on the main thread when AGL changes, same as band re-projection.
 */
interface ProjectedRefinedArc {
  /** Elevation angles (radians) per sample, re-projected for current viewerElev */
  angles: Float32Array
  /** Reference to the source arc (for bearing/distance/GPS lookups) */
  arc: RefinedArc
}

/**
 * Re-project refined arc angles from raw world data for a new viewer elevation.
 * Each arc has ~240 samples — 20 arcs = ~4,800 atan2 calls, sub-millisecond.
 */
function reprojectRefinedArcs(
  arcs: RefinedArc[],
  viewerElev: number,
): ProjectedRefinedArc[] {
  return arcs.map(arc => {
    const angles = new Float32Array(arc.numSamples)
    for (let i = 0; i < arc.numSamples; i++) {
      const elev = arc.elevations[i]
      const dist = arc.distances[i]
      if (elev === -Infinity || dist <= 0) {
        angles[i] = -Math.PI / 2
        continue
      }
      const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      angles[i] = Math.atan2(elev - curvDrop - viewerElev, dist)
    }
    return { angles, arc }
  })
}

// ─── Near-Field Occlusion Profile Re-Projection ─────────────────────────────

/**
 * Re-projected near-field profile: per-azimuth running-max elevation angle
 * envelope.  The envelope gives the maximum angle that near terrain reaches
 * at each distance step — everything below this angle is hidden by nearer
 * terrain.  Used by renderNearFieldOcclusion() to draw an opaque fill.
 *
 * Fixed-stride layout: envelope[ai * NEAR_PROFILE_SAMPLES + si] = max angle
 * at sample index si for azimuth ai.  -PI/2 sentinel for empty slots.
 */
interface ProjectedNearProfile {
  /** Per-azimuth running-max angle envelope.
   *  Length = numAzimuths × NEAR_PROFILE_SAMPLES. */
  envelope: Float32Array
  /** Valid sample counts per azimuth (from worker). */
  sampleCounts: Uint16Array
  /** Number of azimuths. */
  numAzimuths: number
  /** Azimuth resolution (steps per degree). */
  resolution: number
}

/**
 * Re-project the near-field elevation profile at the current viewer elevation.
 * For each azimuth, walks the 50 distance samples near→far, computing elevation
 * angles and tracking the running maximum (occlusion envelope).
 *
 * Cost: 2880 azimuths × 50 samples = 144K atan2 calls ≈ 1.5ms.
 * Only called when AGL < 60m (200ft) and profile data exists.
 */
function reprojectNearProfile(
  profile: NearFieldProfile,
  viewerElev: number,
): ProjectedNearProfile {
  const { profileData, sampleCounts, numAzimuths, resolution } = profile
  const FPS = 2  // floats per sample: rawElev, dist
  const stride = NEAR_PROFILE_SAMPLES * FPS

  const envelope = new Float32Array(numAzimuths * NEAR_PROFILE_SAMPLES)
  envelope.fill(-Math.PI / 2)  // sentinel

  for (let ai = 0; ai < numAzimuths; ai++) {
    const count = sampleCounts[ai]
    if (count === 0) continue

    const base = ai * stride
    const envBase = ai * NEAR_PROFILE_SAMPLES
    let maxAngle = -Math.PI / 2

    for (let si = 0; si < count; si++) {
      const off = base + si * FPS
      const rawElev = profileData[off]
      const dist    = profileData[off + 1]

      if (rawElev === -Infinity || rawElev < 2.0 || dist <= 0) continue

      const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const angle = Math.atan2(rawElev - curvDrop - viewerElev, dist)

      if (angle > maxAngle) maxAngle = angle
      envelope[envBase + si] = maxAngle
    }
  }

  return { envelope, sampleCounts, numAzimuths, resolution }
}

// ─── Silhouette Layer Builder (AGL-dependent, runs on every height change) ───

/**
 * Build visible silhouette layers from the worker's AGL-independent candidate data.
 * For each azimuth, sweeps candidates front-to-back (near→far), computing elevation
 * angles at the current viewerElev.  A candidate is visible if its angle exceeds
 * the running maximum from all nearer terrain.
 *
 * Returns SilhouetteLayers[azimuthIdx][layerIdx] — layers sorted near→far within
 * each azimuth.  Typically 2–12 layers per azimuth in mountainous terrain.
 *
 * Cost: ~26 candidates × 2880 azimuths = ~75K atan2 calls.  Sub-millisecond.
 */
function buildSilhouetteLayers(
  skyline: SkylineData,
  viewerElev: number,
): SilhouetteLayer[][] | null {
  const sil = skyline.silhouette
  if (!sil || !sil.candidateData || sil.candidateData.length === 0) return null

  const { candidateData, candidateOffsets, numAzimuths } = sil
  const FPC = 8  // floats per candidate (SILHOUETTE_FLOATS_PER_CANDIDATE)
  const result: SilhouetteLayer[][] = new Array(numAzimuths)

  for (let ai = 0; ai < numAzimuths; ai++) {
    const start = candidateOffsets[ai]
    const end   = candidateOffsets[ai + 1]

    if (start >= end) {
      result[ai] = []
      continue
    }

    const layers: SilhouetteLayer[] = []
    let maxAngle = -Math.PI / 2

    // Candidates are sorted near→far by distance
    for (let off = start; off < end; off += FPC) {
      const effElev     = candidateData[off]
      const rawElev     = candidateData[off + 1]
      const dist        = candidateData[off + 2]
      const lat         = candidateData[off + 3]
      const lng         = candidateData[off + 4]
      const baseEffElev = candidateData[off + 5]
      const baseDist    = candidateData[off + 6]
      const flags       = candidateData[off + 7]

      const peakAngle = Math.atan2(effElev - viewerElev, dist)
      const isOcean   = (flags & 1) !== 0

      // Skip ocean candidates — no terrain fill for ocean
      if (isOcean) continue

      // Visible only if this candidate peeks above all nearer terrain
      if (peakAngle > maxAngle) {
        // Base angle: either the valley floor angle or the current running max
        // (whichever is higher — we can't see below the running max)
        const rawBaseAngle = baseDist > 0
          ? Math.atan2(baseEffElev - viewerElev, baseDist)
          : -Math.PI / 2
        const baseAngle = Math.max(rawBaseAngle, maxAngle)

        layers.push({
          peakAngle,
          baseAngle,
          rawElev,
          dist,
          lat,
          lng,
          effElev,
          baseEffElev,
          isOcean,
        })

        maxAngle = peakAngle
      }
    }

    result[ai] = layers
  }

  return result
}

// ─── Silhouette Layer Matching (connect layers across azimuths into strands) ─

/** A matched silhouette strand: a continuous silhouette edge across azimuths.
 *  Built by matching layers at adjacent azimuths by distance proximity. */
interface SilhouetteStrand {
  /** Per-azimuth data for this strand, indexed by screen column position.
   *  Each entry has the azimuth index and the layer from that azimuth. */
  segments: Array<{ ai: number; layer: SilhouetteLayer }>
  /** Average distance of this strand (for depth-based styling) */
  avgDist: number
}

/**
 * Match silhouette layers across adjacent azimuths into continuous strands.
 * Primary match key: distance proximity — a silhouette line represents terrain
 * at a specific distance from the viewer. Two adjacent azimuth samples belong
 * to the same strand only if they're at approximately the same distance.
 * Minimum peakAngle filter: skip layers whose angle is too low — near-flat
 * ridgelines aren't meaningful silhouettes and clutter the view.
 * Returns strands sorted far→near (for painter's order fill rendering).
 */
function matchSilhouetteStrands(
  layers: SilhouetteLayer[][],
  numAzimuths: number,
  resolution: number,
  cam: CameraParams,
): SilhouetteStrand[] {
  const { heading_deg, hfov, W } = cam

  // Minimum peakAngle — fixed relative to horizon. AGL is already baked into
  // peakAngle by buildSilhouetteLayers (atan2(effElev - viewerElev, dist)).
  // Camera pitch only affects where on screen things are drawn, not whether
  // silhouette lines exist. Same mountain at same AGL = same silhouettes.
  const MIN_PEAK_ANGLE = -0.35  // ~-20° below horizon

  // Determine visible azimuth range
  const bearingStart = heading_deg - hfov * 0.5
  const bearingEnd   = heading_deg + hfov * 0.5

  const aiStart = Math.floor(((bearingStart % 360 + 360) % 360) * resolution)
  const aiEnd   = Math.ceil(((bearingEnd % 360 + 360) % 360) * resolution)

  // Active strands being built
  interface ActiveStrand {
    segments: Array<{ ai: number; layer: SilhouetteLayer }>
    lastAi:   number
    lastDist: number
    distSum:  number
  }
  const active: ActiveStrand[] = []
  const completed: SilhouetteStrand[] = []
  const MAX_AZ_GAP = Math.ceil(resolution * 4)  // Max 4° gap before expiring

  // Sweep through visible azimuths
  const totalVisible = aiEnd >= aiStart
    ? aiEnd - aiStart + 1
    : (numAzimuths - aiStart) + aiEnd + 1

  for (let step = 0; step < totalVisible; step++) {
    const ai = (aiStart + step) % numAzimuths
    const azLayers = layers[ai]
    if (!azLayers || azLayers.length === 0) continue

    const matched = new Set<number>()  // indices into active that got matched

    for (const layer of azLayers) {
      // Skip layers below minimum angle — not meaningful silhouettes
      if (layer.peakAngle < MIN_PEAK_ANGLE) continue

      // Find closest active strand by distance — primary match key.
      // A real ridgeline varies ±10-15% in distance across its bearing span
      // (cosine effect of a ridge curving away). Tighter tolerance prevents
      // connecting candidates from different ridges at different depths.
      let bestIdx = -1
      let bestDiff = Infinity
      const distTol = layer.dist < 10_000
        ? Math.max(200, layer.dist * 0.12)   // near: 12%, floor 200m
        : layer.dist < 50_000
        ? Math.max(500, layer.dist * 0.15)   // mid: 15%, floor 500m
        : Math.max(1000, layer.dist * 0.18)  // far: 18%, floor 1km

      for (let si = 0; si < active.length; si++) {
        if (matched.has(si)) continue
        const s = active[si]
        // Check azimuth gap
        const azGap = ai >= s.lastAi ? ai - s.lastAi : (numAzimuths - s.lastAi + ai)
        if (azGap > MAX_AZ_GAP) continue

        const diff = Math.abs(layer.dist - s.lastDist)
        if (diff < bestDiff && diff < distTol) {
          bestIdx = si
          bestDiff = diff
        }
      }

      if (bestIdx >= 0) {
        // Extend existing strand
        active[bestIdx].segments.push({ ai, layer })
        active[bestIdx].lastAi   = ai
        active[bestIdx].lastDist = layer.dist
        active[bestIdx].distSum += layer.dist
        matched.add(bestIdx)
      } else {
        // Start new strand
        active.push({
          segments: [{ ai, layer }],
          lastAi:   ai,
          lastDist: layer.dist,
          distSum:  layer.dist,
        })
      }
    }

    // Expire old strands (check periodically)
    if (step % MAX_AZ_GAP === 0) {
      for (let si = active.length - 1; si >= 0; si--) {
        const s = active[si]
        const azGap = ai >= s.lastAi ? ai - s.lastAi : (numAzimuths - s.lastAi + ai)
        if (azGap > MAX_AZ_GAP) {
          if (s.segments.length >= 3) {
            completed.push({
              segments: s.segments,
              avgDist:  s.distSum / s.segments.length,
            })
          }
          active.splice(si, 1)
        }
      }
    }
  }

  // Flush remaining active strands
  for (const s of active) {
    if (s.segments.length >= 3) {
      completed.push({
        segments: s.segments,
        avgDist:  s.distSum / s.segments.length,
      })
    }
  }

  // Sort far→near for painter's order (far drawn first, near on top)
  completed.sort((a, b) => b.avgDist - a.avgDist)

  return completed
}

// ─── Silhouette Renderer ─────────────────────────────────────────────────────

// ─── Near-Field Occlusion Renderer ───────────────────────────────────────────

/**
 * Render the near-field terrain surface as an opaque fill.
 *
 * For each screen column, looks up the near-field profile envelope at that
 * bearing.  The envelope gives the running-max elevation angle from near→far
 * within 0–2km.  We draw an opaque fill from the envelope's max angle down
 * to the screen bottom.  This creates a solid terrain surface that blocks
 * ALL far terrain behind near hills — fixing the "see-through mountains" bug.
 *
 * The fill uses the near-band color (darkest in the palette) for visual
 * consistency with the existing band fill system.
 *
 * Only called when AGL < 60m (200ft) — at higher altitudes the existing
 * band fill system handles occlusion correctly.
 */
function renderNearFieldOcclusion(
  ctx: CanvasRenderingContext2D,
  projectedProfile: ProjectedNearProfile,
  cam: CameraParams,
  darkMode: boolean = true,
): void {
  const { W, H } = cam
  const { envelope, sampleCounts, numAzimuths, resolution } = projectedProfile

  // Unified terrain fill — same flat color as all other terrain surfaces
  const fillColor = darkMode ? TERRAIN_FILL_DARK : TERRAIN_FILL_LIGHT

  // Build a polygon: trace the near terrain "max angle" across screen columns
  ctx.beginPath()
  ctx.moveTo(0, H)

  let hasVisiblePixels = false

  for (let col = 0; col < W; col++) {
    const bearingDeg = cam.heading_deg + (col / W - 0.5) * cam.hfov
    const normBearing = ((bearingDeg % 360) + 360) % 360
    const fracIdx = normBearing * resolution
    const ai0 = Math.floor(fracIdx) % numAzimuths
    const ai1 = (ai0 + 1) % numAzimuths
    const t = fracIdx - Math.floor(fracIdx)

    // Find the max envelope angle for each neighboring azimuth
    const count0 = sampleCounts[ai0]
    const count1 = sampleCounts[ai1]

    if (count0 === 0 && count1 === 0) {
      ctx.lineTo(col, H)
      continue
    }

    // Get the final envelope value (running max at the farthest sample)
    const envBase0 = ai0 * NEAR_PROFILE_SAMPLES
    const envBase1 = ai1 * NEAR_PROFILE_SAMPLES
    const maxAngle0 = count0 > 0 ? envelope[envBase0 + count0 - 1] : -Math.PI / 2
    const maxAngle1 = count1 > 0 ? envelope[envBase1 + count1 - 1] : -Math.PI / 2

    // Interpolate between the two azimuths
    const maxAngle = maxAngle0 * (1 - t) + maxAngle1 * t

    if (maxAngle <= -Math.PI / 2 + 0.001) {
      ctx.lineTo(col, H)
      continue
    }

    hasVisiblePixels = true
    const { y } = project(bearingDeg, maxAngle, cam)
    ctx.lineTo(col, Math.min(H, Math.max(0, Math.round(y))))
  }

  ctx.lineTo(W, H)
  ctx.closePath()

  if (hasVisiblePixels) {
    ctx.fillStyle = fillColor
    ctx.fill()
  }
}

// ─── Silhouette Glow Constants (easy to tune) ─────────────────────────────────
// Blur values interpolate logarithmically from near to far.
const GLOW_BLUR_NEAR    = 20    // px — tight intense glow on very close terrain (<2km)
const GLOW_BLUR_FAR     = 3     // px — subtle whisper on distant ridgelines
const GLOW_MAX_ALPHA    = 0.55  // max glow opacity at peak prominence + near + high angle
const GLOW_DIST_FLOOR   = 0.06  // even the farthest ridge gets a small glow floor
const GLOW_ANGLE_ZERO   = -0.35 // rad — matches MIN_PEAK_ANGLE; all visible silhouette terrain gets glow
const GLOW_ANGLE_FULL   = 0.10  // rad — glow reaches full intensity above this angle
const GLOW_PROMINENCE_SCALE = 150 // metres — ridge this far above its valley = full tProminence

// Diagnostic counter — limits [GLOW-DIAG] output to the first 5 strands across all renders.
// To re-trigger logs in DevTools: window._glowDiag = 0
let _glowDiagCount = 0

/**
 * Render a glow/light-catching effect behind silhouette strands.
 *
 * Multi-pass thick-line approach: draws 3 progressively narrower/brighter
 * strokes per strand, replacing Canvas shadowBlur (which spreads too thin
 * on sub-2px lines to be visible).
 *
 * Asymmetric Y offset per pass:
 *   - Sky side (upward): tighter, brighter passes → defined sky edge
 *   - Terrain side (downward): wider, dimmer pass → diffused bleed
 *
 * Glow intensity driven by angle × distance × prominence(boost):
 *   - Angle: high ridgelines glow strong, flat terrain near threshold = zero
 *   - Distance: near = intense tight glow, far = subtle soft whisper
 *   - Prominence (effElev - baseEffElev): 0.5–1.0 boost multiplier
 *
 * Called BEFORE renderSilhouetteStrokes so the crisp line draws on top.
 */
function renderSilhouetteGlow(
  ctx: CanvasRenderingContext2D,
  strands: SilhouetteStrand[],
  cam: CameraParams,
  globalElevMin: number,
  globalElevMax: number,
  silResolution: number,
  darkMode: boolean = true,
): void {
  const { W, H } = cam
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1
  const maxDist = 400_000
  const MIN_PEAK_ANGLE = -0.35
  const MAX_ANGLE_JUMP = 0.005
  const MIN_STRAND_SEGS = 8
  const numAzimuths = silResolution * 360
  const MAX_AZ_GAP = 4

  ctx.save()
  ctx.lineCap  = 'round'
  ctx.lineJoin = 'round'

  for (let si = 0; si < strands.length; si++) {
    const strand = strands[si]
    const segs = strand.segments
    if (segs.length < MIN_STRAND_SEGS) continue

    const distT = Math.sqrt(Math.min(1, strand.avgDist / maxDist))
    const tDistGlow = GLOW_DIST_FLOOR + (1 - GLOW_DIST_FLOOR) * (1 - distT)

    // Strand-level base width (midpoint of near/far range — glow is atmospheric,
    // doesn't need curvature tapering)
    const maxWidth = 1.5 + (1 - distT) * 3.5
    const minWidth = 0.4 + (1 - distT) * 1.6
    const baseGlowWidth = (minWidth + maxWidth) * 0.5

    // Strand-level color from average elevation
    const avgElev = segs.reduce((s, seg) => s + seg.layer.rawElev, 0) / segs.length
    const tElev = hasElevRange
      ? Math.max(0, Math.min(1, (avgElev - globalElevMin) / elevRange)) : 0.5
    const baseColor = elevToRidgeColor(tElev)
    const rgbMatch = baseColor.match(/\d+/g)
    const gr = rgbMatch ? Math.min(255, Math.round(parseInt(rgbMatch[0]) * 0.9 + 40)) : 140
    const gg = rgbMatch ? Math.min(255, Math.round(parseInt(rgbMatch[1]) * 0.9 + 30)) : 190
    const gb = rgbMatch ? Math.min(255, Math.round(parseInt(rgbMatch[2]) * 0.95 + 50)) : 220

    // Strand-level tGlow from average peakAngle + average prominence
    const avgPeakAngle = segs.reduce((s, seg) => s + seg.layer.peakAngle, 0) / segs.length
    let promSum = 0
    for (const seg of segs) {
      const hasBase = Math.abs(seg.layer.baseAngle - (-Math.PI / 2)) > 0.01
      promSum += hasBase
        ? Math.max(0, seg.layer.effElev - seg.layer.baseEffElev)
        : GLOW_PROMINENCE_SCALE
    }
    const avgProm = promSum / segs.length
    const tProminence = Math.min(1, Math.max(0, avgProm / GLOW_PROMINENCE_SCALE))
    // Ease-out power curve: steep rise from threshold, gentle plateau toward full.
    // At -0.30 rad: 0.44 glow.  At -0.20 rad: 0.87.  At -0.10 rad: 0.98.
    const tLinear = Math.max(0, Math.min(1,
      (avgPeakAngle - GLOW_ANGLE_ZERO) / (GLOW_ANGLE_FULL - GLOW_ANGLE_ZERO)))
    const tAngle = 1 - Math.pow(1 - tLinear, 5)
    const tGlow = tAngle * tDistGlow * (0.5 + 0.5 * tProminence)

    if (tGlow < 0.01) continue

    const glowAlpha = tGlow * GLOW_MAX_ALPHA

    // Asymmetric Y offset: sky (up) gets tight bright passes, terrain (down) gets diffused bleed.
    // Scales with distance so offset is proportional at all depths.
    const baseOffset = 2 + (1 - distT) * 2  // near: 4px, far: 2px

    // Glow passes: drawn wide→narrow so narrower overlays wider.
    // Y offset: negative = sky (up), positive = terrain (down).
    const passes = [
      { widthMul: 6,   alphaMul: 0.10, yOff: +baseOffset },        // terrain bleed (wide, dim, down)
      { widthMul: 3,   alphaMul: 0.22, yOff: -baseOffset * 0.7 },  // sky halo (medium, brighter, up)
      { widthMul: 1.5, alphaMul: 0.45, yOff: -baseOffset * 0.3 },  // sky core (tight, brightest, slight up)
    ]

    // [GLOW-DIAG] Log first 3 strands (far) + last 2 (near) — shows full distance range
    const diagThis = _glowDiagCount < 3 || (si >= strands.length - 2 && _glowDiagCount < 5)
    if (diagThis) {
      console.log(
        `[GLOW-DIAG] Strand ${si + 1}/${strands.length}:` +
        ` segs=${segs.length}, avgDist=${(strand.avgDist / 1000).toFixed(1)}km,` +
        ` distT=${distT.toFixed(3)}, baseWidth=${baseGlowWidth.toFixed(1)}px,` +
        ` passes=[${passes.map(p => (baseGlowWidth * p.widthMul).toFixed(1) + 'px').join(', ')}],` +
        ` offset=${baseOffset.toFixed(1)}px, tGlow=${tGlow.toFixed(3)},` +
        ` glowAlpha=${glowAlpha.toFixed(3)}, color=rgb(${gr},${gg},${gb})`
      )
      _glowDiagCount++
    }

    // Build runs (same azimuth-gap logic as strokes)
    const runs: Array<{ start: number; end: number }> = []
    let runStart = 0
    for (let i = 1; i < segs.length; i++) {
      const prevAi = segs[i - 1].ai
      const currAi = segs[i].ai
      const gap = currAi >= prevAi ? currAi - prevAi : (numAzimuths - prevAi + currAi)
      if (gap > MAX_AZ_GAP) {
        if (i - runStart >= 3) runs.push({ start: runStart, end: i })
        runStart = i
      }
    }
    if (segs.length - runStart >= 3) runs.push({ start: runStart, end: segs.length })

    for (const run of runs) {
      // Project points — angle continuity check keeps the path smooth
      const projected: Array<{ x: number; y: number }> = []
      let prevPeakAngle = -999

      for (let i = run.start; i < run.end; i++) {
        const { ai, layer } = segs[i]
        if (layer.peakAngle < MIN_PEAK_ANGLE) {
          projected.push({ x: 0, y: -9999 })
          prevPeakAngle = -999
          continue
        }
        if (prevPeakAngle > -999 && Math.abs(layer.peakAngle - prevPeakAngle) > MAX_ANGLE_JUMP) {
          projected.push({ x: 0, y: -9999 })
          prevPeakAngle = layer.peakAngle
          continue
        }
        const bearing = ai / silResolution
        const pos = project(bearing, layer.peakAngle, cam)
        if (pos.y >= H) {
          projected.push({ x: pos.x, y: -9999 })
        } else {
          projected.push({ x: pos.x, y: Math.max(0, Math.min(H, pos.y)) })
        }
        prevPeakAngle = layer.peakAngle
      }

      // Draw 3 glow passes over the same projected path
      for (const pass of passes) {
        const passWidth = baseGlowWidth * pass.widthMul
        const passAlpha = glowAlpha * pass.alphaMul

        ctx.lineWidth = passWidth
        ctx.strokeStyle = `rgba(${gr},${gg},${gb},${passAlpha.toFixed(3)})`
        ctx.beginPath()
        let started = false

        for (let j = 0; j < projected.length; j++) {
          const pt = projected[j]
          if (pt.y < -9000) {
            if (started) { ctx.stroke(); ctx.beginPath(); started = false }
            continue
          }

          const yShifted = pt.y + pass.yOff

          if (!started) {
            ctx.moveTo(pt.x, yShifted)
            started = true
          } else if (j + 1 < projected.length && projected[j + 1].y > -9000) {
            const next = projected[j + 1]
            ctx.quadraticCurveTo(pt.x, yShifted, (pt.x + next.x) / 2, (yShifted + next.y + pass.yOff) / 2)
          } else {
            ctx.lineTo(pt.x, yShifted)
          }
        }
        if (started) ctx.stroke()
      }
    }
  }

  ctx.restore()
}

/**
 * Render silhouette edge strokes only.
 *
 * Silhouette FILLS are now interleaved in renderTerrain per-band (painter's order).
 * This function draws only the edge strokes on top of everything.
 * Strokes use strand matching for continuous lines across azimuths.
 */
function renderSilhouetteStrokes(
  ctx: CanvasRenderingContext2D,
  silhouetteLayers: SilhouetteLayer[][],
  strands: SilhouetteStrand[],
  cam: CameraParams,
  globalElevMin: number,
  globalElevMax: number,
  silResolution: number,
  darkMode: boolean = true,
): void {
  const { W, H } = cam
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1
  const maxDist = 400_000
  const numAzimuths = silResolution * 360

  // ── Silhouette edge strokes (strand-based for smooth lines) ────
  // Only draw strokes for strands with enough segments.
  // Use curvature-based line tapering for natural appearance.

  const MIN_STRAND_SEGS = 8   // Eliminate short dash artifacts — 8 segs = 1° bearing
  const MAX_AZ_GAP_FOR_STROKE = 4  // Match the matching gap tolerance
  // Fixed min angle — AGL already baked into peakAngle, pitch is viewport only
  const MIN_PEAK_ANGLE = -0.35  // ~-20° below horizon

  for (const strand of strands) {
    const segs = strand.segments
    if (segs.length < MIN_STRAND_SEGS) continue

    // Sqrt distance scaling — spreads the 0-100km range across more of 0-1,
    // giving much better near/far width separation. Linear was compressing
    // everything under 100km into distT < 0.25.
    const distT = Math.sqrt(Math.min(1, strand.avgDist / maxDist))
    // 1km→0.05, 5km→0.11, 30km→0.27, 100km→0.50, 400km→1.0

    const angles: number[] = segs.map(s => s.layer.peakAngle)
    const baseOpacity = 0.25 + (1 - distT) * 0.55    // near: 0.80, far: 0.25
    const maxWidth    = 1.5 + (1 - distT) * 3.5       // near: 5.0px, far: 1.5px
    const minWidth    = 0.4 + (1 - distT) * 1.6       // near: 2.0px, far: 0.4px
    const CURVATURE_THRESHOLD = 0.008

    ctx.lineCap  = 'round'
    ctx.lineJoin = 'round'

    // Break into contiguous runs
    const runs: Array<{ start: number; end: number }> = []
    let runStart = 0
    for (let i = 1; i < segs.length; i++) {
      const prevAi = segs[i - 1].ai
      const currAi = segs[i].ai
      const gap = currAi >= prevAi
        ? currAi - prevAi
        : (numAzimuths - prevAi + currAi)
      if (gap > MAX_AZ_GAP_FOR_STROKE) {
        if (i - runStart >= 3) runs.push({ start: runStart, end: i })
        runStart = i
      }
    }
    if (segs.length - runStart >= 3) runs.push({ start: runStart, end: segs.length })

    for (const run of runs) {
      // Pre-project all points in this run, filtering out low-angle segments
      // and marking angle discontinuities as path breaks
      const MAX_ANGLE_JUMP = 0.005  // rad — max natural peakAngle change per 0.125° azimuth step
      interface SilPt { x: number; y: number; rawElev: number; curvature: number }
      const projected: SilPt[] = []
      let prevPeakAngle = -999  // sentinel for first point

      for (let i = run.start; i < run.end; i++) {
        const { ai, layer } = segs[i]
        // Skip segments below minimum angle
        if (layer.peakAngle < MIN_PEAK_ANGLE) {
          projected.push({ x: 0, y: -9999, rawElev: 0, curvature: 0 })
          prevPeakAngle = -999
          continue
        }

        // Angle continuity check — break path if peakAngle jumps too much
        // between adjacent strand segments. This catches cross-ridge mismatches
        // that slipped through distance-based matching. AGL-stable because
        // peakAngle already encodes viewer elevation.
        if (prevPeakAngle > -999 && Math.abs(layer.peakAngle - prevPeakAngle) > MAX_ANGLE_JUMP) {
          projected.push({ x: 0, y: -9999, rawElev: 0, curvature: 0 })
          prevPeakAngle = layer.peakAngle  // reset for next segment
          continue
        }

        const bearing = ai / silResolution
        const pos = project(bearing, layer.peakAngle, cam)
        const clampedY = Math.max(0, Math.min(H, pos.y))
        let curvature = 0
        if (i > run.start && i < run.end - 1) {
          curvature = Math.abs(angles[i + 1] - 2 * angles[i] + angles[i - 1])
        }
        if (pos.y >= H) {
          projected.push({ x: pos.x, y: -9999, rawElev: 0, curvature: 0 })
        } else {
          projected.push({ x: pos.x, y: clampedY, rawElev: layer.rawElev, curvature })
        }
        prevPeakAngle = layer.peakAngle
      }

      // Draw smooth curves through valid points
      let pathStarted = false
      const SEG_SIZE = 8  // Update color/width every 8 points

      for (let j = 0; j < projected.length; j++) {
        const pt = projected[j]
        if (pt.y < -9000) {
          if (pathStarted) { ctx.stroke(); pathStarted = false }
          continue
        }

        if (!pathStarted) {
          const tElev = hasElevRange && pt.rawElev > 0
            ? Math.max(0, Math.min(1, (pt.rawElev - globalElevMin) / elevRange)) : 0.5
          const tCurvature = Math.min(1, pt.curvature / CURVATURE_THRESHOLD)
          const lineWidth = minWidth + (maxWidth - minWidth) * (0.2 + 0.8 * tCurvature)
          ctx.beginPath()
          ctx.lineWidth = lineWidth
          ctx.globalAlpha = baseOpacity
          ctx.strokeStyle = elevToRidgeColor(tElev)
          ctx.moveTo(pt.x, pt.y)
          pathStarted = true
        } else if (j % SEG_SIZE === 0) {
          // Flush and update style
          ctx.stroke()
          const tElev = hasElevRange && pt.rawElev > 0
            ? Math.max(0, Math.min(1, (pt.rawElev - globalElevMin) / elevRange)) : 0.5
          const tCurvature = Math.min(1, pt.curvature / CURVATURE_THRESHOLD)
          const lineWidth = minWidth + (maxWidth - minWidth) * (0.2 + 0.8 * tCurvature)
          ctx.beginPath()
          ctx.lineWidth = lineWidth
          ctx.strokeStyle = elevToRidgeColor(tElev)
          ctx.moveTo(projected[j - 1].x, projected[j - 1].y)
          // quadraticCurveTo to this point via midpoint
          if (j + 1 < projected.length && projected[j + 1].y > -9000) {
            const next = projected[j + 1]
            ctx.quadraticCurveTo(pt.x, pt.y, (pt.x + next.x) / 2, (pt.y + next.y) / 2)
          } else {
            ctx.lineTo(pt.x, pt.y)
          }
        } else if (j + 1 < projected.length && projected[j + 1].y > -9000) {
          // Smooth curve: control=current, end=midpoint to next
          const next = projected[j + 1]
          ctx.quadraticCurveTo(pt.x, pt.y, (pt.x + next.x) / 2, (pt.y + next.y) / 2)
        } else {
          // Last valid point or next is invalid: line to exact position
          ctx.lineTo(pt.x, pt.y)
        }
      }
      if (pathStarted) ctx.stroke()
    }
    ctx.globalAlpha = 1.0
  }
}

// ─── Contour Strand Precomputation ────────────────────────────────────────────

/** Contour interval in metres for each depth band index.
 *  Progressive density: ultra-near = 50ft, near = 100ft, mid-near = 200ft,
 *  mid = 500ft, mid-far = 1000ft, far = 2000ft. */
const CONTOUR_INTERVALS_M: number[] = [15.24, 30.48, 60.96, 60.96, 152.4, 304.8]

/** A pre-built contour strand — world-space data ready for per-frame projection. */
interface PrebuiltContourStrand {
  level:    number   // Contour elevation (m), snapped to interval grid
  bandIdx:  number   // Depth band index (for line width/opacity)
  interval: number   // Contour interval for this band (m) — used for major/minor detection
  /** Per-point bearing + elevation angle + distance. Angle is precomputed for the current viewerElev. */
  points:   Array<{ bearingDeg: number; elevAngleRad: number; dist: number }>
}

/**
 * Build contour strands from crossing data across all 360° azimuths.
 * Runs once when skyline data arrives or AGL changes — NOT per frame.
 *
 * For each band: iterates all azimuths, runs occlusion sweep, then
 * strand-tracks by level + direction + distance proximity. Contour levels
 * are snapped to the band's interval grid to eliminate floating point drift.
 */
function buildContourStrands(
  skyline: SkylineData,
  viewerElev: number,
): PrebuiltContourStrand[] {
  const completed: PrebuiltContourStrand[] = []

  for (let bi = skyline.bands.length - 1; bi >= 0; bi--) {
    const band = skyline.bands[bi]
    const bandAz = band.numAzimuths
    const bandRes = band.resolution
    const offsets = band.crossingOffsets
    const data = band.crossingData
    const interval = CONTOUR_INTERVALS_M[bi] || 152.4

    // DEBUG: Log crossing data availability per band
    console.log(`[CONTOUR-DEBUG] Band ${bi} (${bandAz}az, res=${bandRes}): crossingData=${data?.length ?? 0} floats, crossings≈${data ? Math.floor(data.length / 5) : 0}, offsets=${offsets?.length ?? 0}`)

    if (!data || data.length === 0) continue

    const maxAzGap = Math.ceil(bandRes * 2)  // Max 2° gap before expiring strand

    // Active strands keyed by snapped-level + direction
    const activeStrands = new Map<string, Array<{
      lastAi:   number
      lastDist: number
      level:    number
      points:   Array<{ bearingDeg: number; elevAngleRad: number; dist: number }>
    }>>()

    for (let ai = 0; ai < bandAz; ai++) {
      const start = offsets[ai]
      const end = offsets[ai + 1]
      const bearingDeg = ai / bandRes

      if (start < end) {
        // Collect crossings, sort near-first for occlusion sweep
        const azCrossings: Array<{ elev: number; dist: number; dir: number }> = []
        for (let j = start; j < end; j += 5) {
          azCrossings.push({ elev: data[j], dist: data[j + 1], dir: data[j + 4] })
        }
        azCrossings.sort((a, b) => a.dist - b.dist)

        // Occlusion sweep: skip crossings hidden behind nearer terrain.
        // For near bands (0–2), disable within-band occlusion — these bands span
        // wide depth ranges (e.g. 0–4.5km) where a hillside at 200m would wrongly
        // occlude all contours out to 4.5km. Painter's order rendering handles
        // visual overlap correctly without data-level occlusion.
        // For far bands (3+), within-band occlusion remains useful since crossings
        // are at similar depths where true occlusion is meaningful.
        let runningMaxAngle = -Math.PI / 2
        const useOcclusion = bi >= 3  // Only occlude within mid/mid-far/far bands
        for (const c of azCrossings) {
          const curvDrop = (c.dist * c.dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
          const angle = Math.atan2(c.elev - curvDrop - viewerElev, c.dist)

          if (useOcclusion && angle <= runningMaxAngle) continue
          if (useOcclusion) runningMaxAngle = angle

          // Skip sea-level / near-sea-level elevation — avoids coastline artifacts
          if (c.elev < 1) continue

          // Snap level to nearest interval — eliminates floating point drift
          const snappedLevel = Math.round(c.elev / interval) * interval
          const levelKey = `${snappedLevel}_${c.dir > 0 ? 'u' : 'd'}`

          let strands = activeStrands.get(levelKey)
          if (!strands) {
            strands = []
            activeStrands.set(levelKey, strands)
          }

          // Match to closest strand by distance proximity
          // Per-band tolerance: tight for close bands (prevents jumpy connections),
          // looser for far bands where large gaps are natural
          const maxDistDiff = bi <= 1
            ? Math.max(10, c.dist * 0.02)   // ultra-near + near: 2%, floor 10m
            : bi === 2
            ? Math.max(50, c.dist * 0.03)   // mid-near: 3%, floor 50m
            : Math.max(200, c.dist * 0.05)  // mid/mid-far/far: 5%, floor 200m (original)
          let bestIdx = -1
          let bestDiff = Infinity
          for (let si = 0; si < strands.length; si++) {
            const s = strands[si]
            if (s.lastAi === ai) continue          // Already matched this azimuth
            if (ai - s.lastAi > maxAzGap) continue // Too old
            const diff = Math.abs(c.dist - s.lastDist)
            if (diff < bestDiff && diff < maxDistDiff) {
              bestIdx = si
              bestDiff = diff
            }
          }

          if (bestIdx >= 0) {
            strands[bestIdx].lastAi = ai
            strands[bestIdx].lastDist = c.dist
            strands[bestIdx].points.push({ bearingDeg, elevAngleRad: angle, dist: c.dist })
          } else {
            strands.push({
              lastAi: ai,
              lastDist: c.dist,
              level: snappedLevel,
              points: [{ bearingDeg, elevAngleRad: angle, dist: c.dist }],
            })
          }
        }
      }

      // Expire old strands periodically (amortized)
      if (ai % maxAzGap === 0) {
        for (const [key, strands] of activeStrands) {
          const remaining: typeof strands = []
          for (const s of strands) {
            if (ai - s.lastAi > maxAzGap) {
              if (s.points.length >= 2) {
                completed.push({ level: s.level, bandIdx: bi, interval, points: s.points })
              }
            } else {
              remaining.push(s)
            }
          }
          if (remaining.length === 0) activeStrands.delete(key)
          else activeStrands.set(key, remaining)
        }
      }
    }

    // Flush remaining active strands
    for (const [, strands] of activeStrands) {
      for (const s of strands) {
        if (s.points.length >= 2) {
          completed.push({ level: s.level, bandIdx: bi, interval, points: s.points })
        }
      }
    }

    // DEBUG: Count strands for this band
    const bandStrandCount = completed.filter(s => s.bandIdx === bi).length
    const bandPointCount = completed.filter(s => s.bandIdx === bi).reduce((sum, s) => sum + s.points.length, 0)
    console.log(`[CONTOUR-DEBUG] Band ${bi}: ${bandStrandCount} strands, ${bandPointCount} total points`)
  }

  return completed
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DragState {
  isDragging: boolean
  lastX: number
  lastY: number
}

interface PinchState {
  isPinching:  boolean
  lastDist:    number
  startFov:    number
}

interface PeakScreenPos {
  id:          string
  name:        string
  nameEn?:     string  // English name (when different from primary name)
  elevation_m: number
  dist_km:     number
  bearing:     number
  lat:         number
  lng:         number
  screenX:     number
  screenY:     number
  stemHeight:  number  // Variable stem height for staggered labels (avoids overlap)
}

// ─── The Camera — Single Source of Truth ──────────────────────────────────────
//
// Every bearing/elevation → screen pixel conversion goes through this one function.
// Ridgeline renderer, peak dots, peak labels — all call project(). If this changes,
// everything moves together. Alignment bugs become structurally impossible.

interface CameraParams {
  heading_deg: number
  pitch_deg:   number
  hfov:        number
  W:           number   // Physical pixels (canvas.width)
  H:           number   // Physical pixels (canvas.height)
}

/**
 * Project a bearing (degrees) and elevation angle (radians) to physical-pixel
 * canvas coordinates.  This is the ONLY function that performs this conversion.
 *
 * bearingDeg: absolute compass bearing (0=N, 90=E, …)
 * elevAngleRad: elevation angle in radians (0=horizon, +up, −down)
 */
function project(
  bearingDeg: number,
  elevAngleRad: number,
  cam: CameraParams,
): { x: number; y: number } {
  const hfovRad  = cam.hfov * DEG_TO_RAD
  const pitchRad = cam.pitch_deg * DEG_TO_RAD

  // Uniform pixels-per-radian: horizontal FOV drives both axes.
  // This gives real camera zoom behaviour — zooming in magnifies equally
  // in both directions, like binoculars.
  const pxPerRad = cam.W / hfovRad

  // Bearing offset from camera center, wrapped to [-180, 180]
  let dBearing = bearingDeg - cam.heading_deg
  if (dBearing > 180) dBearing -= 360
  if (dBearing < -180) dBearing += 360
  const dBearingRad = dBearing * DEG_TO_RAD

  const horizonY = cam.H * 0.5 - pitchRad * pxPerRad

  return {
    x: cam.W * 0.5 + dBearingRad * pxPerRad,
    y: horizonY - elevAngleRad * pxPerRad,
  }
}

/**
 * Compute the horizonY for the current camera (convenience for sky/glow drawing).
 */
function getHorizonY(cam: CameraParams): number {
  const pxPerRad = cam.W / (cam.hfov * DEG_TO_RAD)
  const pitchRad = cam.pitch_deg * DEG_TO_RAD
  return cam.H * 0.5 - pitchRad * pxPerRad
}

// ─── First-Person Projection ──────────────────────────────────────────────────

/**
 * Compute bearing (degrees) and elevation angle (radians) from viewer to a
 * world-space point.  Returns null if the point is behind the viewer.
 * Includes Earth curvature + atmospheric refraction correction.
 */
function worldToBearingElev(
  lat: number, lng: number, elev: number,
  viewerLat: number, viewerLng: number, viewerElev: number,
): { bearingDeg: number; elevAngleRad: number; horizDist: number } | null {
  const cosLat = Math.cos(viewerLat * DEG_TO_RAD)

  const dx_east  = (lng - viewerLng) * 111_320 * cosLat
  const dy_north = (lat - viewerLat) * 111_132

  const horizDist = Math.sqrt(dx_east * dx_east + dy_north * dy_north)
  if (horizDist < 10) return null

  // Bearing in degrees (0=N, 90=E)
  const bearingDeg = ((Math.atan2(dx_east, dy_north) * 180 / Math.PI) + 360) % 360

  // Earth curvature + refraction correction — same formula as ray march
  const curvDrop     = (horizDist * horizDist) / (2 * EARTH_R) * (1 - REFRACTION_K)
  const corrElev     = elev - curvDrop
  const dz_up        = corrElev - viewerElev
  const elevAngleRad = Math.atan2(dz_up, horizDist)

  return { bearingDeg, elevAngleRad, horizDist }
}

/**
 * Project a world-space point into first-person screen space.
 * Uses worldToBearingElev → project() pipeline (single camera).
 */
function projectFirstPerson(
  lat: number, lng: number, elev: number,
  viewerLat: number, viewerLng: number, viewerElev: number,
  cam: CameraParams,
): { screenX: number; screenY: number; horizDist: number } | null {
  const world = worldToBearingElev(lat, lng, elev, viewerLat, viewerLng, viewerElev)
  if (!world) return null

  const { x, y } = project(world.bearingDeg, world.elevAngleRad, cam)
  return { screenX: x, screenY: y, horizDist: world.horizDist }
}


// ─── Peak Visibility Check ────────────────────────────────────────────────────

/** Distance threshold for "near" peaks — shown if they have line-of-sight
 *  regardless of whether they poke above the skyline. */
const ALWAYS_SHOW_PEAK_DIST = 15_000  // 15 km — always label peaks this close

/**
 * Two-tier peak visibility:
 *  1. Close peaks (< 15 km): ALWAYS visible — you'd see the name on a trail
 *     sign, so always label them regardless of terrain occlusion.
 *  2. Far peaks (≥ 15 km): visible only if line-of-sight is clear — peak angle
 *     must be above the ridgeline of every closer band (true occlusion check).
 *
 * FOV check uses the full horizontal FOV so peaks anywhere in-frame appear.
 */
function isPeakVisible(
  peak: Peak,
  viewerLat: number, viewerLng: number, viewerElev: number,
  heading_deg: number, hfov: number,
  skyline: SkylineData,
  projected: ProjectedBands | null,
): boolean {
  const cosLat = Math.cos(viewerLat * DEG_TO_RAD)
  const dx = (peak.lng - viewerLng) * 111_320 * cosLat
  const dy = (peak.lat - viewerLat) * 111_132
  const dist = Math.sqrt(dx * dx + dy * dy)

  if (dist > MAX_PEAK_DIST || dist < 100) return false

  // Bearing from viewer to peak
  const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360

  // Full-FOV check — show peaks anywhere in the camera frustum
  let angleDiff = bearing - heading_deg
  if (angleDiff > 180) angleDiff -= 360
  if (angleDiff < -180) angleDiff += 360
  if (Math.abs(angleDiff) > hfov * 0.5) return false

  // Tier 1: close peaks — always visible, no occlusion check
  if (dist <= ALWAYS_SHOW_PEAK_DIST) return true

  // Earth curvature correction
  const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
  const peakAngle = Math.atan2(peak.elevation_m - curvDrop - viewerElev, dist)

  // Ridgeline angle — uses re-projected angles (AGL-aware)
  const ridgeAngle = skylineAngleAt(skyline, bearing, projected)
  const tolerance = 0.15 * DEG_TO_RAD

  // Tier 2: skyline peak — above the overall ridgeline
  if (peakAngle >= ridgeAngle - tolerance) return true

  // Tier 3: line-of-sight check — peak is below the overall ridgeline,
  // but check if ALL closer bands actually occlude it. If any closer band's
  // ridgeline is above the peak angle, it's occluded.
  let occluded = false
  for (let bi = 0; bi < skyline.bands.length; bi++) {
    const bandCfg = DEPTH_BANDS[bi]
    if (!bandCfg || bandCfg.minDist >= dist) continue  // band is farther than peak
    const bandAngle = bandAngleAt(skyline, bi, bearing, projected)
    if (bandAngle > -Math.PI / 2 + 0.001 && peakAngle < bandAngle - tolerance) {
      occluded = true
      break
    }
  }
  return !occluded
}

// ─── Quick Render (SkylineData) ───────────────────────────────────────────────

/**
 * Look up the ridgeline elevation angle for a given bearing.
 * Uses re-projected overall angles when available (AGL-aware), falls back to
 * worker-baked angles.  Linearly interpolates between adjacent azimuth samples
 * to eliminate stair-stepping artifacts.
 */
function skylineAngleAt(
  skyline: SkylineData,
  bearingDeg: number,
  projected: ProjectedBands | null = null,
): number {
  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * skyline.resolution
  const idx0 = Math.floor(fracIdx) % skyline.numAzimuths
  const idx1 = (idx0 + 1) % skyline.numAzimuths
  const t = fracIdx - Math.floor(fracIdx)

  const arr = projected ? projected.overallAngles : skyline.angles
  return arr[idx0] * (1 - t) + arr[idx1] * t
}

/**
 * Look up the per-band elevation angle for a given bearing and band index.
 * Uses the band's own resolution (high-res near bands have finer azimuth spacing).
 * Linearly interpolates between adjacent azimuth samples for smooth ridgelines.
 * Returns -PI/2 if no ridge in this band at this azimuth.
 */
function bandAngleAt(
  skyline: SkylineData,
  bandIndex: number,
  bearingDeg: number,
  projected: ProjectedBands | null,
): number {
  const band = skyline.bands[bandIndex]
  const bandRes = band.resolution
  const bandAz  = band.numAzimuths

  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * bandRes
  const idx0 = Math.floor(fracIdx) % bandAz
  const idx1 = (idx0 + 1) % bandAz
  const t = fracIdx - Math.floor(fracIdx)

  const SENTINEL = -Math.PI / 2 + 0.001

  if (projected) {
    const arr = projected.bandAngles[bandIndex]
    const a0 = arr[idx0], a1 = arr[idx1]
    if (a0 <= SENTINEL && a1 <= SENTINEL) return -Math.PI / 2
    if (a0 <= SENTINEL) return a1
    if (a1 <= SENTINEL) return a0
    return a0 * (1 - t) + a1 * t
  }

  // Fallback: compute from raw data with interpolation
  if ((band.elevations[idx0] === -Infinity || band.elevations[idx0] <= 0) &&
      (band.elevations[idx1] === -Infinity || band.elevations[idx1] <= 0)) return -Math.PI / 2

  const computeAngle = (idx: number) => {
    if (band.elevations[idx] === -Infinity || band.elevations[idx] <= 0) return -Math.PI / 2
    const dist = band.distances[idx]
    const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
    return Math.atan2(band.elevations[idx] - curvDrop - skyline.computedAt.elev, dist)
  }

  const a0 = computeAngle(idx0), a1 = computeAngle(idx1)
  if (a0 <= SENTINEL && a1 <= SENTINEL) return -Math.PI / 2
  if (a0 <= SENTINEL) return a1
  if (a1 <= SENTINEL) return a0
  return a0 * (1 - t) + a1 * t
}

/** Interpolated raw elevation at a fractional bearing for a given band. */
function bandElevAt(
  skyline: SkylineData,
  bandIndex: number,
  bearingDeg: number,
): number {
  const band = skyline.bands[bandIndex]
  const bandRes = band.resolution
  const bandAz  = band.numAzimuths

  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * bandRes
  const idx0 = Math.floor(fracIdx) % bandAz
  const idx1 = (idx0 + 1) % bandAz
  const t = fracIdx - Math.floor(fracIdx)

  const e0 = band.elevations[idx0]
  const e1 = band.elevations[idx1]
  if (e0 === -Infinity && e1 === -Infinity) return -Infinity
  if (e0 === -Infinity) return e1
  if (e1 === -Infinity) return e0
  return e0 * (1 - t) + e1 * t
}

/** Interpolated distance at a fractional bearing for a given band. */
function bandDistAt(
  skyline: SkylineData,
  bandIndex: number,
  bearingDeg: number,
): number {
  const band = skyline.bands[bandIndex]
  const bandRes = band.resolution
  const bandAz  = band.numAzimuths

  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * bandRes
  const idx0 = Math.floor(fracIdx) % bandAz
  const idx1 = (idx0 + 1) % bandAz
  const t = fracIdx - Math.floor(fracIdx)

  const d0 = band.distances[idx0]
  const d1 = band.distances[idx1]
  // If either sample has no ridge (-Infinity elevation), return the other
  if (band.elevations[idx0] === -Infinity && band.elevations[idx1] === -Infinity) return 0
  if (band.elevations[idx0] === -Infinity) return d1
  if (band.elevations[idx1] === -Infinity) return d0
  return d0 * (1 - t) + d1 * t
}

/** Interpolated GPS coords of the ridgeline point at a fractional bearing for a given band.
 *  Returns null if no ridge at this azimuth. */
function bandGpsAt(
  skyline: SkylineData,
  bandIndex: number,
  bearingDeg: number,
): { lat: number; lng: number } | null {
  const band = skyline.bands[bandIndex]
  const bandRes = band.resolution
  const bandAz  = band.numAzimuths

  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * bandRes
  const idx0 = Math.floor(fracIdx) % bandAz
  const idx1 = (idx0 + 1) % bandAz
  const t = fracIdx - Math.floor(fracIdx)

  if (band.elevations[idx0] === -Infinity && band.elevations[idx1] === -Infinity) return null
  if (band.elevations[idx0] === -Infinity) return { lat: band.ridgeLats[idx1], lng: band.ridgeLngs[idx1] }
  if (band.elevations[idx1] === -Infinity) return { lat: band.ridgeLats[idx0], lng: band.ridgeLngs[idx0] }

  return {
    lat: band.ridgeLats[idx0] * (1 - t) + band.ridgeLats[idx1] * t,
    lng: band.ridgeLngs[idx0] * (1 - t) + band.ridgeLngs[idx1] * t,
  }
}

/** GPS proximity radius (metres) per depth band — peaks must own the ridgeline within this radius.
 *  Near terrain has tight radius (ridge points are close together),
 *  far terrain needs wider radius (ridge points are spread far apart). */
const BAND_GPS_RADIUS: number[] = [
  500,     // ultra-near: 0.5 km
  2_000,   // near:       2 km
  5_000,   // mid-near:   5 km
  10_000,  // mid:        10 km
  10_000,  // mid-far:    10 km
  15_000,  // far:        15 km
]

// ─── Elevation → Palette Color ────────────────────────────────────────────────
//
// Maps a normalized elevation (0–1) through the ocean-depth palette stops.
// Low ridgelines = abyss (dark), high peaks = reef (bright).
// Palette: abyss → deep → navy → ocean → mid → reef

const RIDGE_PALETTE: [number, number, number][] = [
  [14,  57,  81],   // abyss  #0E3951  t=0.0
  [18,  75, 107],   // deep   #124B6B  t=0.2
  [33,  92, 121],   // navy   #215C79  t=0.4
  [47, 109, 135],   // ocean  #2F6D87  t=0.6
  [75, 142, 163],   // mid    #4B8EA3  t=0.8
  [104, 176, 191],  // reef   #68B0BF  t=1.0
]

function elevToRidgeColor(tElev: number): string {
  const t = Math.max(0, Math.min(1, tElev))
  const maxIdx = RIDGE_PALETTE.length - 1
  const scaled = t * maxIdx
  const i0 = Math.floor(scaled)
  const i1 = Math.min(i0 + 1, maxIdx)
  const frac = scaled - i0
  const [r0, g0, b0] = RIDGE_PALETTE[i0]
  const [r1, g1, b1] = RIDGE_PALETTE[i1]
  const r = Math.round(r0 + (r1 - r0) * frac)
  const g = Math.round(g0 + (g1 - g0) * frac)
  const b = Math.round(b0 + (b1 - b0) * frac)
  return `rgb(${r},${g},${b})`
}

// ─── Depth Band Visual Parameters ─────────────────────────────────────────────
//
// Driven by band index as a fraction of total bands.  Adding bands later means
// these interpolate automatically — no hardcoded per-band style blocks.

interface BandStyle {
  fillColor:      string   // Terrain fill below ridgeline
  strokeColor:    string   // Ridgeline stroke RGBA (fallback)
  lineWidthNear:  number   // Ridgeline thickness at band's near edge (px)
  lineWidthFar:   number   // Ridgeline thickness at band's far edge (px)
}

/** Per-band line widths: edges match at boundaries so adjacent bands are seamless.
 *  ultra-near 5→4.5, near 4.5→3.5, mid-near 3.5→3, mid 3→2.5, mid-far 2.5→2, far 2→1.
 *  Thinner lines let elevation color and terrain shape show through. */
const BAND_LINE_WIDTHS: [number, number][] = [
  [5, 4.5],  // ultra-near: 5px at 0km → 4.5px at 4.5km
  [4.5, 3.5],// near:       4.5px at 4km → 3.5px at 10.5km
  [3.5, 3],  // mid-near:   3.5px at 10km → 3px at 31km
  [3, 2.5],  // mid:        3px at 30km → 2.5px at 81km
  [2.5, 2],  // mid-far:    2.5px at 80km → 2px at 152km
  [2, 1],    // far:        2px at 150km → 1px at 400km
]

function bandStyleForIndex(bandIndex: number, bandCount: number, darkMode: boolean = true): BandStyle {
  // t = 0 (far) → 1 (near)
  const t = bandCount <= 1 ? 1 : 1 - bandIndex / (bandCount - 1)

  // Dark mode fill: must be CLEARLY darker than the sky gradient
  // (sky = rgb(0,8,16) at top → rgb(15,44,66) at horizon).
  // Near bands = darkest (solid ground), far bands = slightly brighter (atmospheric).
  // These sit ON TOP of silhouette fills, providing band-level depth cues.
  const FILL_COLORS_DARK: [number, number, number][] = [
    [1,   6,  10],   // ultra-near — deep void, clearly darker than sky
    [2,  10,  18],   // near — barely brighter
    [4,  18,  30],   // mid-near
    [6,  28,  44],   // mid
    [10, 38,  58],   // mid-far
    [14, 50,  72],   // far — still darker than sky at horizon
  ]
  const FILL_COLORS_LIGHT: [number, number, number][] = [
    [85, 100, 80],   // ultra-near — deep olive green
    [110, 125, 100],  // near
    [140, 150, 125],  // mid-near
    [165, 175, 150],  // mid
    [190, 195, 175],  // mid-far
    [210, 215, 195],  // far — pale sage
  ]
  const FILL_COLORS = darkMode ? FILL_COLORS_DARK : FILL_COLORS_LIGHT
  const bandIdx = bandCount <= 1 ? 0 : Math.round((1 - t) * (FILL_COLORS.length - 1))
  const [fillR, fillG, fillB] = FILL_COLORS[Math.min(bandIdx, FILL_COLORS.length - 1)]
  const fillColor = `rgb(${fillR},${fillG},${fillB})`

  const strokeColor = darkMode
    ? `rgba(132, 209, 219, ${(0.15 + t * 0.65).toFixed(2)})`
    : `rgba(40, 60, 50, ${(0.20 + t * 0.55).toFixed(2)})`

  const widths = BAND_LINE_WIDTHS[bandIndex] || [1 + t * 4, 1 + t * 4]

  return { fillColor, strokeColor, lineWidthNear: widths[0], lineWidthFar: widths[1] }
}

// ─── Per-Band Contour Renderer ───────────────────────────────────────────────
//
// Renders contour strands for a SINGLE band. Called between fill and stroke
// in the per-band painter's order loop. No cross-band occlusion needed because
// the next nearer band's fill will paint over any contours that should be hidden.
//
// Uses LOGARITHMIC distance scaling for line width:
//   tDist = log10(1 + dist_km) / log10(401)   // 0 at 0km, 1 at 400km
//   width = 0.5 + 4.5 * (1 - tDist)           // 5px near, 0.5px far
//
// The log scale distributes width variation evenly across the full range,
// unlike the old power curve (0.2 exponent) which compressed 90% of variation
// into the first 10km and was essentially flat from 10-400km.

/** Per-band opacity for contour lines (near=vivid, far=faint).
 *  Index matches DEPTH_BANDS: [ultra-near, near, mid-near, mid, mid-far, far]. */
const CONTOUR_OPACITIES = [0.65, 0.55, 0.45, 0.35, 0.25, 0.15]

function renderBandContours(
  ctx: CanvasRenderingContext2D,
  strands: PrebuiltContourStrand[],
  cam: CameraParams,
  globalElevMin: number,
  globalElevMax: number,
  silhouetteLayers: SilhouetteLayer[][] | null,
  silResolution: number,
  darkMode: boolean = true,
): void {
  const { W, H } = cam
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1

  // ── Silhouette occlusion setup ──────────────────────────────────────────
  // For each contour point we check ALL silhouette layers at that azimuth
  // that are CLOSER than the contour. If any closer surface's peakY is
  // above (lower Y) the contour's screen Y, the contour is occluded.
  // This handles intermediate surfaces correctly — a contour at 20km behind
  // a silhouette at 10km is culled even though the nearest surface at 3km
  // is below it on screen.
  const hasSilOcclusion = !!(silhouetteLayers && silResolution > 0)
  const numSilAz = hasSilOcclusion ? silResolution * 360 : 0
  const OCCLUSION_TOLERANCE_PX = 2  // Cull contours within 2px of ridgeline edge

  // Logarithmic distance → line width mapping (replaces old 0.2 power curve).
  // log10(1 + d_km) / log10(401) maps 0–400km to 0–1 with even distribution.
  const LOG_DENOM = Math.log10(401)

  // Width change threshold: flush path when width differs by >20%
  const WIDTH_FLUSH_RATIO = 0.2

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const strand of strands) {
    if (strand.points.length < 2) continue

    const bi = strand.bandIdx
    const opacity = CONTOUR_OPACITIES[bi] ?? 0.15

    // Elevation-based color through the palette
    const tElev = hasElevRange
      ? Math.max(0, Math.min(1, (strand.level - globalElevMin) / elevRange))
      : 0.5
    const baseColor = elevToRidgeColor(tElev)
    const rgbMatch = baseColor.match(/\d+/g)
    if (!rgbMatch) continue

    // In light mode, darken contour lines for visibility on light backgrounds
    if (darkMode) {
      ctx.strokeStyle = `rgba(${rgbMatch[0]},${rgbMatch[1]},${rgbMatch[2]},${opacity})`
    } else {
      // Darken the RGB values for light mode visibility
      const dr = Math.max(0, Math.round(parseInt(rgbMatch[0]) * 0.5))
      const dg = Math.max(0, Math.round(parseInt(rgbMatch[1]) * 0.5))
      const db = Math.max(0, Math.round(parseInt(rgbMatch[2]) * 0.5))
      ctx.strokeStyle = `rgba(${dr},${dg},${db},${opacity + 0.15})`
    }

    // Draw as continuous path, flushing only on significant width change
    let pathStarted = false
    let currentWidth = 0

    for (let i = 0; i < strand.points.length; i++) {
      const pt = strand.points[i]

      // Project the contour point to screen coordinates FIRST
      const { x, y } = project(pt.bearingDeg, pt.elevAngleRad, cam)
      const onScreen = x >= -10 && x <= W + 10 && y >= 0 && y < H

      if (!onScreen) {
        if (pathStarted) { ctx.stroke(); pathStarted = false }
        continue
      }

      // ── Silhouette occlusion check (multi-layer screen-Y) ──────────────
      // Check ALL silhouette layers at this bearing that are CLOSER than
      // the contour point. If ANY closer surface has a peakY above (<=)
      // the contour's screen Y, the contour is behind that surface.
      // Layers are sorted near→far, so we iterate until dist >= pt.dist.
      if (hasSilOcclusion && silhouetteLayers) {
        const normBearing = ((pt.bearingDeg % 360) + 360) % 360
        const ai = Math.round(normBearing * silResolution) % numSilAz
        const azLayers = silhouetteLayers[ai]
        let occluded = false
        if (azLayers) {
          for (let li = 0; li < azLayers.length; li++) {
            const layer = azLayers[li]
            if (layer.isOcean) continue
            // Only check surfaces CLOSER than this contour point
            if (layer.dist >= pt.dist) break  // layers sorted near→far, done
            // Project this closer surface's peak to screen Y
            const silPeak = project(pt.bearingDeg, layer.peakAngle, cam)
            if (y >= silPeak.y - OCCLUSION_TOLERANCE_PX) {
              // Contour point is at or below a closer surface's ridgeline
              occluded = true
              break
            }
          }
        }
        if (occluded) {
          if (pathStarted) { ctx.stroke(); pathStarted = false }
          continue
        }
      }

      // Logarithmic width: distributes variation evenly across 0–400km
      // instead of compressing 90% into the first 10km (old power curve)
      const tDist = Math.log10(1 + pt.dist / 1000) / LOG_DENOM
      const lw = 0.5 + 4.5 * (1 - tDist)

      if (!pathStarted) {
        ctx.lineWidth = lw
        currentWidth = lw
        ctx.beginPath()
        ctx.moveTo(x, y)
        pathStarted = true
      } else if (Math.abs(lw - currentWidth) > currentWidth * WIDTH_FLUSH_RATIO) {
        // Width changed significantly — flush and restart from same point
        ctx.lineTo(x, y)
        ctx.stroke()
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

/**
 * Layered terrain renderer — draws depth bands in painter's order (far→near).
 *
 * NEW RENDERING ORDER (per-band):
 *   1. Band fill (solid color below ridgeline)
 *   2. Contour lines for this band (sit ON TOP of own fill, BELOW next nearer fill)
 *   3. Ridgeline stroke (colored line at the top edge of the band)
 *
 * This order means contours are naturally occluded by nearer bands' fills,
 * eliminating the need for explicit cross-band occlusion checks. Each band's
 * visual elements are drawn together — philosophically cleaner and the contour
 * lines naturally meet the ridgeline at the top edge.
 *
 * @param contourStrands - Pre-built contour strands to render per-band (between fill and stroke)
 * @param darkMode - Whether dark mode is active (affects colors)
 */
function renderTerrain(
  ctx: CanvasRenderingContext2D,
  skyline: SkylineData,
  cam: CameraParams,
  projected: ProjectedBands | null,
  showBandLines: boolean = true,
  showFill: boolean = true,
  contourStrands: PrebuiltContourStrand[] = [],
  showContourLines: boolean = true,
  darkMode: boolean = true,
  silhouetteLayers: SilhouetteLayer[][] | null = null,
  silResolution: number = 0,
  silElevMin: number = 0,
  silElevMax: number = 0,
): void {
  const { W, H } = cam
  const numBands = skyline.bands.length

  // ── Global elevation range for color normalization ───────────────────────
  let globalElevMin = Infinity
  let globalElevMax = -Infinity
  for (let bi = 0; bi < numBands; bi++) {
    const elev = skyline.bands[bi].elevations
    for (let i = 0; i < elev.length; i++) {
      if (elev[i] === -Infinity || elev[i] <= 0) continue
      if (elev[i] < globalElevMin) globalElevMin = elev[i]
      if (elev[i] > globalElevMax) globalElevMax = elev[i]
    }
  }
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1  // Avoid division by zero

  // Per-band segment size: near bands update color/width frequently,
  // far bands use long segments to avoid dotty appearance from stroke gaps
  const SEGMENT_SIZES = [3, 4, 6, 12, 24, 48]  // ultra-near → far

  // Silhouette pre-bucketing removed — with unified flat terrain fill,
  // band fill polygons provide full coverage. Silhouette layer fills are
  // no longer needed (were the largest per-frame cost).

  // Draw bands far→near (painter's order: far gets painted first, near overlaps)
  // Reverse iteration: DEPTH_BANDS[0]=near, [1]=mid, [2]=far → draw [2],[1],[0]
  for (let bi = numBands - 1; bi >= 0; bi--) {
    const style = bandStyleForIndex(bi, numBands, darkMode)
    const bandCfg = DEPTH_BANDS[bi]
    const segSize = SEGMENT_SIZES[bi] ?? 24

    // Line width interpolation helper
    const lwMin = bandCfg ? bandCfg.minDist : 0
    const lwMax = bandCfg ? bandCfg.maxDist : 1
    const lwRange = lwMax - lwMin

    // ── Fill below this band's ridgeline ───────────────────────────────────
    ctx.beginPath()
    ctx.moveTo(0, H)
    let hasVisiblePixels = false

    for (let col = 0; col < W; col++) {
      const bearingDeg = cam.heading_deg + (col / W - 0.5) * cam.hfov
      const angle = bandAngleAt(skyline, bi, bearingDeg, projected)

      // Skip columns where this band has no data (sentinel -PI/2)
      if (angle <= -Math.PI / 2 + 0.001) {
        ctx.lineTo(col, H)
        continue
      }

      hasVisiblePixels = true
      const { y } = project(bearingDeg, angle, cam)
      const screenY = Math.round(y)
      ctx.lineTo(col, Math.min(H, Math.max(0, screenY)))
    }

    ctx.lineTo(W, H)
    ctx.closePath()
    // Band fill: always draw as base coat (unified terrain color).
    // Covers sky completely from ridgeline to canvas bottom.
    // Silhouette layer fills draw on top but are no longer needed for coverage.
    if (hasVisiblePixels && showFill) {
      ctx.fillStyle = darkMode ? TERRAIN_FILL_DARK : TERRAIN_FILL_LIGHT
      ctx.fill()
    }

    // ── Silhouette fills REMOVED ──────────────────────────────────────────
    // With unified terrain fill, the band fill polygon above provides full
    // coverage from ridgeline to canvas bottom. Per-column silhouette fillRects
    // are redundant (same flat color on same flat color) and were the largest
    // per-frame cost (W × layers project() calls + fillRects). Removed entirely.

    // ── Contour lines for THIS band (drawn between fill and stroke) ─────
    // Contours sit on top of their own band's silhouette fill but below the
    // next nearer band's silhouette fill. Painter's order handles occlusion
    // automatically — nearer band fills cover farther contours.
    if (hasVisiblePixels && showContourLines && contourStrands.length > 0) {
      // Filter strands belonging to this band
      const bandStrands = contourStrands.filter(s => s.bandIdx === bi)
      if (bandStrands.length > 0) {
        renderBandContours(ctx, bandStrands, cam, globalElevMin, globalElevMax,
          silhouetteLayers, silResolution, darkMode)
      }
    }

    // ── Ridgeline stroke — subsampled quadratic curves with curvature tapering ─
    // Subsample every 3 pixels, connect with quadraticCurveTo for smooth
    // flowing curves. Break path on screen-Y jumps >40px (different ridgeline).
    // Line width driven by curvature: sharp peaks = thick, flat = nearly invisible.
    if (hasVisiblePixels && showBandLines) {
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      const SUBSAMPLE = 3
      const BAND_CURV_THRESHOLD = 0.003
      // Per-band max width: near bands thicker than far
      const bandMaxWidth = style.lineWidthNear
      const bandMinWidth = 0.1

      interface RidgePt { col: number; y: number; elev: number; dist: number; curvature: number; angle: number }
      const pts: RidgePt[] = []

      // Collect subsampled points
      for (let col = 0; col < W; col += SUBSAMPLE) {
        const bearingDeg = cam.heading_deg + (col / W - 0.5) * cam.hfov
        const angle = bandAngleAt(skyline, bi, bearingDeg, projected)
        if (angle <= -Math.PI / 2 + 0.001) {
          pts.push({ col, y: -9999, elev: 0, dist: 0, curvature: 0, angle: 0 })
          continue
        }
        const { y } = project(bearingDeg, angle, cam)
        if (y >= H) {
          pts.push({ col, y: -9999, elev: 0, dist: 0, curvature: 0, angle: 0 })
          continue
        }
        const clampedY = Math.max(0, y)
        const elev = bandElevAt(skyline, bi, bearingDeg)
        const dist = bandDistAt(skyline, bi, bearingDeg)
        pts.push({ col, y: clampedY, elev, dist, curvature: 0, angle })
      }

      // Compute curvature (second derivative of angle) per valid point
      for (let i = 1; i < pts.length - 1; i++) {
        if (pts[i].y > -9000 && pts[i - 1].y > -9000 && pts[i + 1].y > -9000) {
          pts[i].curvature = Math.abs(pts[i + 1].angle - 2 * pts[i].angle + pts[i - 1].angle)
        }
      }

      // Draw runs of valid points as smooth curves
      let runStart = -1
      for (let i = 0; i <= pts.length; i++) {
        const invalid = i >= pts.length || pts[i].y < -9000
        const jumpBreak = !invalid && runStart >= 0 && i > runStart &&
          Math.abs(pts[i].y - pts[i - 1].y) > 40

        if (invalid || jumpBreak) {
          if (runStart >= 0 && i - runStart >= 2) {
            const runEnd = i
            // Initial color from first point
            const firstPt = pts[runStart]
            const tElev0 = hasElevRange && firstPt.elev > -Infinity
              ? (firstPt.elev - globalElevMin) / elevRange : 0.5
            const tCurv0 = Math.min(1, firstPt.curvature / BAND_CURV_THRESHOLD)
            ctx.lineWidth = bandMinWidth + (bandMaxWidth - bandMinWidth) * (0.2 + 0.8 * tCurv0)
            ctx.strokeStyle = elevToRidgeColor(tElev0)
            ctx.beginPath()
            ctx.moveTo(firstPt.col, firstPt.y)

            for (let j = runStart + 1; j < runEnd; j++) {
              const prev = pts[j - 1]
              const curr = pts[j]
              // Update color/width at segment boundaries
              if ((j - runStart) % segSize === 0 && j + 1 < runEnd) {
                ctx.stroke()
                const tE = hasElevRange && curr.elev > -Infinity
                  ? (curr.elev - globalElevMin) / elevRange : 0.5
                const tC = Math.min(1, curr.curvature / BAND_CURV_THRESHOLD)
                ctx.lineWidth = bandMinWidth + (bandMaxWidth - bandMinWidth) * (0.2 + 0.8 * tC)
                ctx.strokeStyle = elevToRidgeColor(tE)
                ctx.beginPath()
                ctx.moveTo(prev.col, prev.y)
              }
              if (j + 1 < runEnd) {
                const next = pts[j + 1]
                const midX = (curr.col + next.col) / 2
                const midY = (curr.y + next.y) / 2
                ctx.quadraticCurveTo(curr.col, curr.y, midX, midY)
              } else {
                ctx.lineTo(curr.col, curr.y)
              }
            }
            ctx.stroke()
          }
          runStart = jumpBreak ? i : -1
          if (jumpBreak) continue
        }

        if (!invalid && runStart < 0) {
          runStart = i
        }
      }
    }
  }
}

// ─── Contour Line Renderer ────────────────────────────────────────────────────

// NOTE: Old renderContours() removed — contour rendering is now integrated into
// renderTerrain() via renderBandContours(). This gives the correct painter's order:
//   fill → contours → stroke (per band, far to near)
// The explicit cross-band occlusion check was eliminated because nearer band fills
// naturally paint over farther contours. The contour line width now uses a logarithmic
// distance scale instead of the old 0.2-power curve (see renderBandContours).

// ─── Peak Ridgeline Profiles ──────────────────────────────────────────────────
//
// For each visible peak, draw the ridgeline from the single depth band that
// contains the peak's distance.  A GPS proximity check per azimuth ensures the
// highlight only covers azimuths where the peak actually owns the ridgeline
// (i.e. the ridge point is close to the peak, not some unrelated terrain).
// Proximity radius varies by band: near ~1km, mid ~10km, far ~15km.
// Alpha fades smoothly to transparent at the arc edges for a natural appearance.

/** Angular half-width of the peak ridgeline arc (degrees). */
const PEAK_ARC_HALF_FAR  = 5    // ±5° for peaks ≥ 10 km
const PEAK_ARC_HALF_NEAR = 10   // ±10° for peaks < 10 km (linearly interpolated)
const PEAK_ARC_NEAR_DIST = 10_000  // Distance (m) below which arc widens

/** Bearing step size for sampling the ridgeline within the arc (degrees). */
const PEAK_ARC_STEP = 0.25

/** Flat-earth distance² between two GPS points (metres²). Fast approximation valid within ~300km. */
function gpsDistSq(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dy = (lat2 - lat1) * 111_132
  const cosLat = Math.cos(lat1 * Math.PI / 180)
  const dx = (lng2 - lng1) * 111_320 * cosLat
  return dx * dx + dy * dy
}

function renderPeakRidgelines(
  ctx: CanvasRenderingContext2D,
  skyline: SkylineData,
  projected: ProjectedBands | null,
  peakPositions: PeakScreenPos[],
  cam: CameraParams,
  projectedArcs: ProjectedRefinedArc[] | null,
): void {
  const { W, H } = cam
  const numBands = skyline.bands.length

  // Global elevation range for color normalization (same as renderTerrain)
  let globalElevMin = Infinity
  let globalElevMax = -Infinity
  for (let bi = 0; bi < numBands; bi++) {
    const elev = skyline.bands[bi].elevations
    for (let i = 0; i < elev.length; i++) {
      if (elev[i] === -Infinity || elev[i] <= 0) continue
      if (elev[i] < globalElevMin) globalElevMin = elev[i]
      if (elev[i] > globalElevMax) globalElevMax = elev[i]
    }
  }
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const pos of peakPositions) {
    const peakBearing = pos.bearing
    const peakDist_m  = pos.dist_km * 1000

    // Find the single band whose distance range contains this peak.
    // If the peak falls in an overlap zone, pick the higher-resolution (lower index) band.
    let bestBand = -1
    for (let bi = 0; bi < numBands; bi++) {
      const cfg = DEPTH_BANDS[bi]
      if (cfg && peakDist_m >= cfg.minDist && peakDist_m <= cfg.maxDist) {
        bestBand = bi
        break
      }
    }
    if (bestBand < 0) continue  // Peak outside all band ranges

    const gpsRadius_m = BAND_GPS_RADIUS[bestBand] ?? 10_000
    const gpsRadiusSq = gpsRadius_m * gpsRadius_m

    // Determine arc half-width: wider for nearby peaks, narrower for far
    const distT = Math.max(0, Math.min(1, peakDist_m / PEAK_ARC_NEAR_DIST))
    const arcHalf = PEAK_ARC_HALF_NEAR + distT * (PEAK_ARC_HALF_FAR - PEAK_ARC_HALF_NEAR)

    // Inherit band's distance-based line width + small boost so it stands out
    const lw = BAND_LINE_WIDTHS[bestBand] ?? BAND_LINE_WIDTHS[BAND_LINE_WIDTHS.length - 1]
    const bandCfg = DEPTH_BANDS[bestBand]
    const lwMin = bandCfg?.minDist ?? 0
    const lwMax = bandCfg?.maxDist ?? MAX_DIST
    const lwRange = lwMax - lwMin
    const lwT = lwRange > 0 ? Math.max(0, Math.min(1, (peakDist_m - lwMin) / lwRange)) : 0
    const bandLineWidth = lw[0] + lwT * (lw[1] - lw[0])
    const lineWidth = bandLineWidth + 1  // slight boost over band line
    const baseAlpha = 0.75
    ctx.lineWidth = lineWidth

    // ── Try refined arc first (5× denser sampling around detected features) ──
    // Find a refined arc whose bearing range covers this peak's bearing.
    // The arc must also be in the same band as the peak for correct depth matching.
    let matchedArc: ProjectedRefinedArc | null = null
    if (projectedArcs) {
      for (const pa of projectedArcs) {
        if (pa.arc.bandIndex !== bestBand) continue
        let dBearing = peakBearing - pa.arc.centerBearing
        if (dBearing > 180) dBearing -= 360
        if (dBearing < -180) dBearing += 360
        if (Math.abs(dBearing) <= pa.arc.halfWidth) {
          matchedArc = pa
          break
        }
      }
    }

    if (matchedArc) {
      // ── Render using refined arc data (high-res path) ─────────────────────
      // Walk the arc's dense samples, using pre-projected angles and raw GPS
      // for the proximity check.  Gives ~5× smoother ridgeline profile than
      // band data around peaks.
      const { arc, angles: arcAngles } = matchedArc
      const BATCH_SIZE = 8
      let segCount = 0
      let pathStarted = false

      for (let si = 0; si < arc.numSamples; si++) {
        const bearingOffset = -arc.halfWidth + si * arc.stepDeg
        const bearing = arc.centerBearing + bearingOffset

        // Only render within the peak's arc half-width (with edge fade)
        let dBearing = bearing - peakBearing
        if (dBearing > 180) dBearing -= 360
        if (dBearing < -180) dBearing += 360
        if (Math.abs(dBearing) > arcHalf) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        // GPS proximity check: does the peak own the ridgeline at this sample?
        if (arc.elevations[si] === -Infinity) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }
        const ridgeDistSq = gpsDistSq(pos.lat, pos.lng, arc.ridgeLats[si], arc.ridgeLngs[si])
        if (ridgeDistSq > gpsRadiusSq) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        const angle = arcAngles[si]
        if (angle <= -Math.PI / 2 + 0.001) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        const { x, y } = project(bearing, angle, cam)
        if (x < -50 || x > W + 50 || y < 0 || y > H) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        // Edge fade: alpha falls off smoothly toward arc edges (cosine curve)
        const edgeT = Math.abs(dBearing) / arcHalf  // 0 at center, 1 at edge
        const edgeFade = Math.cos(edgeT * Math.PI * 0.5) // 1 at center, 0 at edge
        const alpha = baseAlpha * edgeFade
        if (alpha < 0.01) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        if (!pathStarted) {
          const tElev = hasElevRange && arc.elevations[si] > -Infinity
            ? (arc.elevations[si] - globalElevMin) / elevRange : 0.5
          const color = elevToRidgeColor(tElev)
          const rgbMatch = color.match(/\d+/g)
          if (!rgbMatch) continue
          const r = parseInt(rgbMatch[0]), g = parseInt(rgbMatch[1]), b = parseInt(rgbMatch[2])
          const cr = Math.round(r + (255 - r) * 0.15)
          const cg = Math.round(g + (255 - g) * 0.15)
          const cb = Math.round(b + (255 - b) * 0.15)
          ctx.beginPath()
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`
          ctx.moveTo(x, y)
          pathStarted = true
          segCount = 0
        } else if (segCount >= BATCH_SIZE) {
          ctx.lineTo(x, y)
          ctx.stroke()
          const tElev = hasElevRange && arc.elevations[si] > -Infinity
            ? (arc.elevations[si] - globalElevMin) / elevRange : 0.5
          const color = elevToRidgeColor(tElev)
          const rgbMatch = color.match(/\d+/g)
          if (!rgbMatch) { pathStarted = false; segCount = 0; continue }
          const r = parseInt(rgbMatch[0]), g = parseInt(rgbMatch[1]), b = parseInt(rgbMatch[2])
          const cr = Math.round(r + (255 - r) * 0.15)
          const cg = Math.round(g + (255 - g) * 0.15)
          const cb = Math.round(b + (255 - b) * 0.15)
          ctx.beginPath()
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`
          ctx.moveTo(x, y)
          segCount = 0
        } else {
          ctx.lineTo(x, y)
          segCount++
        }
      }
      if (pathStarted) ctx.stroke()

    } else {
      // ── Fallback: render using band data (original path) ──────────────────
      const totalSteps = Math.ceil(arcHalf * 2 / PEAK_ARC_STEP)
      const BATCH_SIZE = 6
      let segCount = 0
      let pathStarted = false

      for (let s = 0; s <= totalSteps; s++) {
        const bearingOffset = -arcHalf + (s / (totalSteps || 1)) * arcHalf * 2
        const bearing = peakBearing + bearingOffset

        // GPS proximity check: does the peak own the ridgeline at this azimuth?
        const ridgeGps = bandGpsAt(skyline, bestBand, bearing)
        if (!ridgeGps || gpsDistSq(pos.lat, pos.lng, ridgeGps.lat, ridgeGps.lng) > gpsRadiusSq) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        const angle = bandAngleAt(skyline, bestBand, bearing, projected)
        if (angle <= -Math.PI / 2 + 0.001) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        const { x, y } = project(bearing, angle, cam)
        if (x < -50 || x > W + 50 || y < 0 || y > H) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        // Edge fade: alpha falls off smoothly toward arc edges (cosine curve)
        const edgeT = Math.abs(bearingOffset) / arcHalf  // 0 at center, 1 at edge
        const edgeFade = Math.cos(edgeT * Math.PI * 0.5) // 1 at center, 0 at edge
        const alpha = baseAlpha * edgeFade
        if (alpha < 0.01) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        if (!pathStarted) {
          const elev = bandElevAt(skyline, bestBand, bearing)
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange : 0.5
          const color = elevToRidgeColor(tElev)
          const rgbMatch = color.match(/\d+/g)
          if (!rgbMatch) continue
          const r = parseInt(rgbMatch[0]), g = parseInt(rgbMatch[1]), b = parseInt(rgbMatch[2])
          const cr = Math.round(r + (255 - r) * 0.15)
          const cg = Math.round(g + (255 - g) * 0.15)
          const cb = Math.round(b + (255 - b) * 0.15)

          ctx.beginPath()
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`
          ctx.moveTo(x, y)
          pathStarted = true
          segCount = 0
        } else if (segCount >= BATCH_SIZE) {
          ctx.lineTo(x, y)
          ctx.stroke()

          const elev = bandElevAt(skyline, bestBand, bearing)
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange : 0.5
          const color = elevToRidgeColor(tElev)
          const rgbMatch = color.match(/\d+/g)
          if (!rgbMatch) { pathStarted = false; segCount = 0; continue }
          const r = parseInt(rgbMatch[0]), g = parseInt(rgbMatch[1]), b = parseInt(rgbMatch[2])
          const cr = Math.round(r + (255 - r) * 0.15)
          const cg = Math.round(g + (255 - g) * 0.15)
          const cb = Math.round(b + (255 - b) * 0.15)

          ctx.beginPath()
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`
          ctx.moveTo(x, y)
          segCount = 0
        } else {
          ctx.lineTo(x, y)
          segCount++
        }
      }

      if (pathStarted) ctx.stroke()
    }
  }

  ctx.restore()
}

// ─── Full Canvas Draw ─────────────────────────────────────────────────────────

function drawScanCanvas(
  canvas: HTMLCanvasElement,
  peaks: Peak[],
  heading_deg: number,
  pitch_deg: number,
  eyeHeight_m: number,
  activeLat: number,
  activeLng: number,
  hfov: number,
  skylineData: SkylineData | null,
  projectedBands: ProjectedBands | null,
  contourStrands: PrebuiltContourStrand[],
  projectedArcs: ProjectedRefinedArc[] | null,
  silhouetteLayers: SilhouetteLayer[][] | null,
  projectedNearProfile: ProjectedNearProfile | null,
  showBandLines: boolean = true,
  showFill: boolean = true,
  showPeakLabels: boolean = true,
  showContourLines: boolean = true,
  showSilhouetteLines: boolean = true,
  darkMode: boolean = true,
): PeakScreenPos[] {
  const ctx = canvas.getContext('2d')
  if (!ctx) return []

  const W = canvas.width
  const H = canvas.height

  // Use the worker's z15-corrected ground elevation. Before skyline is ready,
  // we can't draw terrain anyway so groundElev = 0 is fine for initial frame.
  const groundElev = skylineData
    ? skylineData.computedAt.groundElev
    : 0
  const eyeElev    = groundElev + eyeHeight_m

  // Single camera params — shared by every projection call this frame
  const cam: CameraParams = { heading_deg, pitch_deg, hfov, W, H }
  const horizonY = getHorizonY(cam)

  // ── 1. Sky gradient ─────────────────────────────────────────────────────────
  // Dark mode: deep ocean-void gradient. Light mode: daylight sky gradient.
  const skyGrad = ctx.createLinearGradient(0, 0, 0, H)
  if (darkMode) {
    skyGrad.addColorStop(0,    '#000810')
    skyGrad.addColorStop(0.20, '#020c18')
    skyGrad.addColorStop(0.50, '#051520')
    skyGrad.addColorStop(0.78, '#071a2a')
    skyGrad.addColorStop(0.90, '#0c2235')
    skyGrad.addColorStop(1.0,  '#0f2c42')
  } else {
    // Light mode: bright sky gradient (pale blue → warmer horizon)
    skyGrad.addColorStop(0,    '#87CEEB')
    skyGrad.addColorStop(0.30, '#A8D8EA')
    skyGrad.addColorStop(0.60, '#C5E3F0')
    skyGrad.addColorStop(0.85, '#DDE8EB')
    skyGrad.addColorStop(1.0,  '#E8EDE0')
  }
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, W, H)

  // Subtle star field (dark mode only)
  if (darkMode) {
    ctx.save()
    ctx.globalAlpha = 0.35
    const starRng = { seed: 42 }
    const rand = () => { starRng.seed = (starRng.seed * 16807 + 0) & 0x7fffffff; return starRng.seed / 0x7fffffff }
    const starLimit = Math.round(H * 0.45)
    for (let s = 0; s < 80; s++) {
      const sx = rand() * W
      const sy = rand() * starLimit
      const sr = rand() * 0.8 + 0.3
      ctx.fillStyle = `rgba(167, 221, 229, ${0.3 + rand() * 0.5})`
      ctx.beginPath()
      ctx.arc(sx, sy, sr, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  // ── 1b. Near-field occlusion — DISABLED ───────────────────────────────────
  // The running-max envelope approach creates flat-topped solid fills that
  // don't follow terrain contours — visible as a "black mountain" artifact.
  // Near-field profile data is still collected by the worker and available
  // in skylineData.nearProfile for future terrain-surface rendering.
  // Silhouette fills handle column-major occlusion instead.

  // ── 2. Terrain — unified depth-layered rendering (far→near painter's order) ─
  // Per band: silhouette fills → contours → band strokes.
  // Silhouette fills are interleaved with bands so nearer fills correctly
  // occlude farther contour lines. Band fills are disabled when silhouettes
  // are active — silhouettes replace them as the primary fill system.
  let silElevMin = 0, silElevMax = 0
  const silRes = skylineData?.silhouette?.resolution ?? 0
  if (silhouetteLayers && skylineData?.silhouette) {
    silElevMin = Infinity; silElevMax = -Infinity
    for (const azLayers of silhouetteLayers) {
      for (const layer of azLayers) {
        if (layer.rawElev > 0 && layer.rawElev < silElevMin) silElevMin = layer.rawElev
        if (layer.rawElev > silElevMax) silElevMax = layer.rawElev
      }
    }
  }

  if (skylineData) {
    renderTerrain(ctx, skylineData, cam, projectedBands, showBandLines, showFill,
      contourStrands, showContourLines, darkMode,
      silhouetteLayers, silRes, silElevMin, silElevMax)
  }

  // ── 2b. Silhouette glow + edge strokes ──────────────────────────────────
  // Glow renders first (behind), then crisp strokes on top.
  if (showSilhouetteLines && silhouetteLayers && skylineData?.silhouette) {
    const strands = matchSilhouetteStrands(
      silhouetteLayers,
      skylineData.silhouette.numAzimuths,
      skylineData.silhouette.resolution,
      cam,
    )
    renderSilhouetteGlow(ctx, strands, cam, silElevMin, silElevMax, silRes, darkMode)
    renderSilhouetteStrokes(ctx, silhouetteLayers, strands, cam, silElevMin, silElevMax,
      silRes, darkMode)
  }

  // ── 3. Horizon glow ──────────────────────────────────────────────────────────
  // Dark mode: teal glow. Light mode: subtle warm horizon haze.
  const glowGrad = ctx.createLinearGradient(0, horizonY - 12, 0, horizonY + 12)
  if (darkMode) {
    glowGrad.addColorStop(0,   'rgba(132, 209, 219, 0)')
    glowGrad.addColorStop(0.5, 'rgba(132, 209, 219, 0.22)')
    glowGrad.addColorStop(1,   'rgba(132, 209, 219, 0)')
  } else {
    glowGrad.addColorStop(0,   'rgba(100, 130, 160, 0)')
    glowGrad.addColorStop(0.5, 'rgba(100, 130, 160, 0.15)')
    glowGrad.addColorStop(1,   'rgba(100, 130, 160, 0)')
  }
  ctx.fillStyle = glowGrad
  ctx.fillRect(0, Math.round(horizonY - 12), W, 24)

  ctx.fillStyle = darkMode ? 'rgba(132, 209, 219, 0.18)' : 'rgba(80, 100, 120, 0.12)'
  ctx.fillRect(0, Math.round(horizonY), W, 1)

  // ── 4. Peak placement — all through project() ─────────────────────────────

  const peakPositions: PeakScreenPos[] = []

  const visiblePeaks = skylineData
    ? peaks.filter(p => isPeakVisible(p, activeLat, activeLng, eyeElev, heading_deg, hfov, skylineData, projectedBands))
    : peaks.filter(p => {
        const cosLat = Math.cos(activeLat * DEG_TO_RAD)
        const dx = (p.lng - activeLng) * 111_320 * cosLat
        const dy = (p.lat - activeLat) * 111_132
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist > MAX_PEAK_DIST || dist < 100) return false
        const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360
        let angleDiff = bearing - heading_deg
        if (angleDiff > 180) angleDiff -= 360
        if (angleDiff < -180) angleDiff += 360
        return Math.abs(angleDiff) <= hfov * 0.5
      })

  const topPeaks = visiblePeaks
    .sort((a, b) => b.elevation_m - a.elevation_m)
    .slice(0, 15)

  for (const peak of topPeaks) {
    const projected = projectFirstPerson(
      peak.lat, peak.lng, peak.elevation_m,
      activeLat, activeLng, eyeElev, cam,
    )
    if (!projected) continue

    let { screenX, screenY, horizDist } = projected
    if (screenX < -50 || screenX > W + 50) continue
    if (horizDist > MAX_PEAK_DIST) continue

    // Snap skyline peaks to the ridgeline so dots sit exactly on the drawn line.
    // Near-ground peaks (below ridge) keep their true projected position.
    if (skylineData) {
      const bearing = calculateBearing(
        { lat: activeLat, lng: activeLng },
        { lat: peak.lat, lng: peak.lng },
      )
      const curvDrop = (horizDist * horizDist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const peakAngle = Math.atan2(peak.elevation_m - curvDrop - eyeElev, horizDist)
      const ridgeAngle = skylineAngleAt(skylineData, bearing, projectedBands)

      // Only snap if peak is at/above the ridgeline (skyline peak)
      if (ridgeAngle > -Math.PI / 2 + 0.001 && peakAngle >= ridgeAngle - 0.003) {
        const ridgePos = project(bearing, ridgeAngle, cam)
        screenY = Math.min(screenY, ridgePos.y)
      }
    }

    peakPositions.push({
      id:          peak.id,
      name:        peak.name,
      nameEn:      peak.nameEn,
      elevation_m: peak.elevation_m,
      dist_km:     horizDist / 1000,
      bearing:     calculateBearing({ lat: activeLat, lng: activeLng }, { lat: peak.lat, lng: peak.lng }),
      lat:         peak.lat,
      lng:         peak.lng,
      screenX,
      screenY,
      stemHeight:  38,  // default, resolved below
    })
  }

  // ── 4b. Resolve peak label overlaps — staggered stem heights ────────────────
  // Sort by screenX so we can detect horizontal neighbors. Use rect-based
  // overlap detection: each label card is ~120×52 CSS-px, stem 38–76px, dot 8px.
  // When two labels would overlap, stagger the nearer peak's stem taller.
  // DPR conversion happens later (line ~1981), so work in physical pixels here
  // and use physical-pixel estimates for card sizes.
  const dprEst = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1
  const CARD_W  = 120 * dprEst   // approximate card width in physical px
  const CARD_H  = 52 * dprEst    // approximate card height in physical px
  const STEM_SHORT = 38 * dprEst // default stem
  const STEM_MED   = 72 * dprEst // medium stagger
  const STEM_TALL  = 106 * dprEst // tall stagger
  const STEMS = [STEM_SHORT, STEM_MED, STEM_TALL]

  // Sort by elevation descending so highest peaks get priority placement
  peakPositions.sort((a, b) => b.elevation_m - a.elevation_m)

  // Limit to 8 labels max, then resolve overlaps with rect collision
  const resolved: PeakScreenPos[] = []
  interface LabelRect { left: number; right: number; top: number; bottom: number }
  const placedRects: LabelRect[] = []

  for (const pos of peakPositions) {
    if (resolved.length >= 8) break

    // Try each stem height, pick the first that doesn't overlap
    let placed = false
    for (const stem of STEMS) {
      const halfW = CARD_W / 2
      const left = pos.screenX - halfW
      const right = pos.screenX + halfW
      // Card extends upward from dot: dot at screenY, stem above, card above stem
      const top = pos.screenY - stem - CARD_H
      const bottom = pos.screenY

      const overlaps = placedRects.some(r =>
        left < r.right && right > r.left && top < r.bottom && bottom > r.top
      )

      if (!overlaps) {
        pos.stemHeight = stem / dprEst  // store in CSS pixels
        resolved.push(pos)
        placedRects.push({ left, right, top, bottom })
        placed = true
        break
      }
    }
    // If all stem heights overlap, skip this peak entirely
    if (!placed) continue
  }

  // Re-sort by screenX for consistent left-to-right rendering
  resolved.sort((a, b) => a.screenX - b.screenX)
  peakPositions.length = 0
  peakPositions.push(...resolved)

  // ── 5. Peak ridgeline profiles — wedge-shaped terrain profiles around peaks ──
  if (showPeakLabels && peakPositions.length > 0 && skylineData) {
    renderPeakRidgelines(ctx, skylineData, projectedBands, peakPositions, cam, projectedArcs)
  }

  log.debug('Scan canvas drawn', {
    heading:      heading_deg.toFixed(1),
    pitch:        pitch_deg.toFixed(1),
    hfov:         hfov.toFixed(1),
    mode:         skylineData ? 'quick/skyline' : 'loading',
    visiblePeaks: peakPositions.length,
  })

  return peakPositions
}

// ─── Main Component ───────────────────────────────────────────────────────────

const ScanScreen: React.FC = () => {
  const {
    heading_deg, pitch_deg, height_m, fov,
    applyARDrag, setHeightFromSlider, applyFovScale, setFov,
  } = useCameraStore()
  const { activeLat, activeLng, mode, gpsLat, requestGPS, switchToGPS } = useLocationStore()
  const { peaks } = useTerrainStore()
  const { units, showPeakLabels, showBandLines, showFill, showDebugPanel, showContourLines, showSilhouetteLines, darkMode } = useSettingsStore()

  const viewportRef      = useRef<HTMLDivElement>(null)
  const terrainCanvasRef = useRef<HTMLCanvasElement>(null)
  const dragState        = useRef<DragState>({ isDragging: false, lastX: 0, lastY: 0 })
  const pinchState       = useRef<PinchState>({ isPinching: false, lastDist: 0, startFov: fov })
  const sliderRef        = useRef<HTMLDivElement>(null)
  const sliderDragRef    = useRef<{ isDragging: boolean; startY: number; startHeight: number }>({
    isDragging: false, startY: 0, startHeight: height_m,
  })
  const zoomSliderRef    = useRef<HTMLDivElement>(null)
  const zoomDragRef      = useRef<{ isDragging: boolean; startY: number; startFov: number }>({
    isDragging: false, startY: 0, startFov: fov,
  })

  // Phase 2 infrastructure
  const skylineWorker  = useRef<Worker | null>(null)
  const rafRef         = useRef<number>(0)
  // Ref mirror of skylineData — lets the location-change effect read the latest
  // skyline without adding it to the dependency array (avoids re-triggering on completion).
  const skylineDataRef = useRef<SkylineData | null>(null)

  const [showDragHint, setShowDragHint]       = useState(true)
  const [peakPositions, setPeakPositions]     = useState<PeakScreenPos[]>([])
  const [canvasCSSSize, setCanvasCSSSize]     = useState({ w: 0, h: 0 })
  const [skylineData, setSkylineData]         = useState<SkylineData | null>(null)
  const [osmPeaks, setOsmPeaks]               = useState<Peak[]>([])
  const [isSkylineComputing, setIsSkylineComputing] = useState(false)
  const [skylineProgress, setSkylineProgress] = useState(0)
  // Refined arcs from second-pass peak refinement (separate from skylineData)
  const [refinedArcs, setRefinedArcs] = useState<RefinedArc[]>([])
  // Refinement progress: null = not refining, string = status message
  const [refineStatus, setRefineStatus] = useState<string | null>(null)

  // ── Gyroscope mode ──────────────────────────────────────────────────────
  // When active, DeviceOrientationEvent drives heading + pitch.
  // Drag gesture disables gyro (user must tap button to re-enable).
  // TODO: Use gyroscope heading as compass truth for AR overlay.
  // TODO: Smooth gyro input with low-pass filter to reduce jitter.
  // TODO: Handle iOS 13+ permission prompt (DeviceOrientationEvent.requestPermission).
  // TODO: Show brief toast when gyro is activated/deactivated.
  const [isGyroActive, setIsGyroActive] = useState(false)
  const gyroListenerRef = useRef<((e: DeviceOrientationEvent) => void) | null>(null)

  // ── Active peak set: OSM peaks when available, fallback to hardcoded ────────
  const activePeaks: Peak[] = osmPeaks.length > 0 ? osmPeaks : peaks

  // ── Re-project band angles when AGL changes (no worker round-trip) ────────
  // Recomputes ~2160 atan2 calls — sub-millisecond.
  // Uses the worker's z15-corrected ground elevation so angles match exactly.
  const projectedBands = useMemo<ProjectedBands | null>(() => {
    if (!skylineData) return null
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return reprojectBands(skylineData, viewerElev)
  }, [skylineData, height_m])

  // ── Pre-build contour strands (full 360°, one-time on data/AGL change) ────
  // Uses the worker's z15-corrected ground elevation so contour angles match ridgelines.
  const contourStrands = useMemo<PrebuiltContourStrand[]>(() => {
    if (!skylineData) return []
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return buildContourStrands(skylineData, viewerElev)
  }, [skylineData, height_m])

  // ── Re-project refined arc angles when AGL changes ─────────────────────────
  // Uses separate refinedArcs state (from second-pass 'refine-peaks' response).
  // ~4,800 atan2 calls for 20 arcs — sub-millisecond.
  const projectedArcs = useMemo<ProjectedRefinedArc[] | null>(() => {
    if (!skylineData || refinedArcs.length === 0) return null
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return reprojectRefinedArcs(refinedArcs, viewerElev)
  }, [skylineData, refinedArcs, height_m])

  // ── Build silhouette layers (AGL-dependent, runs on height change) ─────────
  // Front-to-back sweep over AGL-independent candidates.  ~75K atan2 calls, sub-ms.
  const silhouetteLayers = useMemo<SilhouetteLayer[][] | null>(() => {
    if (!skylineData || !skylineData.silhouette) return null
    const viewerElev = skylineData.computedAt.groundElev + height_m
    const t0 = performance.now()
    const layers = buildSilhouetteLayers(skylineData, viewerElev)
    const dt = performance.now() - t0
    if (layers) {
      let totalLayers = 0, maxLayers = 0
      for (const azLayers of layers) {
        totalLayers += azLayers.length
        if (azLayers.length > maxLayers) maxLayers = azLayers.length
      }
      log.info('Silhouette layers built', {
        totalLayers,
        avgPerAz: (totalLayers / layers.length).toFixed(1),
        maxPerAz: maxLayers,
        viewerElev: viewerElev.toFixed(0),
        ms: dt.toFixed(2),
      })
    }
    return layers
  }, [skylineData, height_m])

  // ── Re-project near-field occlusion profile (AGL < 60m only) ──────────────
  // 144K atan2 calls ≈ 1.5ms.  Skipped when AGL ≥ 60m (existing band fill sufficient).
  const projectedNearProfile = useMemo<ProjectedNearProfile | null>(() => {
    if (!skylineData || !skylineData.nearProfile) return null
    if (height_m >= NEAR_PROFILE_AGL_LIMIT) return null
    const viewerElev = skylineData.computedAt.groundElev + height_m
    const t0 = performance.now()
    const result = reprojectNearProfile(skylineData.nearProfile, viewerElev)
    const dt = performance.now() - t0
    log.info('Near-field profile reprojected', { ms: dt.toFixed(1), agl: height_m.toFixed(0) })
    return result
  }, [skylineData, height_m])

  // ── Initialise Web Worker ─────────────────────────────────────────────────

  useEffect(() => {
    const worker = new Worker(
      new URL('../../workers/skylineWorker.ts', import.meta.url),
      { type: 'module' },
    )

    worker.onmessage = (e: MessageEvent) => {
      const { type, phase, progress, skyline } = e.data
      if (type === 'progress') {
        if (phase === 'tiles') {
          setSkylineProgress(progress * 0.3)  // tiles = first 30%
        } else if (phase === 'skyline') {
          setSkylineProgress(0.3 + progress * 0.4)  // skyline = next 40%
        } else if (phase === 'silhouette') {
          setSkylineProgress(0.7 + progress * 0.3)  // silhouette = last 30%
        }
      } else if (type === 'complete') {
        log.info('Skyline precomputed', {
          azimuths: skyline.numAzimuths,
          lat: skyline.computedAt.lat.toFixed(4),
          lng: skyline.computedAt.lng.toFixed(4),
          hasSilhouette: !!skyline.silhouette,
          silCandidates: skyline.silhouette
            ? (skyline.silhouette.candidateOffsets[skyline.silhouette.numAzimuths] / 8).toFixed(0)
            : 0,
        })
        const newSkyline = skyline as SkylineData
        setSkylineData(newSkyline)
        skylineDataRef.current = newSkyline   // keep ref in sync for Option 2 distance check
        setIsSkylineComputing(false)
        setSkylineProgress(1)
        // Clear old refined arcs — new ones will arrive via 'refined-arcs' after peak refinement
        setRefinedArcs([])
      } else if (type === 'refine-progress') {
        // Progress from second-pass peak refinement
        const { phase: rPhase, total, done } = e.data as { phase: string; total: number; done: number }
        if (rPhase === 'tiles') {
          setRefineStatus(`Fetching detail tiles for ${total} peaks…`)
        } else {
          setRefineStatus(`Refining peaks… ${done}/${total}`)
        }
      } else if (type === 'refined-arcs') {
        // Second pass complete — worker sent back dense arc data for visible peaks
        const arcs = e.data.refinedArcs as RefinedArc[]
        log.info('Refined arcs received', {
          count: arcs.length,
          totalSamples: arcs.reduce((s: number, a: RefinedArc) => s + a.numSamples, 0),
        })
        setRefinedArcs(arcs)
        setRefineStatus(null)
      }
    }

    worker.onerror = (err) => {
      log.warn('Skyline worker error', { err: err.message })
      setIsSkylineComputing(false)
    }

    skylineWorker.current = worker
    return () => { worker.terminate() }
  }, [])

  // ── Skyline computation on location change ────────────────────────────────
  // Only the worker fetches tiles — main thread shows loading state until done.

  useEffect(() => {
    // ── Skip recompute for tiny moves (< 1.5 km) ─────────────────────────────
    // The ridgeline is virtually identical within 1.5 km, no need to re-ray-march.
    const prev = skylineDataRef.current
    if (prev) {
      const cosLat = Math.cos(activeLat * DEG_TO_RAD)
      const dx = (activeLng - prev.computedAt.lng) * 111_320 * cosLat
      const dy = (activeLat - prev.computedAt.lat) * 111_132
      if (Math.sqrt(dx * dx + dy * dy) < 1500) {
        log.debug('Skyline recompute skipped — move < 1.5 km')
        return
      }
    }

    // ── Stale-while-revalidate ────────────────────────────────────────────────
    // DO NOT clear skylineData here — old panorama stays visible while the worker
    // recomputes in background. Progress bar still shows; canvas swaps on completion.
    setSkylineProgress(0)

    const worker = skylineWorker.current
    if (!worker) return

    setIsSkylineComputing(true)

    const request: SkylineRequest = {
      viewerLat:      activeLat,
      viewerLng:      activeLng,
      viewerHeightM:  height_m,
      resolution:     SKYLINE_RESOLUTION,
      maxRange:       MAX_DIST,
    }

    worker.postMessage(request)

  }, [activeLat, activeLng])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── OSM peak fetch on location change ────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    fetchPeaksNear(activeLat, activeLng, 400)
      .then(fetched => {
        if (!cancelled) {
          setOsmPeaks(fetched)
          log.info('OSM peaks loaded', { count: fetched.length })
        }
      })
      .catch(err => log.warn('OSM peak fetch failed', { err: String(err) }))
    return () => { cancelled = true }
  }, [activeLat, activeLng])

  // ── Gyroscope: DeviceOrientation listener ────────────────────────────────
  // When gyro mode is active, listens for device orientation events and
  // updates heading + pitch to match the phone's physical orientation.
  // Cleanup removes the listener when gyro is toggled off or component unmounts.
  //
  // TODO: Add low-pass filter to smooth jittery gyro readings.
  // TODO: Handle iOS 13+ DeviceOrientationEvent.requestPermission() flow.
  // TODO: Use absolute orientation (webkitCompassHeading) when available.
  // TODO: Eventually also drive AGL from GPS altitude.
  useEffect(() => {
    if (!isGyroActive) {
      // Clean up any existing listener
      if (gyroListenerRef.current) {
        window.removeEventListener('deviceorientation', gyroListenerRef.current)
        gyroListenerRef.current = null
      }
      return
    }

    const handleOrientation = (e: DeviceOrientationEvent) => {
      // alpha = compass heading (0-360), beta = front-back tilt (-180 to 180),
      // gamma = left-right tilt (-90 to 90)
      // webkitCompassHeading is the true compass heading on iOS (alpha is relative)
      const heading = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading
        ?? (e.alpha !== null ? (360 - e.alpha) % 360 : null)
      const pitch = e.beta !== null ? clamp(e.beta - 90, -80, 80) : null

      if (heading !== null) {
        set_heading_from_gyro(heading)
      }
      if (pitch !== null) {
        set_pitch_from_gyro(pitch)
      }
    }

    // Store ref so we can remove it later
    gyroListenerRef.current = handleOrientation
    window.addEventListener('deviceorientation', handleOrientation)

    log.info('Gyroscope mode activated')

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation)
      gyroListenerRef.current = null
    }
  }, [isGyroActive])

  // Direct setters for gyro-driven heading/pitch (bypass sensitivity scaling)
  const set_heading_from_gyro = useCallback((deg: number) => {
    useCameraStore.setState({ heading_deg: ((deg % 360) + 360) % 360 })
  }, [])
  const set_pitch_from_gyro = useCallback((deg: number) => {
    useCameraStore.setState({ pitch_deg: clamp(deg, -80, 80) })
  }, [])

  /**
   * Toggle gyroscope on/off.
   * On iOS 13+, DeviceOrientationEvent requires explicit permission request.
   * TODO: Show user-friendly error if permission is denied.
   */
  const toggleGyro = useCallback(async () => {
    if (isGyroActive) {
      setIsGyroActive(false)
      log.info('Gyroscope deactivated by user')
      return
    }

    // iOS 13+ requires explicit permission request
    const DeviceOrientationEventAny = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>
    }
    if (typeof DeviceOrientationEventAny.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEventAny.requestPermission()
        if (permission !== 'granted') {
          log.warn('Gyroscope permission denied')
          return
        }
      } catch (err) {
        log.warn('Gyroscope permission request failed', { err: String(err) })
        return
      }
    }

    setIsGyroActive(true)
  }, [isGyroActive])

  // ── GPS location button handler ──────────────────────────────────────────
  // Requests GPS permission if needed, then switches to GPS mode which
  // updates activeLat/activeLng across all screens (map, scan, explore).
  const handleGPSClick = useCallback(async () => {
    if (mode === 'gps' && gpsLat !== null) {
      // Already in GPS mode with a fix — switch back to refresh position
      switchToGPS()
      log.info('GPS location refreshed')
      return
    }
    // Request GPS (asks for permission if needed), then switch to GPS mode
    await requestGPS()
    switchToGPS()
    log.info('Switched to GPS location')
  }, [mode, gpsLat, requestGPS, switchToGPS])

  // ── Second pass: trigger peak refinement when skyline + peaks are ready ───
  // Sends visible peak bearings/distances to the worker for dense ray-march
  // with higher-zoom tiles.  Stale-while-revalidate: old arcs stay until new ones arrive.
  useEffect(() => {
    if (!skylineData || isSkylineComputing) return
    const worker = skylineWorker.current
    if (!worker) return

    const peaks = activePeaks
    if (peaks.length === 0) return

    const viewerElev = skylineData.computedAt.groundElev + height_m
    const eyeElev = skylineData.computedAt.elev
    const vLat = skylineData.computedAt.lat
    const vLng = skylineData.computedAt.lng
    const cosLat = Math.cos(vLat * DEG_TO_RAD)

    // Build refine list from ALL visible peaks (not just top 15 on screen)
    // — the worker is fast enough to handle them all.
    const refineItems: PeakRefineItem[] = []
    for (const peak of peaks) {
      const dx = (peak.lng - vLng) * 111_320 * cosLat
      const dy = (peak.lat - vLat) * 111_132
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > MAX_PEAK_DIST || dist < 100) continue

      // Determine which band this peak falls in
      const peakDist_m = dist
      let bandIndex = -1
      for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
        const cfg = DEPTH_BANDS[bi]
        if (cfg && peakDist_m >= cfg.minDist && peakDist_m <= cfg.maxDist) {
          bandIndex = bi
          break
        }
      }
      if (bandIndex < 0) continue

      // Check peak visibility (is it above the ridgeline?)
      const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360
      const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const peakAngle = Math.atan2(peak.elevation_m - curvDrop - eyeElev, dist)
      const ridgeAngle = skylineAngleAt(skylineData, bearing, projectedBands)

      // Only refine peaks that are at least near the ridgeline
      if (peakAngle < ridgeAngle - 1 * DEG_TO_RAD) continue

      refineItems.push({
        bearing,
        distance: dist,
        bandIndex,
        name: peak.name,
      })
    }

    if (refineItems.length === 0) return

    log.info('Requesting peak refinement', { peaks: refineItems.length })
    worker.postMessage({ type: 'refine-peaks', peaks: refineItems })
  }, [skylineData, activePeaks, isSkylineComputing, projectedBands, height_m])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Canvas sizing (only on resize) ────────────────────────────────────────

  const resizeCanvas = useCallback(() => {
    const canvas = terrainCanvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const dpr  = window.devicePixelRatio || 1
    const newW = Math.round(rect.width  * dpr)
    const newH = Math.round(rect.height * dpr)

    // Only reallocate the pixel buffer if the size actually changed
    if (canvas.width !== newW || canvas.height !== newH) {
      canvas.width  = newW
      canvas.height = newH
    }

    setCanvasCSSSize({ w: rect.width, h: rect.height })
  }, [])

  // ── Terrain canvas draw ────────────────────────────────────────────────────

  const redrawCanvas = useCallback(() => {
    const canvas = terrainCanvasRef.current
    if (!canvas) return
    if (canvas.width === 0 || canvas.height === 0) return

    const dpr = window.devicePixelRatio || 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Identity transform — drawScanCanvas works in physical pixels (canvas.width/height)
    // so we must not scale the ctx. Peak positions are divided by dpr after returning.
    ctx.setTransform(1, 0, 0, 1, 0, 0)

    const rawPos = drawScanCanvas(
      canvas,
      activePeaks,
      heading_deg, pitch_deg, height_m,
      activeLat, activeLng,
      fov, skylineData, projectedBands,
      contourStrands, projectedArcs,
      silhouetteLayers,
      projectedNearProfile,
      showBandLines, showFill, showPeakLabels,
      showContourLines, showSilhouetteLines, darkMode,
    )

    setPeakPositions(rawPos.map(p => ({
      ...p,
      screenX: p.screenX / dpr,
      screenY: p.screenY / dpr,
    })))
  }, [
    heading_deg, pitch_deg, height_m, fov,
    activeLat, activeLng,
    activePeaks,
    skylineData, projectedBands, contourStrands, projectedArcs, silhouetteLayers,
    projectedNearProfile,
    showBandLines, showFill, showPeakLabels, showContourLines, showSilhouetteLines, darkMode,
  ])

  // RAF-gated redraw: collapses multiple rapid state changes into one draw per frame
  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      redrawCanvas()
    })
    return () => cancelAnimationFrame(rafRef.current)
  }, [redrawCanvas])

  // ── Resize observer ────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = terrainCanvasRef.current
    if (!canvas) return

    const handleResize = () => {
      resizeCanvas()
      redrawCanvas()
    }

    // Initial size
    handleResize()

    const observer = new ResizeObserver(handleResize)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [resizeCanvas, redrawCanvas])

  // ── Pointer drag (heading + pitch) ────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Ignore second finger (pinch uses touch events)
    if (e.isPrimary === false) return
    viewportRef.current?.setPointerCapture(e.pointerId)
    dragState.current = { isDragging: true, lastX: e.clientX, lastY: e.clientY }
    setShowDragHint(false)

    // Manual drag disables gyroscope — user must tap gyro button to re-enable.
    // This prevents fighting between finger input and sensor input.
    if (isGyroActive) {
      setIsGyroActive(false)
      log.info('Gyroscope deactivated by drag gesture')
    }
  }, [isGyroActive])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current.isDragging || pinchState.current.isPinching) return
    const deltaX = e.clientX - dragState.current.lastX
    const deltaY = e.clientY - dragState.current.lastY
    dragState.current.lastX = e.clientX
    dragState.current.lastY = e.clientY
    applyARDrag(deltaX, deltaY)
  }, [applyARDrag])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    viewportRef.current?.releasePointerCapture(e.pointerId)
    dragState.current.isDragging = false
  }, [])

  // ── Pinch zoom (FOV) ──────────────────────────────────────────────────────

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      pinchState.current = { isPinching: true, lastDist: dist, startFov: fov }
      dragState.current.isDragging = false
    }
  }, [fov])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchState.current.isPinching) {
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (pinchState.current.lastDist > 0) {
        // Pinch in (fingers apart → zoom in → narrower FOV)
        const scale = pinchState.current.lastDist / dist
        applyFovScale(scale)
      }
      pinchState.current.lastDist = dist
    }
  }, [applyFovScale])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length < 2) {
      pinchState.current.isPinching = false
    }
  }, [])

  // ── Height slider ─────────────────────────────────────────────────────────

  const handleSliderPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    sliderRef.current?.setPointerCapture(e.pointerId)
    sliderDragRef.current = { isDragging: true, startY: e.clientY, startHeight: height_m }
  }, [height_m])

  const handleSliderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!sliderDragRef.current.isDragging) return
    const sliderEl = sliderRef.current
    if (!sliderEl) return
    const sliderHeight = sliderEl.getBoundingClientRect().height
    const deltaY       = e.clientY - sliderDragRef.current.startY
    const heightDelta  = -(deltaY / sliderHeight) * (MAX_HEIGHT_M - MIN_HEIGHT_M)
    const newHeight    = clamp(sliderDragRef.current.startHeight + heightDelta, MIN_HEIGHT_M, MAX_HEIGHT_M)
    setHeightFromSlider(metersToFeet(newHeight))
  }, [setHeightFromSlider])

  const handleSliderPointerUp = useCallback((e: React.PointerEvent) => {
    sliderRef.current?.releasePointerCapture(e.pointerId)
    sliderDragRef.current.isDragging = false
  }, [])

  // ── Zoom slider (FOV) ──────────────────────────────────────────────────────
  // Drag up = zoom in (smaller FOV), drag down = zoom out (larger FOV)

  const MIN_FOV = 12
  const MAX_FOV = 100

  const handleZoomPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    zoomSliderRef.current?.setPointerCapture(e.pointerId)
    zoomDragRef.current = { isDragging: true, startY: e.clientY, startFov: fov }
  }, [fov])

  const handleZoomPointerMove = useCallback((e: React.PointerEvent) => {
    if (!zoomDragRef.current.isDragging) return
    const el = zoomSliderRef.current
    if (!el) return
    const trackHeight = el.getBoundingClientRect().height
    const deltaY = e.clientY - zoomDragRef.current.startY
    // Drag up (negative deltaY) → smaller FOV (zoom in)
    const fovDelta = (deltaY / trackHeight) * (MAX_FOV - MIN_FOV)
    const newFov = clamp(zoomDragRef.current.startFov + fovDelta, MIN_FOV, MAX_FOV)
    setFov(newFov)
  }, [setFov])

  const handleZoomPointerUp = useCallback((e: React.PointerEvent) => {
    zoomSliderRef.current?.releasePointerCapture(e.pointerId)
    zoomDragRef.current.isDragging = false
  }, [])

  // ── FOV-aware compass sizing ──────────────────────────────────────────────
  // Each compass item = 22.5°. Scale item width so that FOV degrees = viewport width.
  const compassItemWidth = typeof window !== 'undefined'
    ? window.innerWidth * 22.5 / fov
    : COMPASS_ITEM_WIDTH

  const compassOffset = (() => {
    const headingIndex    = heading_deg / 22.5
    const centerItemIndex = headingIndex + 16
    return -(centerItemIndex * compassItemWidth)
  })()

  // ── Ground elevation for HUD ─────────────────────────────────────────────
  // Uses the worker's z15 tile-based ground elevation. Before skyline is ready,
  // we don't have a ground elevation yet — show 0 until the worker responds.
  const groundElev = skylineData
    ? skylineData.computedAt.groundElev
    : 0

  // ── Loading state ─────────────────────────────────────────────────────────

  const isLoading = isSkylineComputing
  const loadingLabel = isSkylineComputing
    ? `Computing panorama… ${Math.round(skylineProgress * 100)}%`
    : ''

  return (
    <div className={styles.screen}>
      {/* ── Compass Strip ──────────────────────────────────────────────────── */}
      <div
        className={styles.compassStrip}
        role="img"
        aria-label={`Compass: ${headingToCompass(heading_deg)} at ${Math.round(heading_deg)}°`}
      >
        <div className={styles.compassNotch} aria-hidden="true" />
        <div className={styles.headingDegrees} aria-hidden="true">
          {Math.round(heading_deg).toString().padStart(3, '0')}°
        </div>
        <div
          className={styles.compassTrack}
          style={{ transform: `translateX(calc(50vw + ${compassOffset}px))` }}
          aria-hidden="true"
        >
          {[0, 1, 2].flatMap((loop) =>
            COMPASS_DIRECTIONS.map((dir, dirIndex) => {
              const isCardinal = ['N', 'S', 'E', 'W'].includes(dir)
              return (
                <div key={`${loop}-${dirIndex}`} className={styles.compassItem} style={{ width: `${compassItemWidth}px` }}>
                  <span className={`${styles.compassLabel} ${isCardinal ? styles.cardinal : ''}`}>
                    {dir}
                  </span>
                  <div className={`${styles.compassTick} ${isCardinal ? styles.cardinalTick : ''}`} />
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* ── Terrain Viewport ───────────────────────────────────────────────── */}
      <div
        ref={viewportRef}
        className={styles.viewport}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        role="application"
        aria-label="Terrain view — drag to look around, pinch to zoom"
      >
        <canvas
          ref={terrainCanvasRef}
          className={styles.terrainCanvas}
          aria-hidden="true"
        />

        {/* Peak labels */}
        {showPeakLabels && peakPositions.length > 0 && (
          <div className={styles.peakLabelsLayer} aria-label="Peak labels">
            {peakPositions.map((pos) => (
              <PeakLabel
                key={pos.id}
                pos={pos}
                units={units}
                canvasH={canvasCSSSize.h}
              />
            ))}
          </div>
        )}

        {/* Loading overlay */}
        {isLoading && (
          <div className={styles.loadingOverlay} role="status" aria-live="polite">
            <div className={styles.loadingBar}>
              <div
                className={styles.loadingFill}
                style={{ width: `${Math.round(skylineProgress * 100)}%` }}
              />
            </div>
            <span className={styles.loadingLabel}>{loadingLabel}</span>
            <span className={styles.loadingLabel} style={{ marginTop: 4 }}>v1.0.4-MVP</span>
          </div>
        )}

        {/* Refinement progress indicator — shown while second-pass peak refinement runs */}
        {refineStatus && !isLoading && (
          <div style={{
            position: 'absolute', bottom: 70, left: '50%', transform: 'translateX(-50%)',
            color: 'rgba(104, 176, 191, 0.85)', fontSize: 11, fontFamily: 'monospace',
            background: 'rgba(0,0,0,0.5)', padding: '4px 12px',
            borderRadius: 10, zIndex: 100, whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}>
            {refineStatus}
          </div>
        )}

        {/* DEBUG: Comprehensive diagnostics panel */}
        {showDebugPanel && skylineData && (
          <div style={{
            position: 'absolute', top: 58, right: 44,
            color: '#0f0', fontSize: 9, fontFamily: 'monospace',
            background: 'rgba(0,0,0,0.8)', padding: '6px 10px',
            borderRadius: 4, zIndex: 9999, lineHeight: 1.4,
            pointerEvents: 'none', maxWidth: 280,
          }}>
            {(() => {
              const canvasW = terrainCanvasRef.current?.width || 0
              const canvasH = terrainCanvasRef.current?.height || 0
              const horizY = getHorizonY({ heading_deg, pitch_deg, hfov: fov, W: canvasW, H: canvasH })
              const pxPerDegH = canvasW ? (canvasW / (fov * DEG_TO_RAD)).toFixed(1) : '?'
              const pxPerDegV = canvasW ? (canvasW / (fov * DEG_TO_RAD)).toFixed(1) : '?'
              const gElev = skylineData.computedAt.groundElev
              const eyeElev = gElev + height_m

              // Azimuth spacing: how many screen pixels per azimuth sample
              const pxPerAzStd = canvasW ? (canvasW / (fov * skylineData.resolution)).toFixed(1) : '?'
              const pxPerAzHi  = canvasW ? (canvasW / (fov * 4)).toFixed(1) : '?'

              // Geometric horizon at current AGL
              const horizonDist = Math.sqrt(2 * EARTH_R * height_m) / 1000  // km

              // Re-projection validation
              let maxAngleDiff = 0
              if (projectedBands && skylineData) {
                for (let i = 0; i < skylineData.numAzimuths; i++) {
                  const diff = Math.abs(projectedBands.overallAngles[i] - skylineData.angles[i])
                  if (diff > maxAngleDiff) maxAngleDiff = diff
                }
              }
              const angleDiffDeg = (maxAngleDiff * 180 / Math.PI).toFixed(4)
              const angleDiffOk = maxAngleDiff < 0.001

              // Per-band stats (using per-band resolution)
              const bandStats = skylineData.bands.map((band, bi) => {
                const bandAz = band.numAzimuths
                let active = 0, eMin = Infinity, eMax = -Infinity, dMin = Infinity, dMax = -Infinity
                for (let i = 0; i < bandAz; i++) {
                  if (band.elevations[i] > -Infinity) {
                    active++
                    if (band.elevations[i] < eMin) eMin = band.elevations[i]
                    if (band.elevations[i] > eMax) eMax = band.elevations[i]
                    if (band.distances[i] < dMin) dMin = band.distances[i]
                    if (band.distances[i] > dMax) dMax = band.distances[i]
                  }
                }
                // Center-of-view angle for this band (use band's own resolution)
                const normB = ((heading_deg % 360) + 360) % 360
                const centerIdx = Math.round(normB * band.resolution) % bandAz
                const centerAngle = projectedBands
                  ? projectedBands.bandAngles[bi][centerIdx]
                  : (band.elevations[centerIdx] > -Infinity
                    ? Math.atan2(band.elevations[centerIdx] - (band.distances[centerIdx] * band.distances[centerIdx]) / (2 * EARTH_R) * (1 - REFRACTION_K) - skylineData.computedAt.elev, band.distances[centerIdx])
                    : -Math.PI / 2)
                return { label: DEPTH_BANDS[bi]?.label || `band${bi}`, active, bandAz, bandRes: band.resolution, eMin, eMax, dMin, dMax, centerAngle }
              })

              const elevMismatch = projectedBands
                ? Math.abs(skylineData.computedAt.elev - projectedBands.viewerElev)
                : 0

              // Peak funnel
              const totalPeaks = (osmPeaks.length > 0 ? osmPeaks : peaks).length

              return (
                <>
                  <div style={{ color: '#A7DDE5', marginBottom: 2 }}>v2.4 DEBUG — Silhouettes + Refined Arcs</div>

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>CAMERA</div>
                  <div>hdg:{heading_deg.toFixed(1)}° pit:{pitch_deg.toFixed(1)}° fov:{fov.toFixed(0)}°</div>
                  <div>horizonY:{horizY.toFixed(0)}px  px/rad H:{pxPerDegH} V:{pxPerDegV}</div>
                  <div>AGL:{height_m.toFixed(0)}m  ground:{gElev.toFixed(0)}m  eye:{eyeElev.toFixed(0)}m</div>
                  <div>interp:ON  az:{pxPerAzStd}px/std {pxPerAzHi}px/hi</div>
                  <div>horizon:{horizonDist.toFixed(0)}km (geometric)</div>

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>RE-PROJECTION</div>
                  <div style={{ color: angleDiffOk ? '#0f0' : '#f44' }}>
                    max Δangle: {angleDiffDeg}° {angleDiffOk ? '✓' : '⚠ MISMATCH'}
                  </div>
                  <div>worker elev: {skylineData.computedAt.elev.toFixed(0)}m</div>
                  {projectedBands && <div>reproj elev: {projectedBands.viewerElev.toFixed(0)}m</div>}
                  <div style={{ color: elevMismatch > 50 ? '#f44' : elevMismatch > 10 ? '#fa0' : '#0f0' }}>
                    Δelev: {elevMismatch.toFixed(0)}m {elevMismatch > 50 ? '⚠ BIG' : ''}
                  </div>

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>BANDS ({bandStats.length})</div>
                  {(() => {
                    // Global elev range for debug color preview
                    let gMin = Infinity, gMax = -Infinity
                    for (const bs of bandStats) {
                      if (bs.active > 0) {
                        if (bs.eMin < gMin) gMin = bs.eMin
                        if (bs.eMax > gMax) gMax = bs.eMax
                      }
                    }
                    const gRange = gMax - gMin
                    return bandStats.map((bs, i) => {
                      const bandCfg = DEPTH_BANDS[i]
                      const rangeStr = bandCfg ? `[${(bandCfg.minDist/1000).toFixed(0)}–${(bandCfg.maxDist/1000).toFixed(0)}km]` : ''
                      const resLabel = bs.bandRes > SKYLINE_RESOLUTION ? ' hi' : ''
                      // Palette-derived color: use band's center elevation mapped through RIDGE_PALETTE
                      const bandT = bandStats.length <= 1 ? 1 : 1 - i / (bandStats.length - 1)
                      const centerElev = bs.active > 0 ? (bs.eMin + bs.eMax) / 2 : 0
                      const tElev = gRange > 1 && bs.active > 0 ? (centerElev - gMin) / gRange : 0.5
                      const bandColor = bs.active === 0 ? '#666' : elevToRidgeColor(Math.min(1, tElev + 0.2))
                      const bStyle = bandStyleForIndex(i, bandStats.length)
                      return (
                        <div key={bs.label} style={{ color: bandColor }}>
                          {bs.label} {rangeStr}: {bs.active}/{bs.bandAz}az{resLabel} lw:{bStyle.lineWidthNear.toFixed(0)}→{bStyle.lineWidthFar.toFixed(0)}px c:{Math.round((CONTOUR_INTERVALS_M[i] || 0) / 0.3048)}ft
                          {bs.active > 0 && (
                            <>
                              {' '}∠{(bs.centerAngle * 180 / Math.PI).toFixed(2)}°
                              {' '}e:{bs.eMin.toFixed(0)}–{bs.eMax.toFixed(0)}m
                              {' '}d:{(bs.dMin/1000).toFixed(1)}–{(bs.dMax/1000).toFixed(1)}km
                            </>
                          )}
                        </div>
                      )
                    })
                  })()}

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>REFINED ARCS (2nd pass)</div>
                  {(() => {
                    if (refinedArcs.length === 0) return <div style={{ color: '#666' }}>none (awaiting peaks)</div>
                    const matchedCount = projectedArcs ? projectedArcs.length : 0
                    const totalSamples = refinedArcs.reduce((sum, a) => sum + a.numSamples, 0)
                    return (
                      <>
                        <div>peaks:{refinedArcs.length} samples:{totalSamples} projected:{matchedCount}</div>
                        {refinedArcs.slice(0, 8).map((arc, i) => {
                          const bandLabel = DEPTH_BANDS[arc.bandIndex]?.label || `b${arc.bandIndex}`
                          return (
                            <div key={i} style={{ color: '#ccc', fontSize: 8 }}>
                              {bandLabel} {arc.centerBearing.toFixed(1)}°±{arc.halfWidth}° d:{(arc.featureDist/1000).toFixed(1)}km e:{arc.featureElev.toFixed(0)}m
                            </div>
                          )
                        })}
                        {refinedArcs.length > 8 && <div style={{ color: '#666', fontSize: 8 }}>...+{refinedArcs.length - 8} more</div>}
                      </>
                    )
                  })()}

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>SILHOUETTES</div>
                  {(() => {
                    const sil = skylineData.silhouette
                    if (!sil) return <div style={{ color: '#666' }}>no silhouette data</div>
                    // Count total candidates
                    const totalCandidates = sil.candidateOffsets[sil.numAzimuths] / 8  // 8 floats per candidate
                    const avgPerAz = (totalCandidates / sil.numAzimuths).toFixed(1)
                    const memKB = ((sil.candidateData.length * 4 + sil.candidateOffsets.length * 4) / 1024).toFixed(0)
                    // Count visible layers if available
                    let totalVisibleLayers = 0, maxLayersPerAz = 0, azWithLayers = 0
                    if (silhouetteLayers) {
                      for (const azLayers of silhouetteLayers) {
                        if (azLayers.length > 0) azWithLayers++
                        totalVisibleLayers += azLayers.length
                        if (azLayers.length > maxLayersPerAz) maxLayersPerAz = azLayers.length
                      }
                    }
                    const avgVisiblePerAz = silhouetteLayers ? (totalVisibleLayers / sil.numAzimuths).toFixed(1) : '?'
                    return (
                      <>
                        <div>candidates:{totalCandidates.toFixed(0)} avg:{avgPerAz}/az mem:{memKB}KB</div>
                        <div>res:{sil.resolution} az:{sil.numAzimuths}</div>
                        {silhouetteLayers && (
                          <div>visible layers: {totalVisibleLayers} avg:{avgVisiblePerAz}/az max:{maxLayersPerAz} active:{azWithLayers}az</div>
                        )}
                      </>
                    )
                  })()}

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>NEAR-FIELD OCCLUSION</div>
                  {(() => {
                    const np = skylineData.nearProfile
                    if (!np) return <div style={{ color: '#666' }}>no near-field profile</div>
                    const totalSamples = np.sampleCounts.reduce((s: number, c: number) => s + c, 0)
                    const avgPerAz = (totalSamples / np.numAzimuths).toFixed(1)
                    const memKB = ((np.profileData.length * 4 + np.sampleCounts.length * 2) / 1024).toFixed(0)
                    const active = projectedNearProfile ? 'ON' : 'OFF'
                    const reason = !projectedNearProfile && height_m >= NEAR_PROFILE_AGL_LIMIT
                      ? `(AGL≥${NEAR_PROFILE_AGL_LIMIT}m)` : ''
                    return (
                      <>
                        <div style={{ color: active === 'ON' ? '#4f4' : '#f44' }}>{active} {reason}</div>
                        <div>samples:{totalSamples} avg:{avgPerAz}/az mem:{memKB}KB</div>
                      </>
                    )
                  })()}

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>PEAKS</div>
                  <div>total:{totalPeaks} → visible:{peakPositions.length} (r≤{MAX_PEAK_DIST/1000}km)</div>
                  {peakPositions.slice(0, 3).map(p => (
                    <div key={p.id} style={{ color: '#ccc', fontSize: 8 }}>
                      {p.name}: {p.bearing.toFixed(0)}° {p.dist_km.toFixed(0)}km x:{p.screenX.toFixed(0)} y:{p.screenY.toFixed(0)}
                    </div>
                  ))}
                </>
              )
            })()}
          </div>
        )}

        {/* Zoom slider (FOV control) */}
        <ZoomSlider
          fov={fov}
          sliderRef={zoomSliderRef}
          onPointerDown={handleZoomPointerDown}
          onPointerMove={handleZoomPointerMove}
          onPointerUp={handleZoomPointerUp}
        />

        {/* Drag hint — updates to mention gyro when available */}
        <div
          className={`${styles.dragHint} ${!showDragHint ? styles.hidden : ''}`}
          aria-hidden="true"
        >
          ← Drag to look around — Pinch to zoom →
        </div>

        {/* Navigate hint */}
        <NavigateHint />

        {/* ── Bottom-right action buttons (gyro + GPS) ─────────────────── */}
        <div className={styles.actionButtons}>
          {/* Gyroscope toggle — activates device orientation tracking */}
          <button
            className={`${styles.gyroBtn} ${isGyroActive ? styles.gyroBtnActive : ''}`}
            onClick={toggleGyro}
            aria-label={isGyroActive ? 'Disable gyroscope control' : 'Enable gyroscope control'}
            title={isGyroActive ? 'Gyro ON — drag to disable' : 'Enable Gyroscope'}
          >
            {/* 3D gyroscope icon — three nested gimbal rings */}
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
              {/* Outer ring (yaw) */}
              <ellipse cx="12" cy="12" rx="10" ry="10" opacity="0.5" />
              {/* Middle ring (pitch) — tilted */}
              <ellipse cx="12" cy="12" rx="10" ry="5" opacity="0.7" />
              {/* Inner ring (roll) — perpendicular */}
              <ellipse cx="12" cy="12" rx="3.5" ry="10" opacity="0.7" />
              {/* Center sphere */}
              <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" opacity="0.9" />
            </svg>
            <span className={styles.gyroBtnLabel}>{isGyroActive ? 'GYRO' : 'GYRO'}</span>
          </button>

          {/* Current location (GPS) button */}
          <button
            className={`${styles.gpsBtn} ${mode === 'gps' && gpsLat !== null ? styles.gpsBtnActive : ''}`}
            onClick={handleGPSClick}
            aria-label="Use current GPS location"
            title={mode === 'gps' && gpsLat !== null ? 'GPS active' : 'Go to my location'}
          >
            {/* GPS/location pin icon */}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              {/* Crosshair circle */}
              <circle cx="12" cy="12" r="8" />
              <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" opacity="0.9" />
              {/* Crosshair lines */}
              <line x1="12" y1="1" x2="12" y2="4" />
              <line x1="12" y1="20" x2="12" y2="23" />
              <line x1="1" y1="12" x2="4" y2="12" />
              <line x1="20" y1="12" x2="23" y2="12" />
            </svg>
            <span className={styles.gyroBtnLabel}>GPS</span>
          </button>
        </div>
      </div>

      {/* ── Height Slider ──────────────────────────────────────────────────── */}
      <div className={styles.heightSlider} aria-label="View height slider">
        <span className={styles.heightSliderLabel}>HIGH</span>
        <div
          ref={sliderRef}
          className={styles.heightSliderTrack}
          onPointerDown={handleSliderPointerDown}
          onPointerMove={handleSliderPointerMove}
          onPointerUp={handleSliderPointerUp}
          onPointerCancel={handleSliderPointerUp}
          role="slider"
          aria-label="Eye height above ground"
          aria-valuemin={Math.round(metersToFeet(MIN_HEIGHT_M))}
          aria-valuemax={Math.round(metersToFeet(MAX_HEIGHT_M))}
          aria-valuenow={Math.round(metersToFeet(height_m))}
        >
          <div
            className={styles.heightSliderFill}
            style={{ height: `${((height_m - MIN_HEIGHT_M) / (MAX_HEIGHT_M - MIN_HEIGHT_M)) * 100}%` }}
            aria-hidden="true"
          />
          <div
            className={styles.heightSliderThumb}
            style={{ bottom: `${((height_m - MIN_HEIGHT_M) / (MAX_HEIGHT_M - MIN_HEIGHT_M)) * 100}%` }}
            aria-hidden="true"
          />
        </div>
        <span className={styles.heightSliderLabel}>LOW</span>
        <span className={styles.heightSliderValue}>
          {units === 'imperial'
            ? `${Math.round(metersToFeet(height_m))}ft`
            : `${Math.round(height_m)}m`}
        </span>
      </div>

      {/* ── HUD Bar ────────────────────────────────────────────────────────── */}
      <HUDBar
        heading_deg={heading_deg}
        lat={activeLat}
        lng={activeLng}
        groundElev_m={groundElev}
        eyeHeight_m={height_m}
        units={units}
        skylineReady={skylineData !== null}
      />

      {/* Tutorial overlay */}
      <TutorialOverlay screen="scan" />
    </div>
  )
}

// ─── Sub-Components ───────────────────────────────────────────────────────────

const PeakLabel: React.FC<{
  pos: PeakScreenPos
  units: 'imperial' | 'metric'
  canvasH: number
}> = ({ pos, units, canvasH }) => {
  const distFade  = Math.max(0.25, 1 - Math.pow(pos.dist_km / (MAX_PEAK_DIST / 1000), 0.5))
  const isNearTop = pos.screenY < canvasH * 0.22

  // Format distance respecting unit preference
  const distStr = formatDistance(pos.dist_km, units)

  // Show English name prominently if available, with local name below
  const displayName = pos.nameEn || pos.name
  const localName = pos.nameEn ? pos.name : undefined

  const card = (
    <div className={styles.peakCard} aria-hidden="true">
      <span className={styles.peakName}>{displayName}</span>
      {localName && <span className={styles.peakNameLocal}>{localName}</span>}
      <span className={styles.peakElev}>{formatElevation(pos.elevation_m, units)}</span>
      <span className={styles.peakBearing}>
        {headingToCompass(pos.bearing)} · {distStr}
      </span>
    </div>
  )

  // Variable stem height from overlap resolver (default 38px, staggered 72/106px)
  const stemH = pos.stemHeight || 38
  const stemStyle: React.CSSProperties = { height: `${stemH}px` }

  // Anchor the dot center at pos.screenY regardless of card content height.
  // Normal (dot at bottom): use `bottom` so card+line grow upward naturally.
  // Flipped (dot at top): use `top` so line+card grow downward.
  const DOT_HALF = 4  // half of the 8px peakDot
  const posStyle: React.CSSProperties = isNearTop
    ? { left: `${pos.screenX}px`, top: `${pos.screenY - DOT_HALF}px`, opacity: distFade }
    : { left: `${pos.screenX}px`, bottom: `${canvasH - pos.screenY - DOT_HALF}px`, opacity: distFade }

  return (
    <div
      className={`${styles.peakLabel} ${isNearTop ? styles.peakLabelFlipped : ''}`}
      style={posStyle}
      role="img"
      aria-label={`${pos.name}, ${formatElevation(pos.elevation_m, units)}, ${distStr}`}
    >
      {isNearTop ? (
        <>
          <div className={styles.peakDot}              aria-hidden="true" />
          <div className={`${styles.peakLine} ${styles.peakLineDown}`} style={stemStyle} aria-hidden="true" />
          {card}
        </>
      ) : (
        <>
          {card}
          <div className={styles.peakLine} style={stemStyle} aria-hidden="true" />
          <div className={styles.peakDot}   aria-hidden="true" />
        </>
      )}
    </div>
  )
}

/** Vertical zoom slider on the left edge — controls FOV (drag up = zoom in). */
const ZoomSlider: React.FC<{
  fov: number
  sliderRef: React.RefObject<HTMLDivElement>
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp:   (e: React.PointerEvent) => void
}> = ({ fov, sliderRef, onPointerDown, onPointerMove, onPointerUp }) => {
  // Map FOV 12°–100° → marker position: 12° (zoomed in) = top, 100° (zoomed out) = bottom
  const pct = ((fov - 12) / (100 - 12)) * 100
  // Zoom multiplier relative to default 60° FOV
  const zoomX = (60 / fov).toFixed(1)

  return (
    <div className={styles.zoomSlider} aria-hidden="true">
      <span className={styles.zoomLabel}>+</span>
      <div
        ref={sliderRef as React.RefObject<HTMLDivElement>}
        className={styles.zoomTrack}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="slider"
        aria-label="Zoom level"
        aria-valuemin={12}
        aria-valuemax={100}
        aria-valuenow={Math.round(fov)}
      >
        <div className={styles.zoomMarker} style={{ top: `${pct}%` }} />
      </div>
      <span className={styles.zoomLabel}>−</span>
      <span className={styles.zoomValue}>{zoomX}×</span>
    </div>
  )
}

interface HUDBarProps {
  heading_deg: number
  lat: number
  lng: number
  groundElev_m: number
  eyeHeight_m: number
  units: 'imperial' | 'metric'
  skylineReady: boolean
}

const HUDBar: React.FC<HUDBarProps> = ({
  heading_deg, lat, lng, groundElev_m, eyeHeight_m, units, skylineReady,
}) => {
  const headingStr = `${Math.round(heading_deg).toString().padStart(3, '0')}°`
  const latStr     = `${lat.toFixed(4)}°`
  const lngStr     = `${Math.abs(lng).toFixed(4)}°${lng < 0 ? 'W' : 'E'}`
  const elevStr    = formatElevation(groundElev_m, units)
  const eyeStr     = formatElevation(eyeHeight_m, units)

  return (
    <div className={styles.hud} role="status" aria-label="Navigation data readout">
      <div className={styles.hudItem}>
        <span className={styles.hudLabel}>HDG</span>
        <span className={styles.hudValue}>{headingStr}</span>
      </div>
      <div className={styles.hudDivider} aria-hidden="true" />
      <div className={styles.hudItem}>
        <span className={styles.hudLabel}>LAT</span>
        <span className={styles.hudValue}>{latStr}</span>
      </div>
      <div className={styles.hudDivider} aria-hidden="true" />
      <div className={styles.hudItem}>
        <span className={styles.hudLabel}>LONG</span>
        <span className={styles.hudValue}>{lngStr}</span>
      </div>
      <div className={styles.hudDivider} aria-hidden="true" />
      <div className={styles.hudItem}>
        <span className={styles.hudLabel}>ELEV</span>
        <span className={styles.hudValue}>{elevStr}</span>
      </div>
      <div className={styles.hudDivider} aria-hidden="true" />
      <div className={styles.hudItem}>
        <span className={styles.hudLabel}>AGL</span>
        <span className={styles.hudValue}>{eyeStr}</span>
      </div>
      {skylineReady && (
        <>
          <div className={styles.hudDivider} aria-hidden="true" />
          <div className={styles.hudItem}>
            <span className={`${styles.hudValue} ${styles.hudReady}`}>250KM</span>
          </div>
        </>
      )}
    </div>
  )
}

export default ScanScreen
