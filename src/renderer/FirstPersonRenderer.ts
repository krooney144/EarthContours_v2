/**
 * EarthContours — First-Person Terrain Renderer (Scan2)
 *
 * Places a camera AT GROUND LEVEL on a displaced terrain mesh.
 * The viewer is fixed in position and looks around via heading/pitch.
 * Adapted from TerrainRenderer (orbit mode) for immersive first-person use.
 *
 * Camera driven externally via updateFirstPersonCamera(heading, pitch, height, fov).
 * Also exposes projectToScreen() for HTML peak label overlays.
 */

import * as THREE from 'three'
import { createLogger } from '../core/logger'
import type { TerrainMeshData } from '../core/types'
import { ENU_M_PER_DEG_LAT, ENU_M_PER_DEG_LON_AT_LAT } from '../core/constants'
import { marchingSquares } from './marchingSquares'

const log = createLogger('RENDERER:FP')

// ─── Darker palette stops (slightly muted vs ExploreScreen) ─────────────────

const PALETTE_STOPS = [
  { t: 0.0, r: 10,  g: 42,  b: 62  },  // deep abyss
  { t: 0.2, r: 14,  g: 58,  b: 84  },  // dark deep
  { t: 0.4, r: 26,  g: 74,  b: 98  },  // dark navy
  { t: 0.6, r: 38,  g: 90,  b: 112 },  // dark ocean
  { t: 0.8, r: 82,  g: 148, b: 164 },  // muted reef
  { t: 1.0, r: 138, g: 194, b: 204 },  // muted foam
]

