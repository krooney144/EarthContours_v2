/**
 * EarthContours — Home Screen (Landing Page)
 *
 * The first screen users see when opening the app.
 * Three vertical cards: Map, Explore, Scan — each with a brief description.
 * Settings accessible via gear icon in the header.
 */

import React, { useCallback } from 'react'
import { useUIStore } from '../../store'
import type { ScreenId } from '../../core/types'
import { createLogger } from '../../core/logger'
import styles from './HomeScreen.module.css'

const log = createLogger('SCREEN:HOME')

// ─── Card Definitions ────────────────────────────────────────────────────────

const CARDS: Array<{
  id: ScreenId
  title: string
  description: string
  icon: string
  iconClass: string
}> = [
  {
    id: 'map',
    title: 'Map',
    description: 'Explore topographic maps with DEM elevation tiles, peak labels, lakes, and a 3D globe view.',
    icon: '\u2295',  // ⊕
    iconClass: 'cardIconMap',
  },
  {
    id: 'explore',
    title: 'Explore',
    description: '3D terrain orbit view with contour lines, solid mesh, and real elevation data.',
    icon: '\u2B21',  // ⬡
    iconClass: 'cardIconExplore',
  },
  {
    id: 'scan',
    title: 'Scan',
    description: 'First-person panoramic skyline view with 360\u00B0 ridgeline rendering and peak identification.',
    icon: '\u25C9',  // ◉
    iconClass: 'cardIconScan',
  },
]

// ─── Component ────────────────────────────────────────────────────────────────

const HomeScreen: React.FC = () => {
  const navigateTo = useUIStore((s) => s.navigateTo)

  const handleCardClick = useCallback(
    (screenId: ScreenId) => {
      log.info('Home card clicked', { screen: screenId })
      navigateTo(screenId)
    },
    [navigateTo],
  )

  const handleSettingsClick = useCallback(() => {
    log.info('Settings button clicked from home')
    navigateTo('settings')
  }, [navigateTo])

  return (
    <div className={styles.screen}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandIcon} aria-hidden="true">{'\u25C8'}</span>
          <span className={styles.brandName}>Earth Contours</span>
        </div>
        <button
          className={styles.settingsBtn}
          onClick={handleSettingsClick}
          aria-label="Open settings"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <circle cx="9" cy="9" r="3" />
            <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.1 3.1l1.4 1.4M13.5 13.5l1.4 1.4M3.1 14.9l1.4-1.4M13.5 4.5l1.4-1.4" />
          </svg>
        </button>
      </div>

      {/* Screen cards */}
      <div className={styles.cardsArea}>
        {CARDS.map((card) => (
          <button
            key={card.id}
            className={styles.card}
            onClick={() => handleCardClick(card.id)}
            aria-label={`Open ${card.title} screen`}
          >
            <div className={`${styles.cardIcon} ${styles[card.iconClass]}`} aria-hidden="true">
              {card.icon}
            </div>
            <div className={styles.cardContent}>
              <div className={styles.cardTitle}>{card.title}</div>
              <div className={styles.cardDescription}>{card.description}</div>
            </div>
            <span className={styles.cardArrow} aria-hidden="true">{'\u203A'}</span>
          </button>
        ))}
      </div>

      {/* Version footer */}
      <div className={styles.footer}>
        <div className={styles.footerText}>Earth Contours v2.3</div>
      </div>
    </div>
  )
}

export default HomeScreen
