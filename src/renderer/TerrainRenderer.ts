/**
 * EarthContours — Three.js Terrain Renderer
 *
 * Solid terrain mesh for the EXPLORE screen. Uses a displaced PlaneGeometry
 * with vertex colors from the ocean-depth palette and directional lighting
 * so the terrain is an opaque, shaded 3D surface you can fly around.
 *
 * Camera is driven externally via updateCamera() from the cameraStore orbit
 * parameters (theta, phi, radius, panX, panZ).
 *
 * Also exposes projectToScreen() so HTML overlays (peak labels, location pin)
 * can project world positions to CSS pixel coordinates.
 */

import * as THREE from 'three'
import { createLogger } from '../core/logger'
import type { TerrainMeshData, WaterBody, River, Glacier, Coastline, LatLng } from '../core/types'
import { ENU_M_PER_DEG_LAT, ENU_M_PER_DEG_LON_AT_LAT } from '../core/constants'
import { marchingSquares } from './marchingSquares'

const log = createLogger('RENDERER:THREE')

// ─── Ocean-depth palette stops (matches CSS palette) ─────────────────────────

const PALETTE_STOPS = [
  { t: 0.0, r: 14,  g: 57,  b: 81  },  // abyss
  { t: 0.2, r: 18,  g: 75,  b: 107 },  // deep
  { t: 0.4, r: 33,  g: 92,  b: 121 },  // navy
  { t: 0.6, r: 47,  g: 109, b: 135 },  // ocean
  { t: 0.8, r: 104, g: 176, b: 191 },  // reef
  { t: 1.0, r: 167, g: 221, b: 229 },  // foam
]

function elevationToColor(t: number): { r: number; g: number; b: number } {
  const clamped = Math.max(0, Math.min(1, t))
  // Find the two stops we're between
  let lo = PALETTE_STOPS[0]
  let hi = PALETTE_STOPS[PALETTE_STOPS.length - 1]
  for (let i = 0; i < PALETTE_STOPS.length - 1; i++) {
    if (clamped >= PALETTE_STOPS[i].t && clamped <= PALETTE_STOPS[i + 1].t) {
      lo = PALETTE_STOPS[i]
      hi = PALETTE_STOPS[i + 1]
      break
    }
  }
  const f = lo.t === hi.t ? 0 : (clamped - lo.t) / (hi.t - lo.t)
  return {
    r: lo.r + (hi.r - lo.r) * f,
    g: lo.g + (hi.g - lo.g) * f,
    b: lo.b + (hi.b - lo.b) * f,
  }
}

// ─── TerrainRenderer Class ───────────────────────────────────────────────────

export class TerrainRenderer {
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private terrainMesh: THREE.Mesh | null = null
  private contourLines: THREE.LineSegments | null = null
  private canvas: HTMLCanvasElement | null = null

  // Geo overlays
  private geoOverlayGroup: THREE.Group | null = null

  // Terrain dimensions in metres (set when terrain loads)
  private terrainWidth_m = 0
  private terrainDepth_m = 0
  private minElevation_m = 0
  private elevRange_m = 1

  constructor() {
    log.info('TerrainRenderer created')
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  initialize(canvas: HTMLCanvasElement): void {
    log.info('TerrainRenderer.initialize()', {
      width: canvas.width,
      height: canvas.height,
    })

    this.canvas = canvas

    // WebGL renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    })
    this.renderer.setPixelRatio(window.devicePixelRatio || 1)
    this.renderer.setClearColor(0x020e18)  // match the dark bg

    // Scene
    this.scene = new THREE.Scene()

    // Camera (perspective for natural fly-around feel)
    this.camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 10, 5_000_000)
    this.camera.position.set(0, 100_000, 100_000)
    this.camera.lookAt(0, 0, 0)

    // Lighting — directional from NW-45° (matches SCAN hill shading)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight.position.set(-1, 1.5, -1).normalize()
    this.scene.add(dirLight)

    // Softer fill light from the opposite side
    const fillLight = new THREE.DirectionalLight(0x4488aa, 0.4)
    fillLight.position.set(1, 0.5, 1).normalize()
    this.scene.add(fillLight)

    // Ambient so shadow sides aren't pure black
    const ambient = new THREE.AmbientLight(0x1a3040, 0.6)
    this.scene.add(ambient)
  }

