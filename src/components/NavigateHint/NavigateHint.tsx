/**
 * NavigateHint — Subtle fade-out hint reminding users to use the Map screen
 * to navigate to new areas. Appears on Explore and Scan screens.
 */

import React, { useEffect, useState } from 'react'
import styles from './NavigateHint.module.css'

export const NavigateHint: React.FC = () => {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 5000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      className={`${styles.hint} ${visible ? '' : styles.hidden}`}
      aria-hidden="true"
    >
      Navigate to Map to explore a new area
    </div>
  )
}
