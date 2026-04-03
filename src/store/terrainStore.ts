/**
 * EarthContours — Terrain Store
 *
 * Manages elevation data, peaks, rivers, and the terrain grid.
 *
 * Elevation source priority (handled by ElevationLoader):
 *   1. IndexedDB (cached from prior session — instant)
 *   2. Local /tiles/elevation/ files (offline bundle)
 *   3. AWS Terrarium tiles (live network)
 *
 * On failure, retries at progressively lower zoom levels (fewer tiles)
 * before showing an error. No simulated/fake terrain is ever displayed.
 */

import { create } from 'zustand'
import type { Peak, River, WaterBody, Glacier, Coastline, TerrainMeshData, LoadingState, Region } from '../core/types'
import { createLogger } from '../core/logger'
import { TerrainLoadError } from '../core/errors'
import { loadRegionElevation, adaptiveZoomForArea, TERRAIN_ZOOM } from '../data/elevationLoader'
// generateSimulatedTerrain removed — always use real elevation data
import { COLORADO_PEAKS, ALASKA_PEAKS } from '../data/simulatedData'
import { fetchPeaksInBounds } from '../data/peakLoader'
import { REGIONS } from '../data/regions'
import { TERRAIN_GRID_SIZE, ENU_M_PER_DEG_LAT, ENU_M_PER_DEG_LON_AT_LAT } from '../core/constants'

const log = createLogger('STORE:TERRAIN')

// ─── Store Interface ──────────────────────────────────────────────────────────

interface TerrainStore {
  activeRegion: Region | null
  peaks: Peak[]
  rivers: River[]
  waterBodies: WaterBody[]
  glaciers: Glacier[]
  coastlines: Coastline[]
  meshData: TerrainMeshData | null
  contourElevations: number[]
  loadingState: LoadingState
  loadingProgress: number
  loadingMessage: string
  /** Whether the current elevation data is real (AWS/local) vs simulated */
  isRealElevation: boolean
  /** The tile zoom level used for the current terrain load */
  terrainZoom: number
  /** Whether the current region was user-drawn (custom bounds) vs predefined */
  isCustomBounds: boolean

  loadRegion: (regionId: string) => Promise<void>
  loadCustomBounds: (bounds: { north: number; south: number; east: number; west: number }) => Promise<void>
  setActiveRegion: (region: Region) => void
  setWaterBodies: (waterBodies: WaterBody[]) => void
  setRivers: (rivers: River[]) => void
  setGlaciers: (glaciers: Glacier[]) => void
  setCoastlines: (coastlines: Coastline[]) => void
}

// ─── Store Implementation ─────────────────────────────────────────────────────

