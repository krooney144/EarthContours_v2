/**
 * EarthContours — SCAN Screen (Placeholder)
 *
 * First-person panoramic skyline view with 360° ridgeline rendering.
 * This is a placeholder pending the scan rework in the next phase.
 * Includes current location button and AGL height slider.
 */

import React, { useCallback, useState, useRef } from 'react'
import { useCameraStore, useLocationStore, useSettingsStore } from '../../store'
import { createLogger } from '../../core/logger'
import { metersToFeet, feetToMeters } from '../../core/utils'
import { MIN_HEIGHT_M, MAX_HEIGHT_M } from '../../core/constants'
import styles from './ScanScreen.module.css'

const log = createLogger('SCREEN:SCAN')

const ScanScreen: React.FC = () => {
  const { height_m, setHeightFromSlider, getHeightFt } = useCameraStore()
  const { gpsPermission, gpsLat, requestGPS, switchToGPS, activeLat, activeLng } = useLocationStore()
  const { units } = useSettingsStore()

  const [gpsPrompt, setGpsPrompt] = useState<string | null>(null)

  // ── AGL Slider (debounced) ───────────────────────────────────────────────

  const sliderDebounceRef = useRef<number | null>(null)
  const SLIDER_STEP_FT = 10  // Minimum step size in feet

  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const rawFt = Number(e.target.value)
    // Snap to step
    const snappedFt = Math.round(rawFt / SLIDER_STEP_FT) * SLIDER_STEP_FT

    // Debounce the actual store update
    if (sliderDebounceRef.current !== null) {
      cancelAnimationFrame(sliderDebounceRef.current)
    }
    sliderDebounceRef.current = requestAnimationFrame(() => {
      setHeightFromSlider(snappedFt)
      sliderDebounceRef.current = null
    })
  }, [setHeightFromSlider])

  // ── Current Location ───────────────────────────────────────────────────────

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
    // Granted — switch to GPS mode
    switchToGPS()
    log.info('Scan: switched to GPS location')
  }, [gpsPermission, requestGPS, switchToGPS])

  const heightFt = getHeightFt()
  const minFt = Math.round(metersToFeet(MIN_HEIGHT_M))
  const maxFt = Math.round(metersToFeet(MAX_HEIGHT_M))

  return (
    <div className={styles.screen}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerTitle}>SCAN</div>
        <div className={styles.headerSubtitle}>
          {activeLat.toFixed(4)}°, {activeLng.toFixed(4)}°
        </div>
      </div>

      {/* Placeholder content */}
      <div className={styles.placeholder}>
        <div className={styles.placeholderIcon}>◉</div>
        <div className={styles.placeholderTitle}>Scan View</div>
        <div className={styles.placeholderText}>
          360° panoramic skyline with ridgeline rendering.
          Full implementation coming in next phase.
        </div>
      </div>

      {/* AGL Height Slider (vertical) */}
      <div className={styles.aglSlider}>
        <div className={styles.aglLabel}>AGL</div>
        <input
          type="range"
          className={styles.aglRange}
          min={minFt}
          max={maxFt}
          step={SLIDER_STEP_FT}
          value={heightFt}
          onChange={handleSliderChange}
          aria-label="Eye height above ground"
        />
        <div className={styles.aglValue}>
          {units === 'imperial' ? `${heightFt} ft` : `${Math.round(height_m)} m`}
        </div>
      </div>

      {/* Current Location Button */}
      <button
        className={`${styles.locationBtn} ${gpsLat !== null ? styles.locationActive : ''}`}
        onClick={handleMyLocation}
        aria-label="Center on my GPS location"
        title="My Location"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="9" cy="9" r="4" />
          <circle cx="9" cy="9" r="1.5" fill="currentColor" />
          <line x1="9" y1="1" x2="9" y2="4" />
          <line x1="9" y1="14" x2="9" y2="17" />
          <line x1="1" y1="9" x2="4" y2="9" />
          <line x1="14" y1="9" x2="17" y2="9" />
        </svg>
      </button>

      {/* GPS Prompt */}
      {gpsPrompt && (
        <div className={styles.gpsPrompt} role="status">
          {gpsPrompt}
        </div>
      )}
    </div>
  )
}

export default ScanScreen
