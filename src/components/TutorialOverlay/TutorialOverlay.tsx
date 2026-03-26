/**
 * TutorialOverlay — Visual cheat sheet overlay for each screen.
 *
 * Semi-transparent overlay that lets you SEE the actual controls underneath.
 * Labels positioned near real control locations so users understand what
 * each button does. Works on both mobile and desktop.
 *
 * Tap anywhere to dismiss.
 */

import React from 'react'
import { useUIStore } from '../../store'
import type { ScreenId } from '../../core/types'
import styles from './TutorialOverlay.module.css'

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
      {/* Dismiss hint — prominent at top */}
      <div className={styles.dismissHint}>Tap anywhere to close tutorial</div>

      {screen === 'map' && <MapTutorial />}
      {screen === 'explore' && <ExploreTutorial />}
      {screen === 'scan' && <ScanTutorial />}
    </div>
  )
}

// ─── MAP Tutorial ───────────────────────────────────────────────────────────

const MapTutorial: React.FC = () => (
  <>
    {/* Title + description */}
    <div className={styles.titleBlock}>
      <div className={styles.title}>MAP</div>
      <div className={styles.description}>
        Browse topographic elevation data. Light areas are higher elevation,
        dark areas are lower — down to sea level.
      </div>
    </div>

    {/* Center tap hint */}
    <div className={styles.centerHint}>
      <div className={styles.centerIcon}>+</div>
      <div className={styles.centerText}>
        Tap anywhere to set your viewpoint location
      </div>
    </div>

    {/* Right controls — positioned near the actual zoom/location/area buttons */}
    <div className={`${styles.callout} ${styles.mapZoom}`}>
      <div className={styles.calloutArrow}>←</div>
      <div className={styles.calloutText}>
        Zoom in and out
        <span className={styles.subtext}>Pinch on mobile · Scroll on desktop</span>
      </div>
    </div>

    <div className={`${styles.callout} ${styles.mapLocation}`}>
      <div className={styles.calloutArrow}>←</div>
      <div className={styles.calloutText}>
        Set viewpoint to your GPS location
      </div>
    </div>

    <div className={`${styles.callout} ${styles.mapAreaSelect}`}>
      <div className={styles.calloutArrow}>←</div>
      <div className={styles.calloutText}>
        Select an area to view in 3D on Explore tab
      </div>
    </div>

    {/* Bottom nav hint */}
    <div className={styles.navHint}>
      Use the tabs below to switch between Map, Explore, and Scan
    </div>
  </>
)

// ─── EXPLORE Tutorial ───────────────────────────────────────────────────────

const ExploreTutorial: React.FC = () => (
  <>
    <div className={styles.titleBlock}>
      <div className={styles.title}>EXPLORE</div>
      <div className={styles.description}>
        3D terrain view of the selected area. Orbit, zoom, and fly
        through the landscape with contour lines and peak labels.
      </div>
    </div>

    {/* Center navigation instructions */}
    <div className={styles.centerHint}>
      <div className={styles.centerText}>
        <strong>Mobile:</strong> 1-finger drag to orbit · 2-finger drag to pan · Pinch to zoom
        <br />
        <strong>Desktop:</strong> Left-click drag to pan · Right-click drag to orbit · Scroll to zoom
        <br />
        <strong>Both:</strong> Double-tap / double-click to fly to a spot
      </div>
    </div>

    {/* Right side — vertical exaggeration */}
    <div className={`${styles.callout} ${styles.exploreExaggeration}`}>
      <div className={styles.calloutArrow}>←</div>
      <div className={styles.calloutText}>
        Vertical exaggeration
        <span className={styles.subtext}>
          1× = true elevation · Higher values stretch terrain height
        </span>
      </div>
    </div>

    {/* Right side — recenter */}
    <div className={`${styles.callout} ${styles.exploreRecenter}`}>
      <div className={styles.calloutArrow}>←</div>
      <div className={styles.calloutText}>
        Re-center camera view
      </div>
    </div>

    {/* Left side — GPS button */}
    <div className={`${styles.callout} ${styles.exploreGps}`}>
      <div className={styles.calloutText}>
        Show your GPS location on terrain
      </div>
      <div className={styles.calloutArrow}>→</div>
    </div>

    {/* Settings hint */}
    <div className={styles.settingsHint}>
      Toggle labels, contour lines, and terrain fill in Settings
    </div>

    <div className={styles.navHint}>
      Select a new area on the Map tab to explore different terrain
    </div>
  </>
)

// ─── SCAN Tutorial ──────────────────────────────────────────────────────────

const ScanTutorial: React.FC = () => (
  <>
    <div className={styles.titleBlock}>
      <div className={styles.title}>SCAN</div>
      <div className={styles.description}>
        First-person 360° panorama from your viewpoint. See the horizon,
        ridgelines, peak names, elevations, and distances.
      </div>
    </div>

    {/* Center drag instruction */}
    <div className={styles.centerHint}>
      <div className={styles.centerText}>
        Drag left and right to look around the full 360° horizon
      </div>
    </div>

    {/* Left — zoom slider */}
    <div className={`${styles.callout} ${styles.scanZoom}`}>
      <div className={styles.calloutText}>
        Zoom slider
        <span className={styles.subtext}>Drag up to zoom in · Or pinch to zoom</span>
      </div>
      <div className={styles.calloutArrow}>→</div>
    </div>

    {/* Right — height slider */}
    <div className={`${styles.callout} ${styles.scanHeight}`}>
      <div className={styles.calloutArrow}>←</div>
      <div className={styles.calloutText}>
        Height (AGL) slider
        <span className={styles.subtext}>Adjust your viewing height above ground</span>
      </div>
    </div>

    {/* Bottom right — gyro + GPS */}
    <div className={`${styles.callout} ${styles.scanGyro}`}>
      <div className={styles.calloutArrow}>←</div>
      <div className={styles.calloutText}>
        Gyroscope
        <span className={styles.subtext}>
          Face the correct direction before enabling — aligns view with your phone
        </span>
      </div>
    </div>

    <div className={`${styles.callout} ${styles.scanGps}`}>
      <div className={styles.calloutArrow}>←</div>
      <div className={styles.calloutText}>
        GPS — use your current location as viewpoint
      </div>
    </div>

    {/* Top — compass */}
    <div className={`${styles.callout} ${styles.scanCompass}`}>
      <div className={styles.calloutText}>
        Compass heading — shows which direction you are looking (N, S, E, W)
      </div>
      <div className={styles.calloutArrow}>↑</div>
    </div>

    {/* Bottom — HUD */}
    <div className={`${styles.callout} ${styles.scanHud}`}>
      <div className={styles.calloutArrow}>↓</div>
      <div className={styles.calloutText}>
        Info panel — your coordinates, elevation, heading, and scan range
      </div>
    </div>

    <div className={styles.navHint}>
      Set a new viewpoint location on the Map tab
    </div>
  </>
)
