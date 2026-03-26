/**
 * TutorialOverlay — Visual cheat sheet overlay for each screen.
 *
 * Shows when uiStore.tutorialScreen matches the current screen.
 * Displays key instructions as labeled callouts over the live screen.
 * Tap anywhere to dismiss.
 */

import React from 'react'
import { useUIStore } from '../../store'
import type { ScreenId } from '../../core/types'
import styles from './TutorialOverlay.module.css'

// ─── Tutorial Content Per Screen ────────────────────────────────────────────

interface TutorialTip {
  text: string
  position: 'top-left' | 'top-center' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'mid-left' | 'mid-right'
}

const TUTORIAL_CONTENT: Record<string, { title: string; tips: TutorialTip[] }> = {
  map: {
    title: 'MAP',
    tips: [
      { text: 'Pan and zoom to browse the map', position: 'top-center' },
      { text: 'Tap anywhere to set an explore location', position: 'center' },
      { text: 'Use the area selector to pick a 3D region for Explore', position: 'mid-right' },
      { text: 'Crosshair button centers on your GPS location', position: 'mid-left' },
      { text: 'Switch to Explore or Scan using the tabs below', position: 'bottom-center' },
    ],
  },
  explore: {
    title: 'EXPLORE',
    tips: [
      { text: 'Drag to orbit around the terrain', position: 'top-center' },
      { text: 'Pinch to zoom in and out', position: 'center' },
      { text: 'Double-tap to fly to a location', position: 'mid-left' },
      { text: 'Re-center button resets the camera view', position: 'bottom-right' },
      { text: 'Select a new area on the Map tab', position: 'bottom-center' },
    ],
  },
  scan: {
    title: 'SCAN',
    tips: [
      { text: 'Drag left/right to look around the horizon', position: 'top-center' },
      { text: 'Peak labels show name, elevation, and distance', position: 'center' },
      { text: 'Pinch to zoom in on distant peaks', position: 'mid-left' },
      { text: 'Use the AGL slider to adjust viewer height', position: 'mid-right' },
      { text: 'Select a new location on the Map tab', position: 'bottom-center' },
    ],
  },
}

// ─── Component ──────────────────────────────────────────────────────────────

interface TutorialOverlayProps {
  screen: ScreenId
}

export const TutorialOverlay: React.FC<TutorialOverlayProps> = ({ screen }) => {
  const tutorialScreen = useUIStore((s) => s.tutorialScreen)
  const dismissTutorial = useUIStore((s) => s.dismissTutorial)

  if (tutorialScreen !== screen) return null

  const content = TUTORIAL_CONTENT[screen]
  if (!content) return null

  return (
    <div
      className={styles.overlay}
      onClick={dismissTutorial}
      role="dialog"
      aria-label={`${content.title} tutorial`}
    >
      <div className={styles.title}>{content.title}</div>

      {content.tips.map((tip, i) => (
        <div key={i} className={`${styles.tip} ${styles[tip.position]}`}>
          <div className={styles.tipDot} aria-hidden="true" />
          <div className={styles.tipText}>{tip.text}</div>
        </div>
      ))}

      <div className={styles.dismissHint}>Tap anywhere to close</div>
    </div>
  )
}