export const useTerrainStore = create<TerrainStore>()((set, get) => ({
  activeRegion: null,
  peaks: [],
  rivers: [],
  waterBodies: [],
  glaciers: [],
  coastlines: [],
  meshData: null,
  contourElevations: [],
  loadingState: 'idle',
  loadingProgress: 0,
  loadingMessage: '',
  isRealElevation: false,
  terrainZoom: 10,
  isCustomBounds: false,

  loadRegion: async (regionId) => {
    log.info('Loading terrain region', { regionId })

    if (get().activeRegion?.id === regionId && get().loadingState === 'success') {
      log.debug('Region already loaded, skipping', { regionId })
      return
    }

    const region = REGIONS.find((r) => r.id === regionId)
    if (!region) {
      const err = new TerrainLoadError(regionId, 'Region not found in registry')
      log.error('Unknown region ID', { regionId })
      set({ loadingState: 'error', loadingMessage: err.message })
      return
    }

    set({ loadingState: 'loading', loadingProgress: 0, loadingMessage: 'Loading elevation data...', activeRegion: region, isCustomBounds: false })

    try {
      // ── Phase 1: Peak data ────────────────────────────────────────────────
      set({ loadingProgress: 5, loadingMessage: 'Loading peak data...' })
      const peaks =
        regionId === 'colorado-rockies' ? COLORADO_PEAKS :
        ALASKA_PEAKS
      log.info('Peak data loaded', { peaks: peaks.length })
      set({ peaks, loadingProgress: 15 })

      // ── Phase 2: Real elevation data with retry at lower zoom ────────────
      let elevations!: Float32Array

      // Try loading at default zoom, then retry at progressively lower zooms
      // (fewer tiles = more likely to succeed on slow/flaky mobile networks).
      const zoomLevels = [TERRAIN_ZOOM, Math.max(8, TERRAIN_ZOOM - 1), Math.max(8, TERRAIN_ZOOM - 2)]
      // Deduplicate in case TERRAIN_ZOOM is already low
      const uniqueZooms = [...new Set(zoomLevels)]

      for (const z of uniqueZooms) {
        set({ loadingMessage: `Fetching z${z} elevation tiles...` })
        log.info('Attempting elevation load', { region: region.id, zoom: z })
        try {
          elevations = await loadRegionElevation(
            region,
            TERRAIN_GRID_SIZE,
            (p) => set({ loadingProgress: 15 + Math.round(p * 65) }),
            z,
          )
          log.info('━━━ TERRAIN SOURCE: REAL (AWS Terrarium DEM tiles) ━━━', { region: region.id, zoom: z })
          break
        } catch (elevErr) {
          log.warn(`Elevation load failed at z${z}`, { region: region.id, reason: String(elevErr) })
          if (z === uniqueZooms[uniqueZooms.length - 1]) {
            // All zoom levels exhausted — propagate the error
            throw new TerrainLoadError(region.id, `Elevation data unavailable — check your network connection`)
          }
          set({ loadingMessage: `Retrying at lower resolution (z${z - 1})...` })
        }
      }

      // ── Phase 3: Assemble TerrainMeshData ──────────────────────────────────
      set({ loadingProgress: 82, loadingMessage: 'Processing elevation grid...' })

      let minElev = Infinity, maxElev = -Infinity
      for (let i = 0; i < elevations.length; i++) {
        if (elevations[i] < minElev) minElev = elevations[i]
        if (elevations[i] > maxElev) maxElev = elevations[i]
      }

      log.info('Elevation grid stats', {
        min: `${minElev.toFixed(0)}m`,
        max: `${maxElev.toFixed(0)}m`,
        range: `${(maxElev - minElev).toFixed(0)}m`,
        isReal: true,
      })

      // Compute real physical dimensions from the region's lat/lng bounds
      // using the ENU flat-earth approximation (< 0.2 % error for ≤ 300 km chunks).
      const lat0 = (region.bounds.north + region.bounds.south) / 2
      const worldWidth_km  = (region.bounds.east  - region.bounds.west)  * ENU_M_PER_DEG_LON_AT_LAT(lat0) / 1000
      const worldDepth_km  = (region.bounds.north - region.bounds.south) * ENU_M_PER_DEG_LAT / 1000

      log.info('Terrain physical dimensions', {
        worldWidth_km:  worldWidth_km.toFixed(1),
        worldDepth_km:  worldDepth_km.toFixed(1),
        lat0: lat0.toFixed(3),
      })

      const meshData: TerrainMeshData = {
        width: TERRAIN_GRID_SIZE,
        height: TERRAIN_GRID_SIZE,
        elevations,
        minElevation_m: minElev,
        maxElevation_m: maxElev,
        worldWidth_km,
        worldDepth_km,
        bounds: region.bounds,
      }

      // ── Phase 4: Contour elevations ────────────────────────────────────────
      set({ loadingProgress: 90, loadingMessage: 'Calculating contours...' })
      const contourElevations = calculateContourElevations(minElev, maxElev)
      log.info('Contours calculated', { count: contourElevations.length, interval: contourElevations[1] ? (contourElevations[1] - contourElevations[0]).toFixed(0) + 'm' : 'N/A' })

      set({
        meshData,
        contourElevations,
        isRealElevation: true,
        terrainZoom: 10,
        loadingState: 'success',
        loadingProgress: 100,
        loadingMessage: `${region.name} — real elevation data`,
      })

      log.info('Region load COMPLETE', { regionId, peaks: peaks.length })

    } catch (err) {
      const loadError = new TerrainLoadError(regionId, err)
      log.error('Region load FAILED', { regionId, error: loadError })
      set({ loadingState: 'error', loadingMessage: loadError.message, loadingProgress: 0 })
    }
  },

  loadCustomBounds: async (bounds) => {
    const { north, south, east, west } = bounds
    const midLat = (north + south) / 2
    const midLng = (east + west) / 2

    // Calculate area dimensions for adaptive zoom
    const heightKm = (north - south) * 111.132
    const widthKm = (east - west) * 111.320 * Math.cos((midLat * Math.PI) / 180)
    const maxSideKm = Math.max(widthKm, heightKm)
    const tileZoom = adaptiveZoomForArea(maxSideKm)

    log.info('Loading custom bounds', {
      north: north.toFixed(4), south: south.toFixed(4),
      east: east.toFixed(4), west: west.toFixed(4),
      widthKm: widthKm.toFixed(1), heightKm: heightKm.toFixed(1),
      tileZoom,
    })

    // Create a dynamic Region object for the custom bounds
    const customRegion: Region = {
      id: `custom-${Date.now()}`,
      name: '3D Explore View',
      description: `Custom area: ${widthKm.toFixed(0)} × ${heightKm.toFixed(0)} km`,
      center: { lat: midLat, lng: midLng },
      bounds,
    }

    // Clear old meshData so the Explore screen shows the loading bar
    // instead of keeping the previous terrain visible during load.
    set({
      loadingState: 'loading',
      loadingProgress: 0,
      loadingMessage: 'Loading custom area...',
      meshData: null,
      activeRegion: customRegion,
      isCustomBounds: true,
      terrainZoom: tileZoom,
    })

    try {
      // ── Phase 1: Fetch OSM peaks for the selected bounds ────────────────
      set({ loadingProgress: 3, loadingMessage: 'Fetching peak data...' })
      let peaks: Peak[] = []
      try {
        peaks = await fetchPeaksInBounds(south, west, north, east)
        log.info('OSM peaks loaded for custom bounds', { count: peaks.length })
      } catch (peakErr) {
        log.warn('OSM peak fetch failed for custom bounds', { err: String(peakErr) })
      }
      set({ peaks, loadingProgress: 12 })

      // ── Phase 2: Real elevation data with retry at lower zoom ────────────
      let elevations!: Float32Array

      // Try loading at the adaptive zoom, then retry at progressively lower zooms
      // (fewer tiles = more likely to succeed on slow/flaky mobile networks).
      const MIN_ZOOM = 8
      const zoomLevels = [tileZoom, Math.max(MIN_ZOOM, tileZoom - 1), Math.max(MIN_ZOOM, tileZoom - 2)]
      const uniqueZooms = [...new Set(zoomLevels)]

      for (const z of uniqueZooms) {
        set({ loadingMessage: `Fetching z${z} elevation tiles...` })
        log.info('Attempting elevation load', { region: customRegion.id, zoom: z })
        try {
          elevations = await loadRegionElevation(
            customRegion,
            TERRAIN_GRID_SIZE,
            (p) => set({ loadingProgress: 12 + Math.round(p * 65) }),
            z,
          )
          log.info('━━━ TERRAIN SOURCE: REAL (AWS Terrarium DEM tiles) ━━━', {
            region: customRegion.id, zoom: z,
          })
          break
        } catch (elevErr) {
          log.warn(`Elevation load failed at z${z}`, { region: customRegion.id, reason: String(elevErr) })
          if (z === uniqueZooms[uniqueZooms.length - 1]) {
            throw new TerrainLoadError(customRegion.id, `Elevation data unavailable — check your network connection`)
          }
          set({ loadingMessage: `Retrying at lower resolution (z${z - 1})...` })
        }
      }

      // ── Phase 3: Assemble TerrainMeshData ──────────────────────────────────
      set({ loadingProgress: 82, loadingMessage: 'Processing elevation grid...' })

      let minElev = Infinity, maxElev = -Infinity
      for (let i = 0; i < elevations.length; i++) {
        if (elevations[i] < minElev) minElev = elevations[i]
        if (elevations[i] > maxElev) maxElev = elevations[i]
      }

      const lat0 = midLat
      const worldWidth_km  = (east - west) * ENU_M_PER_DEG_LON_AT_LAT(lat0) / 1000
      const worldDepth_km  = (north - south) * ENU_M_PER_DEG_LAT / 1000

      log.info('Custom terrain physical dimensions', {
        worldWidth_km: worldWidth_km.toFixed(1),
        worldDepth_km: worldDepth_km.toFixed(1),
        tileZoom,
        elevRange: `${minElev.toFixed(0)}–${maxElev.toFixed(0)}m`,
      })

      const meshData: TerrainMeshData = {
        width: TERRAIN_GRID_SIZE,
        height: TERRAIN_GRID_SIZE,
        elevations,
        minElevation_m: minElev,
        maxElevation_m: maxElev,
        worldWidth_km,
        worldDepth_km,
        bounds,
      }

      // ── Phase 4: Contour elevations ────────────────────────────────────────
      set({ loadingProgress: 90, loadingMessage: 'Calculating contours...' })
      const contourElevations = calculateContourElevations(minElev, maxElev)

      set({
        meshData,
        contourElevations,
        isRealElevation: true,
        loadingState: 'success',
        loadingProgress: 100,
        loadingMessage: `Custom area — real elevation data (z${tileZoom})`,
      })

      log.info('Custom bounds load COMPLETE', {
        tileZoom, peaks: peaks.length,
        widthKm: worldWidth_km.toFixed(1), heightKm: worldDepth_km.toFixed(1),
      })

    } catch (err) {
      const loadError = new TerrainLoadError(customRegion.id, err)
      log.error('Custom bounds load FAILED', { error: loadError })
      set({ loadingState: 'error', loadingMessage: loadError.message, loadingProgress: 0 })
    }
  },

  setActiveRegion: (region) => {
    log.info('Active region set', { id: region.id })
    set({ activeRegion: region })
  },

  setWaterBodies: (waterBodies) => {
    log.info('Water bodies set', { count: waterBodies.length })
    set({ waterBodies })
  },

  setRivers: (rivers) => {
    log.info('Rivers set', { count: rivers.length })
    set({ rivers })
  },

  setGlaciers: (glaciers) => {
    log.info('Glaciers set', { count: glaciers.length })
    set({ glaciers })
  },

  setCoastlines: (coastlines) => {
    log.info('Coastlines set', { count: coastlines.length })
    set({ coastlines })
  },
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calculateContourElevations(minElev: number, maxElev: number): number[] {
  const range = maxElev - minElev

  // Interval selection matches standard USGS topographic map conventions:
  //   flat / coastal terrain  → 50m  (~164ft) — enough detail, not cluttered
  //   rolling hills           → 100m (~328ft)
  //   mountain terrain        → 100m — 2× denser than previous 200m default
  //     (256×256 grid ≈ 156m/sample over 40km, so 100m intervals are resolvable)
  const interval = range < 500 ? 50 : 100

  const contours: number[] = []
  const start = Math.ceil(minElev / interval) * interval
  for (let elev = start; elev <= maxElev; elev += interval) {
    contours.push(elev)
  }
  log.debug('Contour elevations', { interval, count: contours.length, range: range.toFixed(0) })
  return contours
}
