/**
 * TutorialOverlay — Visual cheat sheet with mini-icon anchors.
 *
 * Design principles:
 * - Semi-transparent dark overlay with light blur — controls visible underneath
 * - Mini SVG icons matching actual buttons so users know what to look for
 * - Structured, scannable blocks (icon + short label) not paragraphs
 * - Visual hierarchy: title → description → callouts top-to-bottom → close
 * - Close hint at bottom
 */

import React from 'react'
import { useUIStore } from '../../store'
import type { ScreenId } from '../../core/types'
import styles from './TutorialOverlay.module.css'

// ─── Mini Icon Components (match actual button SVGs) ────────────────────────

const IconCrosshair: React.FC = () => (
  <svg className={styles.icon} width="20" height="20" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="9" cy="9" r="4" /><circle cx="9" cy="9" r="1.5" fill="currentColor" />
    <line x1="9" y1="1" x2="9" y2="4" /><line x1="9" y1="14" x2="9" y2="17" />
    <line x1="1" y1="9" x2="4" y2="9" /><line x1="14" y1="9" x2="17" y2="9" />
  </svg>
)

const IconAreaSelect: React.FC = () => (
  <svg className={styles.icon} width="20" height="20" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="3" width="12" height="12" strokeDasharray="3 2" />
    <rect x="1.5" y="1.5" width="3" height="3" fill="currentColor" stroke="none" />
    <rect x="13.5" y="1.5" width="3" height="3" fill="currentColor" stroke="none" />
    <rect x="1.5" y="13.5" width="3" height="3" fill="currentColor" stroke="none" />
    <rect x="13.5" y="13.5" width="3" height="3" fill="currentColor" stroke="none" />
  </svg>
)

const IconRecenter: React.FC = () => (
  <svg className={styles.icon} width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="7" cy="7" r="5" /><circle cx="7" cy="7" r="1.5" fill="currentColor" />
    <line x1="7" y1="0" x2="7" y2="3" /><line x1="7" y1="11" x2="7" y2="14" />
    <line x1="0" y1="7" x2="3" y2="7" /><line x1="11" y1="7" x2="14" y2="7" />
  </svg>
)

const IconGyro: React.FC = () => (
  <svg className={styles.icon} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
    <ellipse cx="12" cy="12" rx="10" ry="10" opacity="0.5" />
    <ellipse cx="12" cy="12" rx="10" ry="5" opacity="0.7" />
    <ellipse cx="12" cy="12" rx="3.5" ry="10" opacity="0.7" />
    <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" opacity="0.9" />
  </svg>
)

const IconViewpoint: React.FC = () => (
  <svg className={styles.iconLarge} width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#84D1DB" strokeWidth="1.5">
    <circle cx="12" cy="12" r="8" opacity="0.6" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="12" cy="12" r="1.5" fill="#84D1DB" />
  </svg>
)

/** Tall vertical zoom slider preview matching actual scan slider */
const IconZoomSliderTall: React.FC = () => (
  <svg className={styles.sliderPreview} width="20" height="80" viewBox="0 0 20 80" fill="none" stroke="currentColor" strokeWidth="1">
    <text x="10" y="8" textAnchor="middle" fill="currentColor" fontSize="10" stroke="none" fontWeight="500">+</text>
    <line x1="10" y1="14" x2="10" y2="66" opacity="0.4" strokeWidth="2" />
    <circle cx="10" cy="28" r="5" fill="currentColor" opacity="0.5" />
    <text x="10" y="78" textAnchor="middle" fill="currentColor" fontSize="10" stroke="none" fontWeight="500">−</text>
  </svg>
)

/** Tall vertical height slider preview matching actual scan AGL slider */
const IconHeightSliderTall: React.FC = () => (
  <svg className={styles.sliderPreview} width="20" height="80" viewBox="0 0 20 80" fill="none" stroke="currentColor" strokeWidth="1">
    <text x="10" y="8" textAnchor="middle" fill="currentColor" fontSize="5" stroke="none">HIGH</text>
    <line x1="10" y1="14" x2="10" y2="66" opacity="0.4" strokeWidth="2" />
    <circle cx="10" cy="50" r="5" fill="currentColor" opacity="0.5" />
    <text x="10" y="78" textAnchor="middle" fill="currentColor" fontSize="5" stroke="none">LOW</text>
  </svg>
)

/** Vertical exaggeration picker preview */
const IconExagPicker: React.FC = () => (
  <div className={styles.exagPreview}>
    <span className={styles.exagLabel}>VERT</span>
    <div className={styles.exagOptions}>
      <span>1×</span>
      <span>1.5×</span>
      <span>2×</span>
      <span className={styles.exagActive}>4×</span>
      <span>10×</span>
    </div>
  </div>
)

// ─── Component ──────────────────────────────────────────────────────────────

interface TutorialOverlayProps {
  screen: ScreenId
}

export const TutorialOverlay: React.FC<TutorialOverlayProps> = ({ screen }) => {
  const tutorialScreen = useUIStore((s) => s.tutorialScreen)
  const dismissTutorial = useUIStore((s) => s.dismissTutorial)

  if (tutorialScreen !== screen) return null

  return (
    <div
      className={styles.overlay}
      onClick={dismissTutorial}
      role="dialog"
      aria-label={`${screen} tutorial`}
    >
      {screen === 'map' && <MapTutorial />}
      {screen === 'explore' && <ExploreTutorial />}
      {screen === 'scan' && <ScanTutorial />}

      {/* Dismiss — bottom center */}
      <div className={styles.dismissHint}>Tap anywhere to close tutorial</div>
    </div>
  )
}

