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

const IconZoomSlider: React.FC = () => (
  <svg className={styles.icon} width="14" height="28" viewBox="0 0 14 28" fill="none" stroke="currentColor" strokeWidth="1.5">
    <line x1="7" y1="2" x2="7" y2="26" opacity="0.4" />
    <circle cx="7" cy="10" r="4" fill="currentColor" opacity="0.6" />
    <text x="7" y="3" textAnchor="middle" fill="currentColor" fontSize="6" stroke="none">+</text>
    <text x="7" y="28" textAnchor="middle" fill="currentColor" fontSize="7" stroke="none">−</text>
  </svg>
)

const IconHeightSlider: React.FC = () => (
  <svg className={styles.icon} width="14" height="28" viewBox="0 0 14 28" fill="none" stroke="currentColor" strokeWidth="1">
    <line x1="7" y1="2" x2="7" y2="26" opacity="0.4" />
    <circle cx="7" cy="18" r="4" fill="currentColor" opacity="0.6" />
    <text x="7" y="4" textAnchor="middle" fill="currentColor" fontSize="4" stroke="none">HIGH</text>
    <text x="7" y="28" textAnchor="middle" fill="currentColor" fontSize="4" stroke="none">LOW</text>
  </svg>
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
    {/* 1. Title + description */}
    <div className={styles.titleBlock}>
      <div className={styles.title}>MAP</div>
      <div className={styles.desc}>
        Topographic elevation map — light = high, dark = sea level
      </div>
    </div>

    {/* 2. Center — viewpoint tap */}
    <div className={styles.centerBlock}>
      <IconViewpoint />
      <div className={styles.centerLabel}>Tap anywhere to set viewpoint</div>
    </div>

    {/* 3. Right-side button callouts — positioned near actual buttons */}
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
    </div>
  </>
)

// ─── EXPLORE Tutorial ───────────────────────────────────────────────────────

const ExploreTutorial: React.FC = () => (
  <>
    {/* 1. Title + description */}
    <div className={styles.titleBlock}>
      <div className={styles.title}>EXPLORE</div>
      <div className={styles.desc}>
        3D terrain — orbit, zoom, and fly through the landscape
      </div>
    </div>

    {/* 2. Controls — same format as existing EXPLORE CONTROLS popup */}
    <div className={styles.controlsBox}>
      <div className={styles.controlsTitle}>CONTROLS</div>
      <div className={styles.controlRow}><span className={styles.controlKey}>Drag / 1 finger</span><span className={styles.controlVal}>Orbit &amp; tilt</span></div>
      <div className={styles.controlRow}><span className={styles.controlKey}>Right-click / 2 fingers</span><span className={styles.controlVal}>Pan</span></div>
      <div className={styles.controlRow}><span className={styles.controlKey}>Scroll / Pinch</span><span className={styles.controlVal}>Zoom</span></div>
      <div className={styles.controlRow}><span className={styles.controlKey}>Double-tap / click</span><span className={styles.controlVal}>Fly to point</span></div>
    </div>

    {/* 3. Button callouts */}
    <div className={`${styles.callout} ${styles.exploreExag}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Vertical exaggeration</span>
        <span className={styles.calloutSub}>1× = true elevation</span>
      </div>
    </div>

    <div className={`${styles.callout} ${styles.exploreRecenter}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Re-center view</span>
      </div>
      <div className={styles.btnPreview}><IconRecenter /></div>
    </div>

    <div className={`${styles.callout} ${styles.exploreGps}`}>
      <div className={styles.btnPreview}><IconCrosshair /></div>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>GPS location</span>
      </div>
    </div>

    <div className={styles.settingsNote}>
      Customize labels, contours, and fill in Settings
    </div>
  </>
)

// ─── SCAN Tutorial ──────────────────────────────────────────────────────────

const ScanTutorial: React.FC = () => (
  <>
    {/* 1. Title + description */}
    <div className={styles.titleBlock}>
      <div className={styles.title}>SCAN</div>
      <div className={styles.desc}>
        360° panorama — drag to look around, see peaks and ridgelines
      </div>
    </div>

    {/* 2. Compass callout — just below top */}
    <div className={`${styles.callout} ${styles.scanCompass}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Compass — your heading direction</span>
      </div>
    </div>

    {/* 3. Left slider */}
    <div className={`${styles.callout} ${styles.scanZoom}`}>
      <div className={styles.btnPreview}><IconZoomSlider /></div>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Zoom</span>
        <span className={styles.calloutSub}>Drag or pinch</span>
      </div>
    </div>

    {/* 4. Right slider */}
    <div className={`${styles.callout} ${styles.scanHeight}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Height (AGL)</span>
        <span className={styles.calloutSub}>Adjust viewing altitude</span>
      </div>
      <div className={styles.btnPreview}><IconHeightSlider /></div>
    </div>

    {/* 5. Bottom-right buttons */}
    <div className={`${styles.callout} ${styles.scanGyro}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Gyroscope</span>
        <span className={styles.calloutSub}>Face correct direction first</span>
      </div>
      <div className={styles.btnPreview}><IconGyro /></div>
    </div>

    <div className={`${styles.callout} ${styles.scanGps}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>GPS viewpoint</span>
      </div>
      <div className={styles.btnPreview}><IconCrosshair /></div>
    </div>

    {/* 6. HUD callout */}
    <div className={`${styles.callout} ${styles.scanHud}`}>
      <div className={styles.calloutContent}>
        <span className={styles.calloutLabel}>Info panel — coordinates, elevation, heading</span>
      </div>
    </div>
  </>
)
