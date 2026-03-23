/**
 * EarthContours — Bottom Navigation Bar
 *
 * 4-tab nav: MAP · EXPLORE · SCAN · SETTINGS
 * Plus a home button to return to the landing page.
 *
 * Uses Josefin Sans (display font) per briefing.
 * The active tab has a glow indicator at the top.
 */

import React, { useCallback } from 'react'
import { useUIStore } from '../../store'
import type { ScreenId } from '../../core/types'
import { createLogger } from '../../core/logger'
import styles from './Nav.module.css'

const log = createLogger('COMPONENT:NAV')

// ─── Tab Definitions ──────────────────────────────────────────────────────────

const TABS: Array<{ id: ScreenId; label: string; icon: string; ariaLabel: string }> = [
  { id: 'map',      label: 'MAP',      icon: '\u2295', ariaLabel: 'Map — Topographic map' },
  { id: 'explore',  label: 'EXPLORE',  icon: '\u2B21', ariaLabel: 'Explore — 3D terrain view' },
  { id: 'scan',     label: 'SCAN',     icon: '\u25C9', ariaLabel: 'Scan — AR terrain view' },
  { id: 'settings', label: 'SETTINGS', icon: '\u229E', ariaLabel: 'Settings' },
]

// ─── Component ────────────────────────────────────────────────────────────────

const Nav: React.FC = () => {
  const activeScreen = useUIStore((state) => state.activeScreen)
  const navigateTo = useUIStore((state) => state.navigateTo)
  const isPreviewMode = useUIStore((state) => state.isPreviewMode)

  const handleTabClick = useCallback(
    (screenId: ScreenId) => {
      log.info('Nav tab clicked', {
        from: activeScreen,
        to: screenId,
        isPreviewMode,
      })
      navigateTo(screenId)
    },
    [activeScreen, navigateTo, isPreviewMode],
  )

  return (
    <nav className={styles.nav} role="navigation" aria-label="Main navigation">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`${styles.tab} ${activeScreen === tab.id && !isPreviewMode ? styles.active : ''}`}
          onClick={() => handleTabClick(tab.id)}
          aria-label={tab.ariaLabel}
          aria-current={activeScreen === tab.id ? 'page' : undefined}
          role="tab"
        >
          <span className={styles.icon} aria-hidden="true">{tab.icon}</span>
          <span className={styles.label}>{tab.label}</span>
        </button>
      ))}
    </nav>
  )
}

export default Nav