// ─── MAP Tutorial ───────────────────────────────────────────────────────────

const MapTutorial: React.FC = () => (
  <>
    <div className={styles.titleBlock}>
      <div className={styles.title}>MAP</div>
      <div className={styles.desc}>
        Topographic elevation map — light = high, dark = sea level
      </div>
    </div>

    {/* Center — viewpoint tap */}
    <div className={styles.centerBlock}>
      <IconViewpoint />
      <div className={styles.centerLabel}>Tap anywhere to set viewpoint</div>
    </div>

    {/* Right-side callouts — aligned to actual button stack: GPS → Area → Zoom */}
    <div className={`${styles.callout} ${styles.mapGps}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Set viewpoint to GPS</span>
      </div>
      <div className={styles.btnPreview}><IconCrosshair /></div>
    </div>

    <div className={`${styles.callout} ${styles.mapArea}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Select 3D area for Explore</span>
      </div>
      <div className={styles.btnPreview}><IconAreaSelect /></div>
    </div>

    <div className={`${styles.callout} ${styles.mapZoom}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Zoom</span>
        <span className={styles.calloutSub}>Pinch · Scroll · +/−</span>
      </div>
      <div className={styles.sliderPreviewBox}><IconZoomSliderTall /></div>
    </div>
  </>
)

// ─── EXPLORE Tutorial ───────────────────────────────────────────────────────

const ExploreTutorial: React.FC = () => (
  <>
    <div className={styles.titleBlock}>
      <div className={styles.title}>EXPLORE</div>
      <div className={styles.desc}>
        3D terrain — orbit, zoom, and fly through the landscape
      </div>
    </div>

    {/* Controls table */}
    <div className={styles.controlsBox}>
      <div className={styles.controlsTitle}>CONTROLS</div>
      <div className={styles.controlRow}><span className={styles.controlKey}>Drag / 1 finger</span><span className={styles.controlVal}>Orbit &amp; tilt</span></div>
      <div className={styles.controlRow}><span className={styles.controlKey}>Right-click / 2 fingers</span><span className={styles.controlVal}>Pan</span></div>
      <div className={styles.controlRow}><span className={styles.controlKey}>Scroll / Pinch</span><span className={styles.controlVal}>Zoom</span></div>
      <div className={styles.controlRow}><span className={styles.controlKey}>Double-tap / click</span><span className={styles.controlVal}>Fly to point</span></div>
    </div>

    {/* Vertical exaggeration — with picker preview */}
    <div className={`${styles.callout} ${styles.exploreExag}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Vertical exaggeration</span>
        <span className={styles.calloutSub}>1× = true elevation · Higher = stretched</span>
      </div>
      <IconExagPicker />
    </div>

    {/* Recenter — bottom right */}
    <div className={`${styles.callout} ${styles.exploreRecenter}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Re-center view</span>
      </div>
      <div className={styles.btnPreview}><IconRecenter /></div>
    </div>

    {/* GPS — bottom left */}
    <div className={`${styles.callout} ${styles.exploreGps}`}>
      <div className={styles.btnPreview}><IconCrosshair /></div>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Set location to GPS</span>
      </div>
    </div>

    <div className={styles.settingsNote}>
      Toggle on and off labels, rivers, and lakes in Settings
    </div>
  </>
)

// ─── SCAN Tutorial ──────────────────────────────────────────────────────────

const ScanTutorial: React.FC = () => (
  <>
    {/* Compass callout — right below compass strip */}
    <div className={`${styles.callout} ${styles.scanCompass}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Compass — your heading</span>
      </div>
    </div>

    {/* Title + description — below compass callout */}
    <div className={styles.scanTitleBlock}>
      <div className={styles.title}>SCAN</div>
      <div className={styles.desc}>
        360° panorama — drag to look around
      </div>
    </div>

    {/* Left slider — tall preview matching actual slider */}
    <div className={`${styles.callout} ${styles.scanZoom}`}>
      <div className={styles.sliderPreviewBox}><IconZoomSliderTall /></div>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Zoom</span>
        <span className={styles.calloutSub}>Drag or pinch</span>
      </div>
    </div>

    {/* Right slider — tall preview */}
    <div className={`${styles.callout} ${styles.scanHeight}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Height (AGL)</span>
        <span className={styles.calloutSub}>Viewing altitude</span>
      </div>
      <div className={styles.sliderPreviewBox}><IconHeightSliderTall /></div>
    </div>

    {/* Gyro + GPS — bottom right */}
    <div className={`${styles.callout} ${styles.scanGyro}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Gyroscope</span>
        <span className={styles.calloutSub}>Face correct direction first</span>
      </div>
      <div className={styles.btnPreview}><IconGyro /></div>
    </div>

    <div className={`${styles.callout} ${styles.scanGps}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Set viewpoint to GPS</span>
      </div>
      <div className={styles.btnPreview}><IconCrosshair /></div>
    </div>

    {/* HUD callout */}
    <div className={`${styles.callout} ${styles.scanHud}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Info — coordinates, elevation, heading</span>
      </div>
    </div>
  </>
)
