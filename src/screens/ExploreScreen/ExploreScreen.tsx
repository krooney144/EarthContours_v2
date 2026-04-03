/**
 * EarthContours — EXPLORE Screen  (v3.1 — Custom bounds + debug panel)
 *
 * 3D terrain view with solid mesh surface. PlaneGeometry displaced by
 * elevation heightmap, vertex-colored with ocean-depth palette, lit by
 * directional + ambient lights.
 *
 * v3.1 additions:
 *   - Re-center button to reset orbit camera to default position
 *   - Debug panel showing bounds, peaks/lakes/rivers counts, tile zoom
 *   - Loading progress for custom bounds from MAP screen
 *
 * Navigation (desktop):
 *   Left drag        → pan across terrain
 *   Right drag       → rotate / tilt camera angle
 *   Scroll wheel     → zoom in / out
 *   Double-click     → fly to that terrain location
 *
 * Navigation (mobile / touch — Google Earth style):
 *   1 finger drag    → orbit (rotate + tilt camera angle)
 *   2 finger drag    → pan across terrain
 *   2 finger pinch   → zoom in / out
 *   2 finger twist   → rotate view (theta)
 *   Double-tap       → fly to that terrain location
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavigateHint } from '../../components/NavigateHint/NavigateHint'
import { TutorialOverlay } from '../../components/TutorialOverlay/TutorialOverlay'
import {
  useCameraStore, useTerrainStore, useSettingsStore, useLocationStore, useUIStore,
} from '../../store'
import { createLogger } from '../../core/logger'
import { formatElevation } from '../../core/utils'
import { TerrainRenderer } from '../../renderer/TerrainRenderer'
import type { Peak, TerrainMeshData } from '../../core/types'
import styles from './ExploreScreen.module.css'

const log = createLogger('SCREEN:EXPLORE')

// ─── Main Component ───────────────────────────────────────────────────────────

const ExploreScreen: React.FC = () => {
  const {
    orbitTheta, orbitPhi, orbitRadius,
    orbitPanX, orbitPanZ,
    applyOrbitDrag, applyOrbitPan, applyOrbitZoom, setOrbitPan,
    initOrbitCamera, resetOrbitCamera,
  } = useCameraStore()

  const {
    peaks, meshData, contourElevations, activeRegion, isRealElevation,
    waterBodies, rivers, glaciers, coastlines, terrainZoom, isCustomBounds,
    loadingState, loadingProgress, loadingMessage,
  } = useTerrainStore()
  const {
    units, showPeakLabels, verticalExaggeration, setVerticalExaggeration,
    showLakes, showRivers, showGlaciers, showCoastlines,
  } = useSettingsStore()
  const { activeLat, activeLng, mode, gpsPermission, gpsLat, requestGPS, switchToGPS } = useLocationStore()

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const rendererRef  = useRef<TerrainRenderer | null>(null)

  const pointerMapRef     = useRef<Map<number, { x: number; y: number }>>(new Map())
  const lastPinchDistRef  = useRef(0)
  const lastPinchAngleRef = useRef(0)
  const isRightClickRef   = useRef(false)

  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  const [showDebug, setShowDebug] = useState(false)
  const [geoCounts, setGeoCounts] = useState({ lakeCount: 0, riverCount: 0, glacierCount: 0, coastlineCount: 0 })

  // Throttled camera tick — HTML overlays (peak labels) update at ~8fps max
  // while the Three.js canvas renders at full 60fps. Prevents layout thrashing.
  const [labelTick, setLabelTick] = useState(0)
  const labelThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    // Clear any pending tick so the latest camera state is always picked up
    if (labelThrottleRef.current) clearTimeout(labelThrottleRef.current)
    labelThrottleRef.current = setTimeout(() => {
      setLabelTick(t => t + 1)
      labelThrottleRef.current = null
    }, 120)
  }, [orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ])

  const tutorialScreen = useUIStore((s) => s.tutorialScreen)
  const [gpsPrompt, setGpsPrompt] = useState<string | null>(null)

  const [showHint, setShowHint] = useState<boolean>(() => {
    try { return !localStorage.getItem('ec_explore_hint_seen') } catch { return true }
  })

  const dismissHint = useCallback(() => {
    setShowHint(false)
    try { localStorage.setItem('ec_explore_hint_seen', '1') } catch { /* ignore */ }
  }, [])

  // ── Current location handler ─────────────────────────────────────────────

  const handleMyLocation = useCallback(async () => {
    if (gpsPermission === 'denied') {
      setGpsPrompt('Location access denied. Enable in device settings.')
      setTimeout(() => setGpsPrompt(null), 4000)
      return
    }
    if (gpsPermission === 'unavailable') {
      setGpsPrompt('GPS not available on this device.')
      setTimeout(() => setGpsPrompt(null), 4000)
      return
    }
    if (gpsPermission === 'unknown') {
      setGpsPrompt('Requesting location access...')
      await requestGPS()
      setTimeout(() => setGpsPrompt(null), 3000)
      return
    }
    switchToGPS()
    log.info('Explore: switched to GPS location')
  }, [gpsPermission, requestGPS, switchToGPS])

  // ── Re-center handler ────────────────────────────────────────────────────

  const handleRecenter = useCallback(() => {
    if (meshData) {
      const terrainWidth_m = meshData.worldWidth_km * 1000
      initOrbitCamera(terrainWidth_m)
      log.info('Camera re-centered on terrain')
    } else {
      resetOrbitCamera()
    }
  }, [meshData, initOrbitCamera, resetOrbitCamera])

  // ── Initialize Three.js renderer ─────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const renderer = new TerrainRenderer()
    renderer.initialize(canvas)
    rendererRef.current = renderer

    // Initial size
    const rect = container.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      renderer.resize(rect.width, rect.height)
      setContainerSize({ w: rect.width, h: rect.height })
    }

    log.info('Three.js renderer initialized')

    return () => {
      renderer.dispose()
      rendererRef.current = null
      log.info('Three.js renderer disposed')
    }
  }, [])

  // ── Init camera when terrain loads ─────────────────────────────────────────

  useEffect(() => {
    if (!meshData) return
    const terrainWidth_m = meshData.worldWidth_km * 1000
    initOrbitCamera(terrainWidth_m)
    log.info('Camera initialised for new terrain', { terrainWidth_m })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meshData])  // intentionally omit initOrbitCamera — stable store action

  // ── Build terrain mesh when data loads or exaggeration changes ─────────────

  const lastExaggerationRef = useRef<number>(0)

  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer || !renderer.isReady() || !meshData) return

    if (lastExaggerationRef.current !== 0 && lastExaggerationRef.current !== verticalExaggeration) {
      // Just update vertex positions — no full rebuild
      renderer.updateExaggeration(meshData, verticalExaggeration)
    } else {
      renderer.buildTerrain(meshData, verticalExaggeration)
    }
    // Build contour lines on top of the solid mesh
    if (contourElevations.length > 0) {
      renderer.buildContourLines(meshData, contourElevations, verticalExaggeration)
    }
    lastExaggerationRef.current = verticalExaggeration
  }, [meshData, verticalExaggeration, contourElevations])

  // ── Build geo overlays (rivers, lakes, glaciers, coastlines) ──────────────

  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer || !renderer.isReady() || !meshData) {
      setGeoCounts({ lakeCount: 0, riverCount: 0, glacierCount: 0, coastlineCount: 0 })
      return
    }
    const counts = renderer.buildGeoOverlays(
      meshData, verticalExaggeration,
      waterBodies, rivers, glaciers, coastlines,
      { showLakes, showRivers, showGlaciers, showCoastlines },
    )
    setGeoCounts(counts)
  }, [meshData, verticalExaggeration, waterBodies, rivers, glaciers, coastlines,
      showLakes, showRivers, showGlaciers, showCoastlines])

  // ── Render loop: update camera + render on every state change ──────────────

  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer || !renderer.isReady()) return

    renderer.updateCamera(orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ)
    renderer.render()
  }, [orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ, meshData, verticalExaggeration])

  // ── Resize observer ────────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        const renderer = rendererRef.current
        if (renderer) {
          renderer.resize(rect.width, rect.height)
          renderer.render()
        }
        setContainerSize({ w: rect.width, h: rect.height })
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ── Wheel zoom (non-passive) ───────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      applyOrbitZoom(e.deltaY > 0 ? 1 : -1)
    }
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [applyOrbitZoom])

  // ── Pointer handlers ───────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    containerRef.current?.setPointerCapture(e.pointerId)
    pointerMapRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (e.button === 2) isRightClickRef.current = true
    if (pointerMapRef.current.size === 2) {
      const pts = Array.from(pointerMapRef.current.values()) as { x: number; y: number }[]
      const dx = pts[1].x - pts[0].x
      const dy = pts[1].y - pts[0].y
      lastPinchDistRef.current  = Math.sqrt(dx * dx + dy * dy)
      lastPinchAngleRef.current = Math.atan2(dy, dx)
    }
    dismissHint()
  }, [dismissHint])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const prev = pointerMapRef.current.get(e.pointerId)
    if (!prev) return
    const pointerCount = pointerMapRef.current.size
    pointerMapRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointerCount >= 2) {
      const pts   = Array.from(pointerMapRef.current.values()) as { x: number; y: number }[]
      const dx    = pts[1].x - pts[0].x
      const dy    = pts[1].y - pts[0].y
      const dist  = Math.sqrt(dx * dx + dy * dy)
      const angle = Math.atan2(dy, dx)

      const distDelta = dist - lastPinchDistRef.current
      if (Math.abs(distDelta) > 0.5) {
        applyOrbitZoom(distDelta > 0 ? -0.2 : 0.2)
        lastPinchDistRef.current = dist
      }

      const angleDelta = angle - lastPinchAngleRef.current
      if (Math.abs(angleDelta) > 0.005) {
        applyOrbitDrag(angleDelta * 60, 0)
        lastPinchAngleRef.current = angle
      }

      // Dampen 2-finger pan for touch — raw deltas move terrain too fast
      const panDamping = e.pointerType === 'touch' ? 0.35 : 1
      applyOrbitPan((e.clientX - prev.x) * panDamping, (e.clientY - prev.y) * panDamping)
    } else {
      const deltaX = e.clientX - prev.x
      const deltaY = e.clientY - prev.y

      const isTouch = e.pointerType === 'touch'
      if (isTouch || isRightClickRef.current || e.buttons === 2) {
        // Touch drags produce larger deltas than mouse — dampen to avoid oversensitivity
        const damping = isTouch ? 0.5 : 1
        applyOrbitDrag(deltaX * damping, deltaY * damping)
      } else {
        applyOrbitPan(deltaX, deltaY)
      }
    }
  }, [applyOrbitDrag, applyOrbitPan, applyOrbitZoom])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    containerRef.current?.releasePointerCapture(e.pointerId)
    pointerMapRef.current.delete(e.pointerId)
    if (e.button === 2) isRightClickRef.current = false
  }, [])

  // ── Double-click: fly to terrain point (raycast) ───────────────────────────

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current
    const renderer = rendererRef.current
    if (!container || !renderer || !meshData) return

    const rect = container.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    const hit = renderer.raycastTerrain(sx, sy, rect.width, rect.height)
    if (hit) {
      const tw = renderer.getTerrainWidth()
      const td = renderer.getTerrainDepth()
      if (tw > 0 && td > 0) {
        setOrbitPan(hit.x / tw, hit.z / td)
        // Zoom in 20% closer for a visible fly-to effect
        const currentRadius = useCameraStore.getState().orbitRadius
        useCameraStore.setState({ orbitRadius: currentRadius * 0.8 })
        log.debug('Fly-to raycast hit', {
          x: hit.x.toFixed(0), z: hit.z.toFixed(0),
          panX: (hit.x / tw).toFixed(3),
          panZ: (hit.z / td).toFixed(3),
        })
      }
    }
  }, [meshData, setOrbitPan])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  // ── Location pin screen position ───────────────────────────────────────────

  const locationPinScreen = useMemo((): { sx: number; sy: number } | null => {
    const renderer = rendererRef.current
    if (!meshData || !containerSize.w || mode !== 'exploring' || !renderer) return null

    const { bounds, minElevation_m, elevations, width, height } = meshData

    const LAT_TOL = (bounds.north - bounds.south) * 0.02
    const LNG_TOL = (bounds.east  - bounds.west)  * 0.02
    if (
      activeLat < bounds.south - LAT_TOL || activeLat > bounds.north + LAT_TOL ||
      activeLng < bounds.west  - LNG_TOL || activeLng > bounds.east  + LNG_TOL
    ) return null

    const col  = Math.round((activeLng - bounds.west)  / (bounds.east  - bounds.west)  * (width  - 1))
    const row  = Math.round((bounds.north - activeLat) / (bounds.north - bounds.south) * (height - 1))
    const c    = Math.max(0, Math.min(width  - 1, col))
    const r    = Math.max(0, Math.min(height - 1, row))
    const elev = elevations[r * width + c] ?? minElevation_m

    return renderer.projectToScreen(
      meshData, c, r, elev, verticalExaggeration,
      containerSize.w, containerSize.h,
    )
  }, [
    meshData, activeLat, activeLng, mode,
    orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ,
    verticalExaggeration, containerSize,
  ])

  // ── Derived values (safe even when meshData is null) ──────────────────────

  const minElevation_m = meshData?.minElevation_m ?? 0
  const maxElevation_m = meshData?.maxElevation_m ?? 0
  const bounds = meshData?.bounds ?? { north: 0, south: 0, east: 0, west: 0 }
  const isLoading = !meshData

  // ── Exaggeration options for inline selector ────────────────────────────

  const EXAG_OPTIONS: Array<{ value: 1 | 1.5 | 2 | 4 | 10; label: string }> = [
    { value: 1,   label: '1x'   },
    { value: 1.5, label: '1.5x' },
    { value: 2,   label: '2x'   },
    { value: 4,   label: '4x'   },
    { value: 10,  label: '10x'  },
  ]

  return (
    <div className={styles.screen}>
      {/* ── Loading overlay — always on top, doesn't unmount the canvas ──── */}
      {isLoading && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingContent}>
            {loadingState === 'error' ? (
              <>
                <div className={styles.loadingMessage}>
                  {loadingMessage || 'Failed to load elevation data'}
                </div>
                <div className={styles.loadingHint}>
                  Check your network connection and try again
                </div>
              </>
            ) : (
              <>
                <div className={styles.loadingMessage}>
                  {loadingMessage || 'LOADING TERRAIN...'}
                </div>
                {loadingProgress > 0 && (
                  <div className={styles.loadingBarTrack}>
                    <div
                      className={styles.loadingBarFill}
                      style={{ width: `${loadingProgress}%` }}
                    />
                  </div>
                )}
                <div className={styles.loadingHint}>
                  Select an area on the Map screen to explore any location in 3D
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <div className={styles.header}>
        <div>
          <div className={styles.headerTitle}>EXPLORE</div>
          {activeRegion && (
            <div className={styles.regionName}>
              {isCustomBounds ? '3D Explore View' : activeRegion.name}
            </div>
          )}
        </div>
        <div
          className={`${styles.dataSourceBadge} ${isRealElevation ? styles.dataSourceReal : styles.dataSourceSim}`}
          aria-label={isRealElevation ? 'Real elevation data from AWS Terrain Tiles' : 'Simulated procedural terrain'}
        >
          {isRealElevation ? '● REAL DATA' : '◌ SIMULATED'}
        </div>
      </div>

      {/* Compass rose — rotates with camera theta */}
      <div
        className={styles.compass}
        style={{ transform: `rotate(${orbitTheta}rad)` }}
        aria-label={`Compass: North is ${(((-orbitTheta * 180 / Math.PI) % 360 + 360) % 360).toFixed(0)}° from top`}
      >
        <svg className={styles.compassRing} viewBox="0 0 100 100" aria-hidden="true">
          {/* Outer circle */}
          <circle cx="50" cy="50" r="39" fill="none" stroke="var(--ec-glow)" strokeWidth="1.2" opacity="0.45" />
          {/* Inner circle */}
          <circle cx="50" cy="50" r="14" fill="none" stroke="var(--ec-glow)" strokeWidth="0.8" opacity="0.3" />

          {/* 8-point star — generated programmatically for precise geometry */}
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
            const isCardinal = deg % 90 === 0
            const tipR = isCardinal ? 38 : 26
            const halfW = isCardinal ? 3.5 : 3
            const rad = (deg * Math.PI) / 180
            const sin = Math.sin(rad)
            const cos = Math.cos(rad)
            // Tip of the point
            const tx = 50 + tipR * sin
            const ty = 50 - tipR * cos
            // Base sides — perpendicular to the point's axis at center
            const cwX = 50 + halfW * cos
            const cwY = 50 + halfW * sin
            const ccwX = 50 - halfW * cos
            const ccwY = 50 - halfW * sin
            const darkOpacity = isCardinal ? 0.9 : 0.8
            const blueOpacity = isCardinal ? 0.65 : 0.45
            return (
              <g key={deg}>
                <polygon
                  points={`${tx},${ty} ${cwX},${cwY} 50,50`}
                  fill="var(--ec-bg-primary)" opacity={darkOpacity}
                  stroke="var(--ec-glow)" strokeWidth="0.3" strokeOpacity="0.3"
                />
                <polygon
                  points={`${tx},${ty} ${ccwX},${ccwY} 50,50`}
                  fill="var(--ec-glow)" opacity={blueOpacity}
                  stroke="var(--ec-glow)" strokeWidth="0.3" strokeOpacity="0.3"
                />
              </g>
            )
          })}

          {/* Center dot */}
          <circle cx="50" cy="50" r="2.5" fill="var(--ec-glow)" opacity="0.5" />
        </svg>
        <span className={`${styles.compassLabel} ${styles.compassN}`}>N</span>
        <span className={styles.compassLabel} style={{ bottom: -2, left: '50%', transform: 'translateX(-50%)' }}>S</span>
        <span className={styles.compassLabel} style={{ left: -1, top: '50%', transform: 'translateY(-50%)' }}>W</span>
        <span className={styles.compassLabel} style={{ right: -1, top: '50%', transform: 'translateY(-50%)' }}>E</span>
      </div>

      {/* 3D Canvas area — ALWAYS mounted so Three.js renderer survives reloads */}
      <div
        ref={containerRef}
        className={styles.canvasArea}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        role="application"
        aria-label="3D terrain — drag to pan, right-drag to rotate, scroll to zoom"
      >
        <canvas
          ref={canvasRef}
          className={styles.terrainCanvas}
          aria-hidden="true"
        />

        {!isLoading && showPeakLabels && containerSize.w > 0 && rendererRef.current && meshData && (
          <div className={styles.peakLabelsLayer}>
            <PeakLabels3D
              peaks={peaks}
              meshData={meshData}
              verticalExaggeration={verticalExaggeration}
              containerW={containerSize.w}
              containerH={containerSize.h}
              units={units}
              renderer={rendererRef.current}
              orbitRadius={orbitRadius}
              labelTick={labelTick}
            />
          </div>
        )}

        {locationPinScreen && (
          <div
            className={styles.locationPin}
            style={{ left: `${locationPinScreen.sx}px`, top: `${locationPinScreen.sy}px` }}
            aria-label="Selected explore location"
          >
            <div className={styles.locationPinRing} aria-hidden="true" />
            <div className={styles.locationPinDot}  aria-hidden="true" />
          </div>
        )}

        {showHint && !isLoading && tutorialScreen !== 'explore' && (
          <div
            className={styles.controlsHint}
            onClick={dismissHint}
            role="button"
            aria-label="Dismiss navigation hint"
          >
            <div className={styles.controlsHintTitle}>EXPLORE CONTROLS</div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>Drag</span>
              <span className={styles.controlsHintDesc}>Pan terrain</span>
            </div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>Right drag</span>
              <span className={styles.controlsHintDesc}>Rotate &amp; tilt</span>
            </div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>Scroll</span>
              <span className={styles.controlsHintDesc}>Zoom</span>
            </div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>1 finger</span>
              <span className={styles.controlsHintDesc}>Rotate &amp; tilt</span>
            </div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>2 fingers</span>
              <span className={styles.controlsHintDesc}>Pan &amp; zoom</span>
            </div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>Double-tap</span>
              <span className={styles.controlsHintDesc}>Fly to point</span>
            </div>
            <div className={styles.controlsHintDismiss}>tap to dismiss</div>
          </div>
        )}
      </div>

      {/* Elevation legend */}
      {!isLoading && (
        <div className={styles.legend} aria-label="Elevation color legend">
          <div className={`${styles.legendLabel} ${styles.legendTop}`}>
            {formatElevation(maxElevation_m, units)}
          </div>
          <div className={styles.legendGradient} aria-hidden="true" />
          <div className={`${styles.legendLabel} ${styles.legendBottom}`}>
            {formatElevation(minElevation_m, units)}
          </div>
        </div>
      )}

      {/* ── Vertical exaggeration selector ──────────────────────────────── */}
      {!isLoading && (
        <div className={styles.exaggerationControl}>
          <div className={styles.exaggerationLabel}>VERT</div>
          <div className={styles.exaggerationOptions}>
            {EXAG_OPTIONS.map(opt => (
              <button
                key={opt.value}
                className={`${styles.exaggerationBtn} ${verticalExaggeration === opt.value ? styles.exaggerationActive : ''}`}
                onClick={() => setVerticalExaggeration(opt.value)}
                aria-label={`Set vertical exaggeration to ${opt.label}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Re-center button */}
      {!isLoading && (
        <button
          className={styles.recenterBtn}
          onClick={handleRecenter}
          aria-label="Re-center camera on terrain"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="5" />
            <circle cx="7" cy="7" r="1.5" fill="currentColor" />
            <line x1="7" y1="0" x2="7" y2="3" />
            <line x1="7" y1="11" x2="7" y2="14" />
            <line x1="0" y1="7" x2="3" y2="7" />
            <line x1="11" y1="7" x2="14" y2="7" />
          </svg>
          RE-CENTER
        </button>
      )}

      {/* Current location button */}
      {!isLoading && (
        <button
          className={`${styles.locationBtn} ${gpsLat !== null ? styles.locationActive : ''}`}
          onClick={handleMyLocation}
          aria-label="Center on my GPS location"
          title="My Location"
        >
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="9" cy="9" r="4" />
            <circle cx="9" cy="9" r="1.5" fill="currentColor" />
            <line x1="9" y1="1" x2="9" y2="4" />
            <line x1="9" y1="14" x2="9" y2="17" />
            <line x1="1" y1="9" x2="4" y2="9" />
            <line x1="14" y1="9" x2="17" y2="9" />
          </svg>
        </button>
      )}

      {/* GPS Prompt */}
      {gpsPrompt && (
        <div className={styles.gpsPrompt} role="status">
          {gpsPrompt}
        </div>
      )}

      {/* Navigate hint */}
      {!isLoading && <NavigateHint />}

      {/* Debug toggle */}
      <button
        className={styles.debugToggle}
        onClick={() => setShowDebug(v => !v)}
        aria-label="Toggle explore debug panel"
      >
        {showDebug ? '\u2715' : '\u2299'}
      </button>

      {/* Debug panel */}
      {showDebug && (
        <div className={styles.debugPanel}>
          <strong>Explore Debug</strong><br />
          <strong>Bounds</strong><br />
          NW: {bounds.north.toFixed(4)}&deg;, {bounds.west.toFixed(4)}&deg;<br />
          NE: {bounds.north.toFixed(4)}&deg;, {bounds.east.toFixed(4)}&deg;<br />
          SE: {bounds.south.toFixed(4)}&deg;, {bounds.east.toFixed(4)}&deg;<br />
          SW: {bounds.south.toFixed(4)}&deg;, {bounds.west.toFixed(4)}&deg;<br />
          <strong>Data (in bounds / total)</strong><br />
          Peaks: {peaks.length} · Lakes: {geoCounts.lakeCount}/{waterBodies.length} · Rivers: {geoCounts.riverCount}/{rivers.length}<br />
          Glaciers: {geoCounts.glacierCount}/{glaciers.length} · Coastlines: {geoCounts.coastlineCount}/{coastlines.length}<br />
          Tile zoom: z{terrainZoom} · Grid: {meshData ? meshData.width : '—'}&times;{meshData ? meshData.height : '—'}<br />
          Source: {isCustomBounds ? 'Custom bounds' : (activeRegion?.id ?? 'none')}<br />
          Elev: {formatElevation(minElevation_m, units)} &ndash; {formatElevation(maxElevation_m, units)}<br />
          Size: {meshData ? meshData.worldWidth_km.toFixed(1) : '—'} &times; {meshData ? meshData.worldDepth_km.toFixed(1) : '—'} km<br />
          Vert. exag: {verticalExaggeration}&times;<br />
          <strong>Camera</strong><br />
          Radius: {(orbitRadius / 1000).toFixed(1)}km · Pan: {orbitPanX.toFixed(3)}, {orbitPanZ.toFixed(3)}<br />
          Theta: {(orbitTheta * 180 / Math.PI).toFixed(1)}&deg; · Phi: {(orbitPhi * 180 / Math.PI).toFixed(1)}&deg;
        </div>
      )}

      {/* Tutorial overlay */}
      <TutorialOverlay screen="explore" />
    </div>
  )
}

// ─── PeakLabels3D ─────────────────────────────────────────────────────────────

/**
 * HTML overlay that renders peak labels projected via the Three.js camera.
 * Uses TerrainRenderer.projectToScreen() so labels stay locked to the
 * terrain mesh at all zoom/pan levels.
 *
 * Collision detection: labels are placed highest-elevation-first. Each placed
 * label reserves a screen-space bounding box. Subsequent peaks that would
 * overlap get their text card hidden but still show a small dot marker.
 * As the user zooms in (smaller orbitRadius relative to terrain), more labels
 * fit on screen — mimicking the SCAN label behavior.
 */
const PeakLabels3D: React.FC<{
  peaks: Peak[]
  meshData: TerrainMeshData
  verticalExaggeration: number
  containerW: number
  containerH: number
  units: 'imperial' | 'metric'
  renderer: TerrainRenderer
  orbitRadius: number
  labelTick: number  // throttled counter — triggers re-render at ~8fps max
}> = React.memo(({ peaks, meshData, verticalExaggeration, containerW, containerH, units, renderer, orbitRadius }) => {
  const { minElevation_m, bounds, elevations, width, height } = meshData

  const SEARCH_RADIUS = 6

  // Scale max labels with zoom: closer camera → more labels visible.
  // orbitRadius / terrainWidth gives a rough "zoom fraction" (1 = full view, 0.3 = zoomed in).
  const terrainWidth_m = meshData.worldWidth_km * 1000
  const zoomFraction = terrainWidth_m > 0 ? orbitRadius / terrainWidth_m : 1
  // At full zoom-out (fraction ~0.8+): show up to 6 labels
  // At medium zoom (fraction ~0.4): show up to 10
  // At close zoom (fraction ~0.2): show up to 15
  const maxLabels = Math.round(Math.max(4, Math.min(15, 18 - zoomFraction * 15)))

  // Sort by elevation, take a generous candidate pool
  const candidates = [...peaks]
    .sort((a, b) => b.elevation_m - a.elevation_m)
    .slice(0, 30)

  // Approximate label card dimensions in pixels for collision detection
  const LABEL_W = 140
  const LABEL_H = 48
  const DOT_MARGIN = 12  // minimum spacing for dot-only markers

  // Track placed bounding boxes: { x, y, w, h }
  const placedBoxes: Array<{ x: number; y: number; w: number; h: number }> = []

  const rectsOverlap = (
    ax: number, ay: number, aw: number, ah: number,
    bx: number, by: number, bw: number, bh: number,
  ) => ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by

  type PlacedPeak = {
    peak: Peak
    sx: number
    sy: number
    bestElev: number
    showLabel: boolean
  }

  const placed: PlacedPeak[] = []

  for (const peak of candidates) {
    if (placed.length >= maxLabels + 10) break  // enough dots + labels

    const LAT_TOL = (bounds.north - bounds.south) * 0.02
    const LNG_TOL = (bounds.east  - bounds.west)  * 0.02
    if (
      peak.lat < bounds.south - LAT_TOL || peak.lat > bounds.north + LAT_TOL ||
      peak.lng < bounds.west  - LNG_TOL || peak.lng > bounds.east  + LNG_TOL
    ) continue

    const nomCol = Math.round((peak.lng - bounds.west)  / (bounds.east  - bounds.west)  * (width  - 1))
    const nomRow = Math.round((bounds.north - peak.lat) / (bounds.north - bounds.south) * (height - 1))

    let bestElev = -Infinity, bestCol = nomCol, bestRow = nomRow
    for (let dr = -SEARCH_RADIUS; dr <= SEARCH_RADIUS; dr++) {
      for (let dc = -SEARCH_RADIUS; dc <= SEARCH_RADIUS; dc++) {
        const c = Math.max(0, Math.min(width  - 1, nomCol + dc))
        const r = Math.max(0, Math.min(height - 1, nomRow + dr))
        const e = elevations[r * width + c]
        if (e > bestElev) { bestElev = e; bestCol = c; bestRow = r }
      }
    }

    const screen = renderer.projectToScreen(
      meshData, bestCol, bestRow, bestElev, verticalExaggeration,
      containerW, containerH,
    )
    if (!screen) continue

    const { sx, sy } = screen
    if (sx < -40 || sx > containerW + 40 || sy < -40 || sy > containerH + 40) continue

    // Check collision for a label card (centered horizontally, above the dot)
    const labelX = sx - LABEL_W / 2
    const labelY = sy - LABEL_H - 24  // card sits above the line+dot

    const labelsPlaced = placed.filter(p => p.showLabel).length
    let showLabel = labelsPlaced < maxLabels

    if (showLabel) {
      for (const box of placedBoxes) {
        if (rectsOverlap(labelX, labelY, LABEL_W, LABEL_H, box.x, box.y, box.w, box.h)) {
          showLabel = false
          break
        }
      }
    }

    if (showLabel) {
      placedBoxes.push({ x: labelX, y: labelY, w: LABEL_W, h: LABEL_H })
    } else {
      // Even for dot-only, check we're not right on top of another dot
      let dotTooClose = false
      for (const p of placed) {
        const dx = sx - p.sx, dy = sy - p.sy
        if (Math.sqrt(dx * dx + dy * dy) < DOT_MARGIN) { dotTooClose = true; break }
      }
      if (dotTooClose) continue
    }

    placed.push({ peak, sx, sy, bestElev, showLabel })
  }

  return (
    <>
      {placed.map(({ peak, sx, sy, bestElev, showLabel }) => (
        <div
          key={peak.id}
          className={styles.peakLabel3D}
          style={{ transform: `translate(${sx}px, ${sy}px) translate(-50%, -100%)` }}
        >
          {showLabel && (
            <>
              <div className={styles.peakLabelCard}>
                <span className={styles.peakLabelName}>{peak.name}</span>
                <span className={styles.peakLabelElev}>{formatElevation(bestElev, units)}</span>
              </div>
              <div className={styles.peakLine3D} />
            </>
          )}
          <div className={styles.peakDot3D} />
        </div>
      ))}
    </>
  )
})

export default ExploreScreen