function elevationToColor(t: number): { r: number; g: number; b: number } {
  const clamped = Math.max(0, Math.min(1, t))
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

// ─── FirstPersonRenderer Class ──────────────────────────────────────────────

export class FirstPersonRenderer {
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private terrainMesh: THREE.Mesh | null = null
  private contourLines: THREE.LineSegments | null = null
  private canvas: HTMLCanvasElement | null = null

  // Terrain dimensions in metres (set when terrain loads)
  private terrainWidth_m = 0
  private terrainDepth_m = 0
  private minElevation_m = 0
  private elevRange_m = 1

  // Viewer position in ENU metres (center of terrain by default)
  private viewerX_m = 0
  private viewerZ_m = 0
  private viewerGroundElev_m = 0

  constructor() {
    log.info('FirstPersonRenderer created')
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  initialize(canvas: HTMLCanvasElement): void {
    log.info('FirstPersonRenderer.initialize()', {
      width: canvas.width,
      height: canvas.height,
    })

    this.canvas = canvas

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    })
    this.renderer.setPixelRatio(window.devicePixelRatio || 1)
    this.renderer.setClearColor(0x020a14)  // darker sky bg

    this.scene = new THREE.Scene()

    // Add fog for atmospheric depth
    this.scene.fog = new THREE.FogExp2(0x061622, 0.000015)

    // Camera — first-person perspective with wide FOV
    this.camera = new THREE.PerspectiveCamera(70, canvas.width / canvas.height, 1, 500_000)
    this.camera.position.set(0, 100, 0)
    this.camera.lookAt(0, 100, -100)

    // Lighting — slightly dimmer than ExploreScreen for immersive feel
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0)
    dirLight.position.set(-1, 1.5, -1).normalize()
    this.scene.add(dirLight)

    const fillLight = new THREE.DirectionalLight(0x335577, 0.35)
    fillLight.position.set(1, 0.5, 1).normalize()
    this.scene.add(fillLight)

    const ambient = new THREE.AmbientLight(0x152535, 0.55)
    this.scene.add(ambient)

    // Sky dome — large sphere with gradient for horizon
    this._buildSkyDome()
  }

  private _buildSkyDome(): void {
    if (!this.scene) return

    const skyGeo = new THREE.SphereGeometry(200_000, 32, 16)
    const skyColors = new Float32Array(skyGeo.getAttribute('position').count * 3)
    const posAttr = skyGeo.getAttribute('position')

    for (let i = 0; i < posAttr.count; i++) {
      const y = posAttr.getY(i)
      // Normalize y from [-radius, +radius] to [0, 1]
      const t = (y / 200_000 + 1) * 0.5

      // Dark near horizon, slightly lighter at zenith
      const r = (0.02 + t * 0.04) // subtle blue-black gradient
      const g = (0.04 + t * 0.07)
      const b = (0.08 + t * 0.12)

      skyColors[i * 3] = r
      skyColors[i * 3 + 1] = g
      skyColors[i * 3 + 2] = b
    }

    skyGeo.setAttribute('color', new THREE.BufferAttribute(skyColors, 3))

    const skyMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      depthWrite: false,
    })

    const skyMesh = new THREE.Mesh(skyGeo, skyMat)
    this.scene.add(skyMesh)
  }

  dispose(): void {
    log.info('FirstPersonRenderer.dispose()')

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

    const geometry = new THREE.PlaneGeometry(
      this.terrainWidth_m, this.terrainDepth_m, segW, segH,
    )

    // Rotate from XY plane to XZ (horizontal)
    geometry.rotateX(-Math.PI / 2)

    // Displace vertices by elevation + set vertex colors
    const posAttr = geometry.getAttribute('position')
    const colors = new Float32Array(posAttr.count * 3)

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const vi = row * width + col
        const elev = elevations[vi]
        const y = (elev - minElevation_m) * verticalExaggeration

        posAttr.setY(vi, y)

        // Darker vertex color from palette
        const t = (elev - minElevation_m) / this.elevRange_m
        const c = elevationToColor(t)
        colors[vi * 3] = c.r / 255
        colors[vi * 3 + 1] = c.g / 255
        colors[vi * 3 + 2] = c.b / 255
      }
    }

    posAttr.needsUpdate = true
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.computeVertexNormals()

    const material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,  // DoubleSide so we see terrain from inside valleys
      shininess: 3,
      specular: new THREE.Color(0x0a1520),
      flatShading: false,
    })

    this.terrainMesh = new THREE.Mesh(geometry, material)
    this.scene.add(this.terrainMesh)

    // Compute viewer ground elevation at center
    const centerRow = Math.floor(height / 2)
    const centerCol = Math.floor(width / 2)
    this.viewerGroundElev_m = elevations[centerRow * width + centerCol]
    this.viewerX_m = 0  // center of terrain
    this.viewerZ_m = 0

    log.info('FP terrain mesh built', {
      vertices: posAttr.count,
      width_km: (this.terrainWidth_m / 1000).toFixed(1),
      depth_km: (this.terrainDepth_m / 1000).toFixed(1),
      elevRange_m: this.elevRange_m.toFixed(0),
      groundElev_m: this.viewerGroundElev_m.toFixed(0),
    })
  }

  // ── Build contour lines ───────────────────────────────────────────────────

  buildContourLines(mesh: TerrainMeshData, contourElevations: number[], verticalExaggeration: number): void {
    if (!this.scene) return

    if (this.contourLines) {
      this.scene.remove(this.contourLines)
      this.contourLines.geometry.dispose()
      ;(this.contourLines.material as THREE.Material).dispose()
      this.contourLines = null
    }

    if (contourElevations.length === 0) return

    const { elevations, width, height, minElevation_m, maxElevation_m } = mesh
    const elevRange = maxElevation_m - minElevation_m || 1
    const yOffset = elevRange * verticalExaggeration * 0.002

    const positions: number[] = []
    const colors: number[] = []

    for (const elev of contourElevations) {
      const segments = marchingSquares(elevations, width, height, elev)
      if (segments.length === 0) continue

      const t = (elev - minElevation_m) / elevRange
      const c = elevationToColor(Math.min(1, t * 0.6 + 0.4))
      const cr = c.r / 255
      const cg = c.g / 255
      const cb = c.b / 255

      const y = (elev - minElevation_m) * verticalExaggeration + yOffset
      const isMajor = elev % 500 === 0
      const brightMult = isMajor ? 1.3 : 1.0

      for (const seg of segments) {
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
      opacity: 0.45,
      depthTest: true,
      depthWrite: false,
    })

    this.contourLines = new THREE.LineSegments(geometry, material)
    this.scene.add(this.contourLines)

    log.info('FP contour lines built', {
      elevationLevels: contourElevations.length,
      lineSegments: positions.length / 6,
    })
  }

  // ── First-person camera update ────────────────────────────────────────────

  /**
   * Update camera for first-person view.
   * @param heading_deg  Direction facing (0=N, 90=E, 180=S, 270=W)
   * @param pitch_deg    Vertical tilt (-90=down, 0=horizon, 90=up)
   * @param height_m     Eye height above ground in metres
   * @param fov_deg      Horizontal field of view in degrees
   * @param exaggeration Vertical exaggeration multiplier
   */
  updateFirstPersonCamera(
    heading_deg: number,
    pitch_deg: number,
    height_m: number,
    fov_deg: number,
    exaggeration: number,
  ): void {
    if (!this.camera) return

    // Camera Y = ground elevation (exaggerated) + eye height
    const groundY = (this.viewerGroundElev_m - this.minElevation_m) * exaggeration
    const camY = groundY + height_m

    this.camera.position.set(this.viewerX_m, camY, this.viewerZ_m)

    // Convert heading+pitch to a look-at direction
    // heading: 0=N(-Z), 90=E(+X), 180=S(+Z), 270=W(-X)
    const headingRad = heading_deg * Math.PI / 180
    const pitchRad = pitch_deg * Math.PI / 180

    // Look direction vector
    const lookDist = 1000  // arbitrary distance for lookAt target
    const cosPitch = Math.cos(pitchRad)
    const lookX = this.viewerX_m + Math.sin(headingRad) * cosPitch * lookDist
    const lookY = camY + Math.sin(pitchRad) * lookDist
    const lookZ = this.viewerZ_m - Math.cos(headingRad) * cosPitch * lookDist

    this.camera.lookAt(lookX, lookY, lookZ)

    // Update FOV
    this.camera.fov = fov_deg
    this.camera.near = 1
    this.camera.far = 500_000
    this.camera.updateProjectionMatrix()
  }

  // ── Render one frame ──────────────────────────────────────────────────────

  render(): void {
    if (!this.renderer || !this.scene || !this.camera) return
    this.renderer.render(this.scene, this.camera)
  }

  // ── Project a world point to CSS screen coords ────────────────────────────

  /**
   * Project a lat/lng/elevation to screen coordinates.
   * Used for peak label overlays.
   */
  projectLatLngToScreen(
    lat: number,
    lng: number,
    elevation_m: number,
    bounds: { north: number; south: number; east: number; west: number },
    verticalExaggeration: number,
    containerW: number,
    containerH: number,
  ): { sx: number; sy: number; dist_m: number } | null {
    if (!this.camera) return null

    const lat0 = (bounds.north + bounds.south) / 2
    const lng0 = (bounds.east + bounds.west) / 2
    const MPD_LON = ENU_M_PER_DEG_LON_AT_LAT(lat0)

    // Convert lat/lng to ENU metres
    const x = (lng - lng0) * MPD_LON
    const z = -(lat - lat0) * ENU_M_PER_DEG_LAT  // negative because Z+ is south in Three.js
    const y = (elevation_m - this.minElevation_m) * verticalExaggeration

    const vec = new THREE.Vector3(x, y, z)

    // Compute distance before projection
    const dist_m = vec.distanceTo(this.camera.position)

    vec.project(this.camera)

    // vec is now in NDC [-1, 1]. Convert to CSS pixels.
    if (vec.z > 1) return null  // behind camera

    const sx = (vec.x * 0.5 + 0.5) * containerW
    const sy = (-vec.y * 0.5 + 0.5) * containerH

    return { sx, sy, dist_m }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getTerrainWidth(): number { return this.terrainWidth_m }
  getTerrainDepth(): number { return this.terrainDepth_m }
  getGroundElevation(): number { return this.viewerGroundElev_m }
  isReady(): boolean { return this.renderer !== null && this.scene !== null }
}
