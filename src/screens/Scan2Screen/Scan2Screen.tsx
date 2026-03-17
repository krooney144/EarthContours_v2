/**
 * Scan2 Screen — First-person immersive terrain exploration
 *
 * Places the viewer at ground level on a Three.js terrain mesh and lets them
 * look around 360° with drag controls. Uses the same activeLat/activeLng
 * location as the SCAN screen (set from MAP clicks or GPS).
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *   1. Load elevation grid around activeLat/activeLng (same as MAP → SCAN flow)
 *   2. Build displaced PlaneGeometry mesh via FirstPersonRenderer
 *   3. Camera at ground level + AGL offset, heading/pitch driven by drag
 *   4. Peak labels as HTML overlays (projected via Three.js camera)
 *   5. Compass strip + height slider + HUD bar (matching SCAN UI patterns)
 *
 * ── Earth Curvature ───────────────────────────────────────────────────────────
 *   The mesh uses flat ENU coordinates (East-North-Up). At the default ~40km
 *   terrain size, curvature error is <10m — negligible for visual rendering.
 *   For larger terrains (>100km), consider spherical correction or LOD.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { createLogger } from '../../core/logger'
import { useLocationStore, useSettingsStore } from '../../store'
import {
  DEFAULT_HEIGHT_M, MAX_HEIGHT_M, MIN_HEIGHT_M,
  ENU_M_PER_DEG_LAT, ENU_M_PER_DEG_LON_AT_LAT,
  TERRAIN_GRID_SIZE, COMPASS_DIRECTIONS, COMPASS_ITEM_WIDTH,
} from '../../core/constants'
import { formatElevation, headingToCompass, calculateBearing, clamp, metersToFeet } from '../../core/utils'
import { loadRegionElevation, adaptiveZoomForArea } from '../../data/elevationLoader'
import { fetchPeaksNear } from '../../data/peakLoader'
import type { Peak, TerrainMeshData, Region } from '../../core/types'
import { FirstPersonRenderer } from '../../renderer/FirstPersonRenderer'
import styles from './Scan2Screen.module.css'

const log = createLogger('SCREEN:SCAN2')

// ─── Constants ────────────────────────────────────────────────────────────────

const TERRAIN_RADIUS_KM = 20       // Load terrain in a 40km × 40km box
const PEAK_SEARCH_RADIUS_KM = 50   // Search for peaks within 50km
const MAX_VISIBLE_PEAKS = 10       // Max peak labels on screen
const VERTICAL_EXAGGERATION = 1.5  // Slight exaggeration for visual impact
const DEFAULT_FOV = 70             // Horizontal FOV in degrees
const DRAG_SENSITIVITY_X = 0.25    // Degrees per pixel dragged (heading)
const DRAG_SENSITIVITY_Y = 0.20    // Degrees per pixel dragged (pitch)

// ─── Types ────────────────────────────────────────────────────────────────────

interface PeakScreenPos {
  name: string
  elevation_m: number
  bearing: number
  dist_km: number
  screenX: number
  screenY: number
}

// ─── Contour calculation (matches terrainStore) ──────────────────────────────

function calculateContourElevations(minElev: number, maxElev: number): number[] {
  const range = maxElev - minElev
  const interval = range < 500 ? 50 : 100
  const contours: number[] = []
  const start = Math.ceil(minElev / interval) * interval
  for (let elev = start; elev <= maxElev; elev += interval) {
    contours.push(elev)
  }
  return contours
}

// ─── Component ────────────────────────────────────────────────────────────────

const Scan2Screen: React.FC = () => {
  log.info('Scan2Screen mounted')

  // ── Store subscriptions ──────────────────────────────────────────────────
  const activeLat = useLocationStore(s => s.activeLat)
  const activeLng = useLocationStore(s => s.activeLng)
  const units = useSettingsStore(s => s.units)

  // ── Local state ──────────────────────────────────────────────────────────
  const [heading, setHeading] = useState(0)         // degrees, 0=N
  const [pitch, setPitch] = useState(0)              // degrees, 0=horizon
  const [heightM, setHeightM] = useState(DEFAULT_HEIGHT_M)
  const [fov] = useState(DEFAULT_FOV)

  const [meshData, setMeshData] = useState<TerrainMeshData | null>(null)
  const [peaks, setPeaks] = useState<Peak[]>([])
  const [peakPositions, setPeakPositions] = useState<PeakScreenPos[]>([])
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [loadingMessage, setLoadingMessage] = useState('Initializing...')
  const [isLoading, setIsLoading] = useState(true)
  const [dragHintVisible, setDragHintVisible] = useState(true)

  // ── Refs ──────────────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<FirstPersonRenderer | null>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const isDraggingView = useRef(false)
  const isDraggingSlider = useRef(false)
  const lastPointer = useRef({ x: 0, y: 0 })
  const rafId = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // ── Initialize renderer ──────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const renderer = new FirstPersonRenderer()
    renderer.initialize(canvas)
    rendererRef.current = renderer

    // Size canvas to container
    const resizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      renderer.resize(canvas.width, canvas.height)
    }
    resizeCanvas()

    const ro = new ResizeObserver(resizeCanvas)
    ro.observe(canvas)

    return () => {
      ro.disconnect()
      cancelAnimationFrame(rafId.current)
      renderer.dispose()
      rendererRef.current = null
    }
  }, [])

  // ── Load terrain around active location ──────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function loadTerrain() {
      setIsLoading(true)
      setLoadingProgress(0)
      setLoadingMessage('Loading terrain tiles...')

      const lat = activeLat
      const lng = activeLng

      // Build bounding box around the point
      const dLat = TERRAIN_RADIUS_KM / 111.132
      const cosLat = Math.cos(lat * Math.PI / 180)
      const dLng = TERRAIN_RADIUS_KM / (111.320 * cosLat)

      const bounds = {
        north: lat + dLat,
        south: lat - dLat,
        east: lng + dLng,
        west: lng - dLng,
      }

      const heightKm = TERRAIN_RADIUS_KM * 2
      const widthKm = TERRAIN_RADIUS_KM * 2 * cosLat
      const maxSideKm = Math.max(widthKm, heightKm)
      const tileZoom = adaptiveZoomForArea(maxSideKm)

      const region: Region = {
        id: `scan2-${Date.now()}`,
        name: 'Scan2 Area',
        bounds,
        center: { lat, lng },
        description: `Immersive terrain view at ${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      }

      log.info('Loading terrain for Scan2', {
        lat: lat.toFixed(4),
        lng: lng.toFixed(4),
        radiusKm: TERRAIN_RADIUS_KM,
        tileZoom,
      })

      try {
        // Load elevation data
        const elevations = await loadRegionElevation(
          region,
          TERRAIN_GRID_SIZE,
          (p) => {
            if (!cancelled) {
              setLoadingProgress(p * 80)  // 80% for tile loading
              setLoadingMessage(p < 0.5 ? 'Fetching elevation tiles...' : 'Processing terrain...')
            }
          },
          tileZoom,
        )

        if (cancelled) return

        // Compute elevation stats
        let minElev = Infinity
        let maxElev = -Infinity
        for (let i = 0; i < elevations.length; i++) {
          if (elevations[i] < minElev) minElev = elevations[i]
          if (elevations[i] > maxElev) maxElev = elevations[i]
        }

        const lat0 = (bounds.north + bounds.south) / 2
        const MPD_LON = ENU_M_PER_DEG_LON_AT_LAT(lat0)
        const worldWidth_km = (bounds.east - bounds.west) * MPD_LON / 1000
        const worldDepth_km = (bounds.north - bounds.south) * ENU_M_PER_DEG_LAT / 1000

        const mesh: TerrainMeshData = {
          width: TERRAIN_GRID_SIZE,
          height: TERRAIN_GRID_SIZE,
          elevations,
          minElevation_m: minElev,
          maxElevation_m: maxElev,
          worldWidth_km,
          worldDepth_km,
          bounds,
        }

        setMeshData(mesh)
        setLoadingProgress(85)
        setLoadingMessage('Building 3D mesh...')

        // Build the 3D mesh
        const renderer = rendererRef.current
        if (renderer) {
          renderer.buildTerrain(mesh, VERTICAL_EXAGGERATION)

          // Build contour lines
          const contourElevations = calculateContourElevations(minElev, maxElev)
          renderer.buildContourLines(mesh, contourElevations, VERTICAL_EXAGGERATION)

          // Initial camera
          renderer.updateFirstPersonCamera(heading, pitch, heightM, fov, VERTICAL_EXAGGERATION)
          renderer.render()
        }

        setLoadingProgress(90)
        setLoadingMessage('Loading peaks...')

        // Fetch peaks
        try {
          const fetchedPeaks = await fetchPeaksNear(lat, lng, PEAK_SEARCH_RADIUS_KM)
          if (!cancelled) {
            setPeaks(fetchedPeaks)
            log.info('Peaks loaded', { count: fetchedPeaks.length })
          }
        } catch (err) {
          log.warn('Failed to fetch peaks', err)
        }

        if (!cancelled) {
          setLoadingProgress(100)
          setLoadingMessage('Ready')
          setIsLoading(false)
        }

      } catch (err) {
        log.error('Failed to load terrain', err)
        if (!cancelled) {
          setLoadingMessage('Failed to load terrain')
          setIsLoading(false)
        }
      }
    }

    loadTerrain()
    return () => { cancelled = true }
  }, [activeLat, activeLng])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render loop (driven by state changes) ────────────────────────────────
  const renderFrame = useCallback(() => {
    const renderer = rendererRef.current
    if (!renderer || !meshData) return

    renderer.updateFirstPersonCamera(heading, pitch, heightM, fov, VERTICAL_EXAGGERATION)
    renderer.render()

    // Project peaks to screen
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const containerW = container.clientWidth
    const containerH = container.clientHeight

    const projected: PeakScreenPos[] = []
    for (const peak of peaks) {
      const result = renderer.projectLatLngToScreen(
        peak.lat, peak.lng, peak.elevation_m,
        meshData.bounds,
        VERTICAL_EXAGGERATION,
        containerW, containerH,
      )
      if (!result) continue

      // Off-screen culling
      if (result.sx < -80 || result.sx > containerW + 80) continue
      if (result.sy < -60 || result.sy > containerH + 60) continue

      const bearing = calculateBearing(
        { lat: activeLat, lng: activeLng },
        { lat: peak.lat, lng: peak.lng },
      )

      projected.push({
        name: peak.name,
        elevation_m: peak.elevation_m,
        bearing,
        dist_km: result.dist_m / 1000,
        screenX: result.sx,
        screenY: result.sy,
      })
    }

    // Sort by distance (far first so near labels render on top)
    projected.sort((a, b) => b.dist_km - a.dist_km)

    // Horizontal deduplication — skip labels too close to an already-placed one
    const dedupMinX = containerW * 0.08
    const visible: PeakScreenPos[] = []
    for (const p of projected) {
      const tooClose = visible.some(v => Math.abs(v.screenX - p.screenX) < dedupMinX)
      if (!tooClose && visible.length < MAX_VISIBLE_PEAKS) {
        visible.push(p)
      }
    }

    setPeakPositions(visible)
  }, [heading, pitch, heightM, fov, meshData, peaks, activeLat, activeLng])

  useEffect(() => {
    rafId.current = requestAnimationFrame(renderFrame)
  }, [renderFrame])

  // ── Drag controls (heading + pitch) ──────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Don't capture if it's on the height slider
    if (isDraggingSlider.current) return

    isDraggingView.current = true
    lastPointer.current = { x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)

    // Hide drag hint after first drag
    if (dragHintVisible) setDragHintVisible(false)
  }, [dragHintVisible])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDraggingView.current) return

    const dx = e.clientX - lastPointer.current.x
    const dy = e.clientY - lastPointer.current.y
    lastPointer.current = { x: e.clientX, y: e.clientY }

    // Negate dx so drag-right pans view right (natural direction)
    setHeading(prev => {
      let h = prev - dx * DRAG_SENSITIVITY_X
      while (h < 0) h += 360
      while (h >= 360) h -= 360
      return h
    })

    setPitch(prev => clamp(prev + dy * DRAG_SENSITIVITY_Y, -85, 85))
  }, [])

  const handlePointerUp = useCallback(() => {
    isDraggingView.current = false
  }, [])

  // ── Height slider controls ───────────────────────────────────────────────
  const handleSliderPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    isDraggingSlider.current = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    updateHeightFromPointer(e.clientY)
  }, [])

  const handleSliderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDraggingSlider.current) return
    updateHeightFromPointer(e.clientY)
  }, [])

  const handleSliderPointerUp = useCallback(() => {
    isDraggingSlider.current = false
  }, [])

  const updateHeightFromPointer = useCallback((clientY: number) => {
    const track = sliderRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    // Inverted: top = max height, bottom = min height
    const t = 1 - clamp((clientY - rect.top) / rect.height, 0, 1)
    // Logarithmic scale for more control at low heights
    const logMin = Math.log(MIN_HEIGHT_M)
    const logMax = Math.log(MAX_HEIGHT_M)
    const h = Math.exp(logMin + t * (logMax - logMin))
    setHeightM(clamp(h, MIN_HEIGHT_M, MAX_HEIGHT_M))
  }, [])

  // ── Compass strip ────────────────────────────────────────────────────────
  const compassOffset = useMemo(() => {
    // Each direction spans COMPASS_ITEM_WIDTH pixels
    // Total width = 16 directions × width
    const totalWidth = COMPASS_DIRECTIONS.length * COMPASS_ITEM_WIDTH
    // Center the current heading
    const headingFraction = heading / 360
    return -(headingFraction * totalWidth)
  }, [heading])

  // ── Ground elevation ─────────────────────────────────────────────────────
  const groundElev = rendererRef.current?.getGroundElevation() ?? 0

  // ── Height slider fraction ───────────────────────────────────────────────
  const heightFraction = useMemo(() => {
    const logMin = Math.log(MIN_HEIGHT_M)
    const logMax = Math.log(MAX_HEIGHT_M)
    const logH = Math.log(heightM)
    return (logH - logMin) / (logMax - logMin)
  }, [heightM])

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className={styles.screen} ref={containerRef}>
      {/* ── WebGL Canvas ────────────────────────────────────────────────── */}
      <div
        className={styles.viewport}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <canvas ref={canvasRef} className={styles.terrainCanvas} />
      </div>

      {/* ── Compass Strip ───────────────────────────────────────────────── */}
      <div className={styles.compassStrip}>
        <div className={styles.compassNotch} />
        <span className={styles.headingDegrees}>{Math.round(heading)}°</span>
        <div
          className={styles.compassTrack}
          style={{ transform: `translateX(calc(50vw - ${COMPASS_ITEM_WIDTH / 2}px + ${compassOffset}px))` }}
        >
          {/* Render 3 copies for seamless wrapping */}
          {[0, 1, 2].map(copy => (
            <React.Fragment key={copy}>
              {COMPASS_DIRECTIONS.map((dir, i) => {
                const isCardinal = i % 4 === 0
                return (
                  <div
                    key={`${copy}-${dir}`}
                    className={styles.compassItem}
                    style={{ width: COMPASS_ITEM_WIDTH }}
                  >
                    <span className={`${styles.compassLabel} ${isCardinal ? styles.compassLabelCardinal : ''}`}>
                      {dir}
                    </span>
                    <span className={`${styles.compassTick} ${isCardinal ? styles.compassTickCardinal : ''}`} />
                  </div>
                )
              })}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* ── Loading Overlay ─────────────────────────────────────────────── */}
      {isLoading && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingBar}>
            <div
              className={styles.loadingFill}
              style={{ width: `${loadingProgress}%` }}
            />
          </div>
          <span className={styles.loadingLabel}>{loadingMessage}</span>
        </div>
      )}

      {/* ── Peak Labels ─────────────────────────────────────────────────── */}
      {!isLoading && (
        <div className={styles.peakLabelsLayer}>
          {peakPositions.map((pos, i) => {
            const distFade = Math.max(0.3, 1 - Math.pow(pos.dist_km / PEAK_SEARCH_RADIUS_KM, 0.5))
            const canvasH = containerRef.current?.clientHeight ?? 0
            const isNearTop = pos.screenY < canvasH * 0.22

            const card = (
              <div className={styles.peakCard}>
                <span className={styles.peakName}>{pos.name}</span>
                <span className={styles.peakElev}>{formatElevation(pos.elevation_m, units)}</span>
                <span className={styles.peakBearing}>
                  {headingToCompass(pos.bearing)} · {pos.dist_km.toFixed(0)} km
                </span>
              </div>
            )

            const DOT_HALF = 3.5
            const posStyle: React.CSSProperties = isNearTop
              ? { left: `${pos.screenX}px`, top: `${pos.screenY - DOT_HALF}px`, opacity: distFade }
              : { left: `${pos.screenX}px`, bottom: `${canvasH - pos.screenY - DOT_HALF}px`, opacity: distFade }

            return (
              <div key={i} className={styles.peakLabel} style={posStyle}>
                {isNearTop ? (
                  <>
                    <div className={styles.peakDot} />
                    <div className={`${styles.peakLine} ${styles.peakLineDown}`} />
                    {card}
                  </>
                ) : (
                  <>
                    {card}
                    <div className={styles.peakLine} />
                    <div className={styles.peakDot} />
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Height Slider ───────────────────────────────────────────────── */}
      <div className={styles.heightSlider}>
        <span className={styles.heightSliderLabel}>HIGH</span>
        <div
          ref={sliderRef}
          className={styles.heightSliderTrack}
          onPointerDown={handleSliderPointerDown}
          onPointerMove={handleSliderPointerMove}
          onPointerUp={handleSliderPointerUp}
          onPointerCancel={handleSliderPointerUp}
        >
          <div
            className={styles.heightSliderFill}
            style={{ height: `${heightFraction * 100}%` }}
          />
          <div
            className={styles.heightSliderThumb}
            style={{ bottom: `${heightFraction * 100}%` }}
          />
        </div>
        <span className={styles.heightSliderLabel}>LOW</span>
        <span className={styles.heightSliderValue}>
          {units === 'imperial'
            ? `${Math.round(metersToFeet(heightM))}ft`
            : `${Math.round(heightM)}m`}
        </span>
      </div>

      {/* ── Drag Hint ───────────────────────────────────────────────────── */}
      <div className={`${styles.dragHint} ${!dragHintVisible ? styles.dragHintHidden : ''}`}>
        Drag to look around
      </div>

      {/* ── HUD Bar ─────────────────────────────────────────────────────── */}
      <div className={styles.hud}>
        <div className={styles.hudItem}>
          <span className={styles.hudLabel}>HEADING</span>
          <span className={styles.hudValue}>
            {headingToCompass(heading)} {Math.round(heading)}°
          </span>
        </div>
        <div className={styles.hudDivider} />
        <div className={styles.hudItem}>
          <span className={styles.hudLabel}>GROUND</span>
          <span className={styles.hudValue}>
            {formatElevation(groundElev, units)}
          </span>
        </div>
        <div className={styles.hudDivider} />
        <div className={styles.hudItem}>
          <span className={styles.hudLabel}>EYE AGL</span>
          <span className={styles.hudValue}>
            {units === 'imperial'
              ? `${Math.round(metersToFeet(heightM))} ft`
              : `${Math.round(heightM)} m`}
          </span>
        </div>
        <div className={styles.hudDivider} />
        <div className={styles.hudItem}>
          <span className={styles.hudLabel}>PITCH</span>
          <span className={styles.hudValue}>{pitch > 0 ? '+' : ''}{Math.round(pitch)}°</span>
        </div>
      </div>

      {/* ── Back Link ───────────────────────────────────────────────────── */}
      <Link to="/" className={styles.backLink}>← Back</Link>
    </div>
  )
}

export default Scan2Screen