  dispose(): void {
    log.info('TerrainRenderer.dispose()')

    if (this.terrainMesh) {
      this.terrainMesh.geometry.dispose()
      const mat = this.terrainMesh.material
      if (Array.isArray(mat)) mat.forEach(m => m.dispose())
      else mat.dispose()
      this.terrainMesh = null
    }

    if (this.contourLines) {
      this.contourLines.geometry.dispose()
      const mat = this.contourLines.material
      if (Array.isArray(mat)) mat.forEach(m => m.dispose())
      else mat.dispose()
      this.contourLines = null
    }

    this.clearGeoOverlays()

    if (this.renderer) {
      this.renderer.dispose()
      this.renderer = null
    }

    this.scene = null
    this.camera = null
    this.canvas = null
  }

  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  // ── Build terrain mesh from elevation data ──────────────────────────────────

  buildTerrain(mesh: TerrainMeshData, verticalExaggeration: number): void {
    if (!this.scene) return

    // Remove old mesh + contours
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh)
      this.terrainMesh.geometry.dispose()
      ;(this.terrainMesh.material as THREE.Material).dispose()
      this.terrainMesh = null
    }
    if (this.contourLines) {
      this.scene.remove(this.contourLines)
      this.contourLines.geometry.dispose()
      ;(this.contourLines.material as THREE.Material).dispose()
      this.contourLines = null
    }

    const { elevations, width, height, minElevation_m, maxElevation_m, bounds } = mesh

    const lat0 = (bounds.north + bounds.south) / 2
    const MPD_LON = ENU_M_PER_DEG_LON_AT_LAT(lat0)

    this.terrainWidth_m = (bounds.east - bounds.west) * MPD_LON
    this.terrainDepth_m = (bounds.north - bounds.south) * ENU_M_PER_DEG_LAT
    this.minElevation_m = minElevation_m
    this.elevRange_m = maxElevation_m - minElevation_m || 1

    const segW = width - 1
    const segH = height - 1

    // PlaneGeometry: width along X, depth along Z
    const geometry = new THREE.PlaneGeometry(
      this.terrainWidth_m, this.terrainDepth_m, segW, segH,
    )

    // Rotate from XY plane to XZ (horizontal)
    geometry.rotateX(-Math.PI / 2)

    // Displace vertices by elevation + set vertex colors
    const posAttr = geometry.getAttribute('position')
    const colors = new Float32Array(posAttr.count * 3)

    // Ocean/coastline color constants
    const OCEAN_R = 10 / 255, OCEAN_G = 30 / 255, OCEAN_B = 46 / 255   // dark navy (#0a1e2e)
    const SEA_LEVEL = Math.max(0, -minElevation_m)  // how far above grid-min is sea level
    const BEACH_GRADIENT_M = 15  // metres above sea level for the gradient fade

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const vi = row * width + col
        const elev = elevations[vi]

        // Clamp ocean to sea level — prevents negative bathymetry from
        // pulling the mesh down and creating hanging contour lines
        const clampedElev = Math.max(0, elev)
        const y = (clampedElev - Math.max(0, minElevation_m)) * verticalExaggeration

        // PlaneGeometry after rotateX(-PI/2): vertices are in XZ plane.
        // Vertex order: row 0 is top (north), increasing row goes south (Z+).
        // Set Y to displaced elevation.
        posAttr.setY(vi, y)

        // Vertex color: ocean = dark blue, coastline = gradient, land = palette
        if (elev <= 0) {
          // Ocean — flat dark blue
          colors[vi * 3]     = OCEAN_R
          colors[vi * 3 + 1] = OCEAN_G
          colors[vi * 3 + 2] = OCEAN_B
        } else if (elev < BEACH_GRADIENT_M) {
          // Beach gradient — blend from ocean color to terrain palette
          const blend = elev / BEACH_GRADIENT_M  // 0 at sea level, 1 at BEACH_GRADIENT_M
          const t = (clampedElev - Math.max(0, minElevation_m)) / this.elevRange_m
          const c = elevationToColor(t)
          colors[vi * 3]     = OCEAN_R + (c.r / 255 - OCEAN_R) * blend
          colors[vi * 3 + 1] = OCEAN_G + (c.g / 255 - OCEAN_G) * blend
          colors[vi * 3 + 2] = OCEAN_B + (c.b / 255 - OCEAN_B) * blend
        } else {
          // Normal terrain
          const t = (clampedElev - Math.max(0, minElevation_m)) / this.elevRange_m
          const c = elevationToColor(t)
          colors[vi * 3]     = c.r / 255
          colors[vi * 3 + 1] = c.g / 255
          colors[vi * 3 + 2] = c.b / 255
        }
      }
    }

    posAttr.needsUpdate = true
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.computeVertexNormals()

    const material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
      shininess: 5,
      specular: new THREE.Color(0x112233),
      flatShading: false,
    })

    this.terrainMesh = new THREE.Mesh(geometry, material)
    this.scene.add(this.terrainMesh)

    log.info('Terrain mesh built', {
      vertices: posAttr.count,
      width_km: (this.terrainWidth_m / 1000).toFixed(1),
      depth_km: (this.terrainDepth_m / 1000).toFixed(1),
      elevRange_m: this.elevRange_m.toFixed(0),
    })
  }

  // ── Build contour lines as 3D LineSegments on top of the mesh ──────────────

  buildContourLines(mesh: TerrainMeshData, contourElevations: number[], verticalExaggeration: number): void {
    if (!this.scene) return

    // Remove old contour lines
    if (this.contourLines) {
      this.scene.remove(this.contourLines)
      this.contourLines.geometry.dispose()
      ;(this.contourLines.material as THREE.Material).dispose()
      this.contourLines = null
    }

    if (contourElevations.length === 0) return

    const { elevations, width, height, minElevation_m, maxElevation_m } = mesh
    const elevRange = maxElevation_m - minElevation_m || 1

    // Small Y offset above terrain surface to prevent z-fighting
    const yOffset = elevRange * verticalExaggeration * 0.002

    // Collect all line segment vertices and colors
    const positions: number[] = []
    const colors: number[] = []

    for (const elev of contourElevations) {
      if (elev <= 0) continue  // skip ocean/below-sea-level contours
      const segments = marchingSquares(elevations, width, height, elev)
      if (segments.length === 0) continue

      const t = (elev - minElevation_m) / elevRange
      // Brighter than the mesh surface so lines are visible
      const c = elevationToColor(Math.min(1, t * 0.6 + 0.4))
      const cr = c.r / 255
      const cg = c.g / 255
      const cb = c.b / 255

      const y = (elev - Math.max(0, minElevation_m)) * verticalExaggeration + yOffset
      const isMajor = elev % 500 === 0

      // Slightly brighter for major contours
      const brightMult = isMajor ? 1.3 : 1.0

      for (const seg of segments) {
        // marching squares output in [0,1] grid-normalised space → ENU metres
        const x1 = (seg.x1 - 0.5) * this.terrainWidth_m
        const z1 = (seg.y1 - 0.5) * this.terrainDepth_m
        const x2 = (seg.x2 - 0.5) * this.terrainWidth_m
        const z2 = (seg.y2 - 0.5) * this.terrainDepth_m

        positions.push(x1, y, z1, x2, y, z2)
        colors.push(
          cr * brightMult, cg * brightMult, cb * brightMult,
          cr * brightMult, cg * brightMult, cb * brightMult,
        )
      }
    }

    if (positions.length === 0) return

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthTest: true,
      depthWrite: false,
    })

    this.contourLines = new THREE.LineSegments(geometry, material)
    this.scene.add(this.contourLines)

    log.info('Contour lines built', {
      elevationLevels: contourElevations.length,
      lineSegments: positions.length / 6,
    })
  }

  // ── Update terrain when vertical exaggeration changes ───────────────────────

  updateExaggeration(mesh: TerrainMeshData, verticalExaggeration: number): void {
    if (!this.terrainMesh) return

    const posAttr = this.terrainMesh.geometry.getAttribute('position')
    const { elevations, width, height, minElevation_m } = mesh

    const clampedMin = Math.max(0, minElevation_m)
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const vi = row * width + col
        const clampedElev = Math.max(0, elevations[vi])
        const y = (clampedElev - clampedMin) * verticalExaggeration
        posAttr.setY(vi, y)
      }
    }

    posAttr.needsUpdate = true
    this.terrainMesh.geometry.computeVertexNormals()
  }

  // ── Geographic overlays (rivers, lakes, glaciers, coastlines) ────────────────

  /**
   * Remove all geo overlay objects from the scene and dispose their geometry.
   */
  clearGeoOverlays(): void {
    if (this.geoOverlayGroup && this.scene) {
      this.scene.remove(this.geoOverlayGroup)
      this.geoOverlayGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
          obj.geometry.dispose()
          const mat = obj.material
          if (Array.isArray(mat)) mat.forEach(m => m.dispose())
          else (mat as THREE.Material).dispose()
        }
      })
      this.geoOverlayGroup = null
    }
  }

  /**
   * Convert a lat/lng point to ENU world coordinates on the terrain surface.
   * Returns { x, y, z } in metres, with y elevated to terrain height + offset.
   */
  private latLngToWorld(
    lat: number, lng: number,
    mesh: TerrainMeshData,
    verticalExaggeration: number,
    yOffset: number,
  ): { x: number; y: number; z: number } | null {
    const { bounds, elevations, width, height, minElevation_m } = mesh

    // Normalise to 0-1 within bounds
    const nx = (lng - bounds.west) / (bounds.east - bounds.west)
    const ny = (bounds.north - lat) / (bounds.north - bounds.south)

    // Allow a small tolerance outside bounds for features that cross the edge
    if (nx < -0.02 || nx > 1.02 || ny < -0.02 || ny > 1.02) return null

    // Grid sample coordinates (clamped)
    const gx = Math.max(0, Math.min(width - 1, nx * (width - 1)))
    const gy = Math.max(0, Math.min(height - 1, ny * (height - 1)))

    // Bilinear interpolation of elevation
    const x0 = Math.floor(gx), x1 = Math.min(x0 + 1, width - 1)
    const y0 = Math.floor(gy), y1 = Math.min(y0 + 1, height - 1)
    const fx = gx - x0, fy = gy - y0
    const elev =
      elevations[y0 * width + x0] * (1 - fx) * (1 - fy) +
      elevations[y0 * width + x1] * fx * (1 - fy) +
      elevations[y1 * width + x0] * (1 - fx) * fy +
      elevations[y1 * width + x1] * fx * fy

    return {
      x: (nx - 0.5) * this.terrainWidth_m,
      y: (Math.max(0, elev) - Math.max(0, minElevation_m)) * verticalExaggeration + yOffset,
      z: (ny - 0.5) * this.terrainDepth_m,
    }
  }

  /**
   * Convert a polyline of lat/lng points to one or more 3D line segments
   * following the terrain. Breaks the polyline when a point falls outside
   * bounds (instead of skipping it, which creates stray diagonal lines).
   * Returns an array of position arrays — one per continuous segment.
   */
  private polylineToSegments(
    points: LatLng[],
    mesh: TerrainMeshData,
    verticalExaggeration: number,
    yOffset: number,
  ): number[][] {
    const segments: number[][] = []
    let current: number[] = []
    for (const pt of points) {
      const w = this.latLngToWorld(pt.lat, pt.lng, mesh, verticalExaggeration, yOffset)
      if (w) {
        current.push(w.x, w.y, w.z)
      } else {
        // Break: out-of-bounds point — start a new segment
        if (current.length >= 6) segments.push(current)
        current = []
      }
    }
    if (current.length >= 6) segments.push(current)
    return segments
  }

  /**
   * Build all geo overlays for the current terrain.
   * Filters features to the terrain bounding box, projects onto the mesh surface.
   * Coastlines are no longer rendered as overlays — ocean is handled via
   * vertex coloring in buildTerrain() using the DEM's own elevation data.
   */
  buildGeoOverlays(
    mesh: TerrainMeshData,
    verticalExaggeration: number,
    waterBodies: WaterBody[],
    rivers: River[],
    glaciers: Glacier[],
    _coastlines: Coastline[],
    options: { showLakes: boolean; showRivers: boolean; showGlaciers: boolean; showCoastlines: boolean },
  ): { lakeCount: number; riverCount: number; glacierCount: number; coastlineCount: number } {
    this.clearGeoOverlays()
    if (!this.scene) return { lakeCount: 0, riverCount: 0, glacierCount: 0, coastlineCount: 0 }

    this.geoOverlayGroup = new THREE.Group()

    const { bounds } = mesh
    const yOffset = this.elevRange_m * verticalExaggeration * 0.003

    // ── Helper: does a feature's points intersect the terrain bounds? ──────
    const boundsIntersects = (points: LatLng[]): boolean => {
      for (const p of points) {
        if (p.lat >= bounds.south && p.lat <= bounds.north &&
            p.lng >= bounds.west  && p.lng <= bounds.east) return true
      }
      return false
    }

    /** Add a Line per segment from polylineToSegments */
    const addLineSegments = (
      segments: number[][], color: number, opacity: number,
    ) => {
      for (const positions of segments) {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        const mat = new THREE.LineBasicMaterial({
          color, transparent: true, opacity,
          depthTest: true, depthWrite: false,
        })
        this.geoOverlayGroup!.add(new THREE.Line(geo, mat))
      }
    }

    let lakeCount = 0
    let riverCount = 0
    let glacierCount = 0
    const coastlineCount = 0  // coastlines handled by vertex coloring now

    // ── Rivers — thicker appearance via parallel offset lines ──────────────
    if (options.showRivers) {
      const filtered = rivers.filter(r => boundsIntersects(r.points))
      for (const river of filtered) {
        const segments = this.polylineToSegments(river.points, mesh, verticalExaggeration, yOffset)
        if (segments.length === 0) continue

        const isMinor = river.isStream || (river.scalerank != null && river.scalerank >= 7)
        const opacity = isMinor ? 0.35 : 0.65
        const color = 0x3377bb

        // Main line
        addLineSegments(segments, color, opacity)

        // Parallel offset lines for visual thickness (WebGL linewidth is 1px on most GPUs)
        if (!isMinor) {
          const offsetM = this.terrainWidth_m * 0.0004  // small lateral offset
          for (const seg of segments) {
            const shifted: number[] = []
            for (let i = 0; i < seg.length; i += 3) {
              shifted.push(seg[i] + offsetM, seg[i + 1], seg[i + 2])
            }
            const geo = new THREE.BufferGeometry()
            geo.setAttribute('position', new THREE.Float32BufferAttribute(shifted, 3))
            const mat = new THREE.LineBasicMaterial({
              color, transparent: true, opacity: opacity * 0.5,
              depthTest: true, depthWrite: false,
            })
            this.geoOverlayGroup!.add(new THREE.Line(geo, mat))
          }
        }

        riverCount++
      }
    }

    // ── Lakes — darker fill + prominent outline ─────────────────────────────
    if (options.showLakes) {
      const filtered = waterBodies.filter(w => boundsIntersects(w.polygon))
      for (const lake of filtered) {
        const segments = this.polylineToSegments(lake.polygon, mesh, verticalExaggeration, yOffset)
        // Use all positions from all segments for the outline
        const allPositions: number[] = []
        for (const s of segments) allPositions.push(...s)
        if (allPositions.length < 9) continue

        // Dark outline
        const outlineGeo = new THREE.BufferGeometry()
        outlineGeo.setAttribute('position', new THREE.Float32BufferAttribute(allPositions, 3))
        const outlineMat = new THREE.LineBasicMaterial({
          color: 0x1a4466,
          transparent: true,
          opacity: 0.75,
          depthTest: true,
          depthWrite: false,
        })
        this.geoOverlayGroup.add(new THREE.LineLoop(outlineGeo, outlineMat))

        // Semi-transparent fill at average Y
        const count = allPositions.length / 3
        if (count >= 3) {
          let avgY = 0
          for (let i = 0; i < count; i++) avgY += allPositions[i * 3 + 1]
          avgY /= count

          const shape = new THREE.Shape()
          shape.moveTo(allPositions[0], allPositions[2])
          for (let i = 1; i < count; i++) {
            shape.lineTo(allPositions[i * 3], allPositions[i * 3 + 2])
          }
          shape.closePath()

          const shapeGeo = new THREE.ShapeGeometry(shape)
          shapeGeo.rotateX(-Math.PI / 2)
          const fillMat = new THREE.MeshBasicMaterial({
            color: 0x1a4488,
            transparent: true,
            opacity: 0.4,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: false,
          })
          const fillMesh = new THREE.Mesh(shapeGeo, fillMat)
          fillMesh.position.y = avgY
          this.geoOverlayGroup.add(fillMesh)
        }

        lakeCount++
      }
    }

    // ── Glaciers — white/ice-blue semi-transparent fill + darker outline ───
    if (options.showGlaciers) {
      const filtered = glaciers.filter(g => boundsIntersects(g.polygon))
      for (const glacier of filtered) {
        const segments = this.polylineToSegments(glacier.polygon, mesh, verticalExaggeration, yOffset * 1.5)
        const allPositions: number[] = []
        for (const s of segments) allPositions.push(...s)
        if (allPositions.length < 9) continue

        // Darker outline
        const outlineGeo = new THREE.BufferGeometry()
        outlineGeo.setAttribute('position', new THREE.Float32BufferAttribute(allPositions, 3))
        const outlineMat = new THREE.LineBasicMaterial({
          color: 0x6688aa,
          transparent: true,
          opacity: 0.6,
          depthTest: true,
          depthWrite: false,
        })
        this.geoOverlayGroup.add(new THREE.LineLoop(outlineGeo, outlineMat))

        // White/ice-blue fill
        const count = allPositions.length / 3
        if (count >= 3) {
          let avgY = 0
          for (let i = 0; i < count; i++) avgY += allPositions[i * 3 + 1]
          avgY /= count

          const shape = new THREE.Shape()
          shape.moveTo(allPositions[0], allPositions[2])
          for (let i = 1; i < count; i++) {
            shape.lineTo(allPositions[i * 3], allPositions[i * 3 + 2])
          }
          shape.closePath()

          const shapeGeo = new THREE.ShapeGeometry(shape)
          shapeGeo.rotateX(-Math.PI / 2)
          const fillMat = new THREE.MeshBasicMaterial({
            color: 0xddeeff,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: false,
          })
          const fillMesh = new THREE.Mesh(shapeGeo, fillMat)
          fillMesh.position.y = avgY
          this.geoOverlayGroup.add(fillMesh)
        }

        glacierCount++
      }
    }

    // Coastlines: no longer rendered as overlay lines — ocean is handled
    // by vertex coloring (dark blue for elev ≤ 0, gradient beach transition).

    this.scene.add(this.geoOverlayGroup)

    log.info('Geo overlays built', { lakeCount, riverCount, glacierCount, coastlineCount })
    return { lakeCount, riverCount, glacierCount, coastlineCount }
  }

  // ── Camera update from cameraStore orbit params ─────────────────────────────

  updateCamera(
    theta: number,
    phi: number,
    radius: number,
    panX: number,
    panZ: number,
  ): void {
    if (!this.camera) return

    // Pivot point in metres (panX/panZ are fractions of terrain dimensions)
    const pivotX = panX * this.terrainWidth_m
    const pivotZ = panZ * this.terrainDepth_m
    // Y pivot at mid-elevation for nicer orbiting
    const pivotY = this.elevRange_m * 0.3

    // Spherical to cartesian (phi=0 is top-down, phi=PI/2 is side-on)
    // Negate theta so drag-right rotates the view right (matching the old system)
    const camX = pivotX + radius * Math.sin(phi) * Math.sin(-theta)
    const camY = pivotY + radius * Math.cos(phi)
    const camZ = pivotZ + radius * Math.sin(phi) * Math.cos(-theta)

    this.camera.position.set(camX, camY, camZ)
    this.camera.lookAt(pivotX, pivotY * 0.5, pivotZ)

    // Adjust near/far based on radius
    this.camera.near = Math.max(1, radius * 0.001)
    this.camera.far = Math.max(radius * 10, 5_000_000)
    this.camera.updateProjectionMatrix()
  }

  // ── Render one frame ────────────────────────────────────────────────────────

  render(): void {
    if (!this.renderer || !this.scene || !this.camera) return
    this.renderer.render(this.scene, this.camera)
  }

  // ── Project a world point to CSS screen coords ──────────────────────────────

  /**
   * Project a terrain point (grid col, row, elevation) to CSS pixel coordinates.
   * Used by PeakLabels3D and the location pin overlay.
   *
   * Returns null if the point is behind the camera.
   */
  projectToScreen(
    mesh: TerrainMeshData,
    col: number,
    row: number,
    elevation_m: number,
    verticalExaggeration: number,
    containerW: number,
    containerH: number,
  ): { sx: number; sy: number } | null {
    if (!this.camera) return null

    const { width, height, minElevation_m } = mesh

    // ENU world coordinates (same as what buildTerrain produces — with ocean clamp)
    const clampedElev = Math.max(0, elevation_m)
    const clampedMin = Math.max(0, minElevation_m)
    const x = (col / (width - 1) - 0.5) * this.terrainWidth_m
    const y = (clampedElev - clampedMin) * verticalExaggeration
    const z = (row / (height - 1) - 0.5) * this.terrainDepth_m

    const vec = new THREE.Vector3(x, y, z)
    vec.project(this.camera)

    // vec is now in NDC [-1, 1]. Convert to CSS pixels.
    if (vec.z > 1) return null  // behind camera

    const sx = (vec.x * 0.5 + 0.5) * containerW
    const sy = (-vec.y * 0.5 + 0.5) * containerH

    return { sx, sy }
  }

  /**
   * Raycast from a screen point to find the terrain intersection.
   * Used for double-click fly-to.
   * Returns the intersection point in ENU metres, or null.
   */
  raycastTerrain(
    screenX: number,
    screenY: number,
    containerW: number,
    containerH: number,
  ): { x: number; y: number; z: number } | null {
    if (!this.camera || !this.terrainMesh) return null

    const ndc = new THREE.Vector2(
      (screenX / containerW) * 2 - 1,
      -(screenY / containerH) * 2 + 1,
    )

    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)

    const intersects = raycaster.intersectObject(this.terrainMesh)
    if (intersects.length === 0) return null

    const p = intersects[0].point
    return { x: p.x, y: p.y, z: p.z }
  }

  // ── Accessors ───────────────────────────────────────────────────────────────

  getTerrainWidth(): number { return this.terrainWidth_m }
  getTerrainDepth(): number { return this.terrainDepth_m }
  isReady(): boolean { return this.renderer !== null && this.scene !== null }
}
