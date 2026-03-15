import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { EdgeData } from './occt/tessellate';

export interface DragInteractionCallbacks {
  onDragStart: (hitPoint: [number, number, number], handleId?: string) => {
    axis: [number, number, number];
    initialValue: number;
  } | null;
  onDrag: (newValue: number, isNegative: boolean, handleId?: string) => void;
  onDragEnd?: () => void;
}

const ARROW_SHAFT_RADIUS = 0.8;
const ARROW_SHAFT_LENGTH = 15;
const ARROW_HEAD_RADIUS = 2.5;
const ARROW_HEAD_HEIGHT = 6;
const ARROW_COLOR = 0xf59e0b;
const ARROW_HOVER_COLOR = 0xffffff;

const HANDLE_SHAFT_RADIUS = 0.6;
const HANDLE_SHAFT_LENGTH = 15;
const HANDLE_HEAD_RADIUS = 2;
const HANDLE_HEAD_HEIGHT = 4;
const HANDLE_COLORS: Record<string, number> = {
  normal: 0x3b82f6, // blue
  x: 0xef4444,      // red
  y: 0x22c55e,      // green
};

const RING_RADIUS = 12;
const RING_TUBE_RADIUS = 0.5;
const RING_COLORS: Record<string, number> = {
  spin: 0x06b6d4,  // cyan
  tilt: 0xd946ef,  // magenta
};

export interface PartViewportOptions {
  container: HTMLElement;
  background?: string;
}

/**
 * Imperative Three.js viewport for the part editor.
 * Not a React component — managed via create/dispose pattern.
 */
export class PartViewport {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private resizeObserver: ResizeObserver;
  private animationId: number = 0;
  private meshGroup: THREE.Group;
  private previewGroup: THREE.Group;
  private sketchOverlayGroup: THREE.Group;
  private sketchPlanesGroup: THREE.Group;
  private gizmoGroup: THREE.Group;
  private planeGizmoGroup: THREE.Group;
  private outlineGroup: THREE.Group;
  private faceHighlightGroup: THREE.Group;
  private raycaster = new THREE.Raycaster();
  private dragCallbacks: DragInteractionCallbacks | null = null;
  private activeDrag: {
    axisOrigin: THREE.Vector3;
    axisDir: THREE.Vector3;
    initialT: number;
    initialValue: number;
    arrowOrigin?: THREE.Vector3;
    arrowNormal?: THREE.Vector3;
    handleId?: string;
    planeGizmo?: {
      origin: THREE.Vector3;
      normal: THREE.Vector3;
      xAxis: THREE.Vector3;
    };
  } | null = null;
  private planeGizmoConfig: {
    origin: THREE.Vector3;
    normal: THREE.Vector3;
    xAxis: THREE.Vector3;
  } | null = null;
  private arrowConfig: {
    origin: THREE.Vector3;
    normal: THREE.Vector3;
    distance: number;
    direction: 'forward' | 'reverse';
  } | null = null;
  private arrowHovered = false;
  private boundPointerMove: ((e: PointerEvent) => void) | null = null;
  private boundPointerDown: ((e: PointerEvent) => void) | null = null;
  private boundPointerUp: ((e: PointerEvent) => void) | null = null;
  private facePickCallback: ((info: { point: THREE.Vector3; normal: THREE.Vector3; boundaryLoops: [number, number, number][][] }) => void) | null = null;
  private facePickDownPos: { x: number; y: number } | null = null;
  private highlightedFaceId: number | null = null;
  private edgeWireframeGroup: THREE.Group;
  private edgeHighlightGroup: THREE.Group;
  private edgeSelectionGroup: THREE.Group;
  private edgePickCallback: ((edgeIndex: number) => void) | null = null;
  private edgePickDownPos: { x: number; y: number } | null = null;
  private highlightedEdgeIndex: number | null = null;
  private edgeRanges: EdgeData['edgeRanges'] = [];
  private outlineEdgeRanges: EdgeData['edgeRanges'] = [];

  constructor(opts: PartViewportOptions) {
    const { container } = opts;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(opts.background ?? '#0f172a');

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    // Position: front-right, elevated — makes the XY grid plane obvious
    this.camera.position.set(100, -80, 60);
    this.camera.up.set(0, 0, 1); // Z is up, matching sketch convention
    this.camera.lookAt(0, 0, 0);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;

    // Environment map — neutral studio lighting for per-face shading variation
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    pmremGenerator.compileEquirectangularShader();
    const envScene = new RoomEnvironment();
    this.scene.environment = pmremGenerator.fromScene(envScene).texture;
    pmremGenerator.dispose();

    // Lights — supplement the environment map with directional lights for stronger shadows
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(50, 80, 70);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xc8d6e5, 0.3);
    fillLight.position.set(-60, -30, 40);
    this.scene.add(fillLight);

    // Grid on XY plane (rotated from default XZ)
    const grid = new THREE.GridHelper(200, 20, 0x334155, 0x1e293b);
    grid.rotation.x = Math.PI / 2; // Rotate to XY plane
    this.scene.add(grid);

    // Axes helper
    const axes = new THREE.AxesHelper(30);
    this.scene.add(axes);

    // Mesh group
    this.meshGroup = new THREE.Group();
    this.scene.add(this.meshGroup);

    // Preview group (semi-transparent preview mesh)
    this.previewGroup = new THREE.Group();
    this.scene.add(this.previewGroup);

    // Edge outline group (always-visible wireframe-on-shaded lines)
    this.outlineGroup = new THREE.Group();
    this.outlineGroup.renderOrder = 1;
    this.scene.add(this.outlineGroup);

    // Sketch overlay group (3D sketch lines + plane quad — active/selected feature)
    this.sketchOverlayGroup = new THREE.Group();
    this.scene.add(this.sketchOverlayGroup);

    // Persistent sketch plane overlays for all committed features
    this.sketchPlanesGroup = new THREE.Group();
    this.scene.add(this.sketchPlanesGroup);

    // Gizmo group (arrow handle for extrude drag)
    this.gizmoGroup = new THREE.Group();
    this.gizmoGroup.renderOrder = 999;
    this.scene.add(this.gizmoGroup);

    // Plane gizmo group (3-axis handles for plane manipulation)
    this.planeGizmoGroup = new THREE.Group();
    this.planeGizmoGroup.renderOrder = 999;
    this.scene.add(this.planeGizmoGroup);

    // Face highlight overlay group
    this.faceHighlightGroup = new THREE.Group();
    this.faceHighlightGroup.renderOrder = 998;
    this.scene.add(this.faceHighlightGroup);

    // Edge picking groups
    this.edgeWireframeGroup = new THREE.Group();
    this.edgeWireframeGroup.renderOrder = 997;
    this.scene.add(this.edgeWireframeGroup);

    this.edgeHighlightGroup = new THREE.Group();
    this.edgeHighlightGroup.renderOrder = 999;
    this.scene.add(this.edgeHighlightGroup);

    this.edgeSelectionGroup = new THREE.Group();
    this.edgeSelectionGroup.renderOrder = 999;
    this.scene.add(this.edgeSelectionGroup);

    // Handle resize
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
    this.handleResize();

    // Start render loop
    this.animate();
  }

  setBackground(color: string) {
    this.scene.background = new THREE.Color(color);
  }

  setMeshes(geometries: THREE.BufferGeometry[], edgeData?: EdgeData | null) {
    // Clear existing meshes
    while (this.meshGroup.children.length > 0) {
      const child = this.meshGroup.children[0]!;
      this.meshGroup.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
    }

    // Add new meshes — neutral gray material similar to Fusion 360
    const material = new THREE.MeshStandardMaterial({
      color: 0x8c9bab,
      metalness: 0.15,
      roughness: 0.45,
      side: THREE.DoubleSide,
      envMapIntensity: 0.8,
    });

    for (const geometry of geometries) {
      const mesh = new THREE.Mesh(geometry, material.clone());
      this.meshGroup.add(mesh);
    }

    // Update edge outlines
    this.setOutlineEdges(edgeData ?? null);
  }

  setPreviewMesh(geometry: THREE.BufferGeometry | null, edgeData?: EdgeData | null) {
    this.clearGroup(this.previewGroup);
    if (!geometry) {
      this.setOutlineEdges(null);
      return;
    }

    const material = new THREE.MeshStandardMaterial({
      color: 0x8c9bab,
      metalness: 0.15,
      roughness: 0.45,
      side: THREE.DoubleSide,
      envMapIntensity: 0.8,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    this.previewGroup.add(mesh);

    // Show edge outlines on preview too
    if (edgeData) this.setOutlineEdges(edgeData);
  }

  private setOutlineEdges(edgeData: EdgeData | null) {
    this.clearGroup(this.outlineGroup);
    this.outlineEdgeRanges = [];
    // Only clear edge highlight if no explicit edge pick wireframe is active
    if (this.edgeWireframeGroup.children.length === 0) {
      this.clearEdgeHighlight();
    }
    if (!edgeData || edgeData.positions.length === 0) return;

    this.outlineEdgeRanges = edgeData.edgeRanges;
    // Use fat lines for crisp, resolution-independent edge rendering
    const container = this.renderer.domElement.parentElement;
    const w = container?.clientWidth ?? 1;
    const h = container?.clientHeight ?? 1;
    const edgeGeo = new LineSegmentsGeometry();
    edgeGeo.setPositions(Array.from(edgeData.positions));
    const edgeMat = new LineMaterial({
      color: 0x2d3748,
      linewidth: 1.5,
      resolution: new THREE.Vector2(w, h),
    });
    const lines = new LineSegments2(edgeGeo, edgeMat);
    lines.computeLineDistances();
    this.outlineGroup.add(lines);

    // Also add a thin THREE.LineSegments for raycasting (LineSegments2 doesn't support it)
    const raycastGeo = new THREE.BufferGeometry();
    raycastGeo.setAttribute('position', new THREE.BufferAttribute(edgeData.positions, 3));
    const raycastMat = new THREE.LineBasicMaterial({ visible: false });
    const raycastLines = new THREE.LineSegments(raycastGeo, raycastMat);
    this.outlineGroup.add(raycastLines);

    // Start listening for hover if not already listening
    this.ensurePointerListeners();
  }

  setSketchOverlay(
    linePositions: Float32Array | null,
    planeInfo: { center: [number, number, number]; normal: [number, number, number]; xAxis: [number, number, number]; size: number } | null,
  ) {
    this.clearGroup(this.sketchOverlayGroup);

    if (linePositions && linePositions.length > 0) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
      const lineMaterial = new THREE.LineBasicMaterial({ color: 0xfbbf24, linewidth: 2 });
      const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
      this.sketchOverlayGroup.add(lines);
    }

    if (planeInfo) {
      const planeGeometry = new THREE.PlaneGeometry(planeInfo.size, planeInfo.size);
      const planeMaterial = new THREE.MeshBasicMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const planeMesh = new THREE.Mesh(planeGeometry, planeMaterial);

      // Orient plane: compute yAxis = normal × xAxis
      const n = new THREE.Vector3(...planeInfo.normal);
      const x = new THREE.Vector3(...planeInfo.xAxis);
      const y = new THREE.Vector3().crossVectors(n, x);

      // Build rotation matrix from axes
      const m = new THREE.Matrix4();
      m.makeBasis(x, y, n);
      planeMesh.setRotationFromMatrix(m);
      planeMesh.position.set(...planeInfo.center);
      this.sketchOverlayGroup.add(planeMesh);
    }
  }

  /** Show persistent sketch plane overlays for all committed features. */
  setSketchPlaneOverlays(
    overlays: {
      linePositions: Float32Array;
      center: [number, number, number];
      normal: [number, number, number];
      xAxis: [number, number, number];
      size: number;
    }[],
  ) {
    this.clearGroup(this.sketchPlanesGroup);

    for (const overlay of overlays) {
      // Sketch wireframe lines
      if (overlay.linePositions.length > 0) {
        const lineGeometry = new THREE.BufferGeometry();
        lineGeometry.setAttribute('position', new THREE.BufferAttribute(overlay.linePositions, 3));
        const lineMaterial = new THREE.LineBasicMaterial({
          color: 0x94a3b8,
          linewidth: 1,
          transparent: true,
          opacity: 0.5,
        });
        const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
        this.sketchPlanesGroup.add(lines);
      }

      // Translucent plane quad
      const planeGeometry = new THREE.PlaneGeometry(overlay.size, overlay.size);
      const planeMaterial = new THREE.MeshBasicMaterial({
        color: 0x94a3b8,
        transparent: true,
        opacity: 0.04,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const planeMesh = new THREE.Mesh(planeGeometry, planeMaterial);

      const n = new THREE.Vector3(...overlay.normal);
      const x = new THREE.Vector3(...overlay.xAxis);
      const y = new THREE.Vector3().crossVectors(n, x);
      const m = new THREE.Matrix4();
      m.makeBasis(x, y, n);
      planeMesh.setRotationFromMatrix(m);
      planeMesh.position.set(...overlay.center);
      this.sketchPlanesGroup.add(planeMesh);
    }
  }

  clearSketchPlaneOverlays() {
    this.clearGroup(this.sketchPlanesGroup);
  }

  clearPreview() {
    this.clearGroup(this.previewGroup);
    this.clearGroup(this.sketchOverlayGroup);
  }

  setExtrudeArrow(
    origin: [number, number, number],
    normal: [number, number, number],
    distance: number,
    direction: 'forward' | 'reverse',
  ) {
    const o = new THREE.Vector3(...origin);
    const n = new THREE.Vector3(...normal).normalize();
    this.arrowConfig = { origin: o, normal: n, distance, direction };
    this.rebuildArrow();
  }

  clearExtrudeArrow() {
    this.arrowConfig = null;
    this.clearGroup(this.gizmoGroup);
  }

  setPlaneGizmo(
    origin: [number, number, number],
    normal: [number, number, number],
    xAxis: [number, number, number],
  ) {
    this.clearGroup(this.planeGizmoGroup);
    const o = new THREE.Vector3(...origin);
    const n = new THREE.Vector3(...normal).normalize();
    const x = new THREE.Vector3(...xAxis).normalize();
    const y = new THREE.Vector3().crossVectors(x, n).normalize();
    this.planeGizmoConfig = { origin: o.clone(), normal: n.clone(), xAxis: x.clone() };
    this.buildHandle(o, n, HANDLE_COLORS.normal!, 'normal');
    this.buildHandle(o, x, HANDLE_COLORS.x!, 'x');
    this.buildHandle(o, y, HANDLE_COLORS.y!, 'y');
    this.buildRing(o, n, x, y, RING_COLORS.spin!, 'spin', Math.PI * 2);
    this.buildRing(o, x, y, n, RING_COLORS.tilt!, 'tilt', Math.PI);
  }

  clearPlaneGizmo() {
    this.planeGizmoConfig = null;
    this.clearGroup(this.planeGizmoGroup);
  }

  private buildHandle(origin: THREE.Vector3, dir: THREE.Vector3, color: number, handleId: string) {
    const shaftCenter = origin.clone().addScaledVector(dir, HANDLE_SHAFT_LENGTH / 2);
    const headCenter = origin.clone().addScaledVector(dir, HANDLE_SHAFT_LENGTH + HANDLE_HEAD_HEIGHT / 2);
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false });

    const shaftGeo = new THREE.CylinderGeometry(HANDLE_SHAFT_RADIUS, HANDLE_SHAFT_RADIUS, HANDLE_SHAFT_LENGTH, 8);
    const shaft = new THREE.Mesh(shaftGeo, material);
    shaft.position.copy(shaftCenter);
    shaft.userData.handleId = handleId;

    const headGeo = new THREE.ConeGeometry(HANDLE_HEAD_RADIUS, HANDLE_HEAD_HEIGHT, 12);
    const head = new THREE.Mesh(headGeo, material.clone());
    head.position.copy(headCenter);
    head.userData.handleId = handleId;

    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    shaft.setRotationFromQuaternion(quat);
    head.setRotationFromQuaternion(quat);

    this.planeGizmoGroup.add(shaft);
    this.planeGizmoGroup.add(head);
  }

  /**
   * Build a rotation ring (torus) around a given axis.
   * ringAxis: the rotation axis (normal for spin, xAxis for tilt)
   * ringX, ringY: two axes in the ring plane (for orientation)
   * arc: angle of the ring in radians (2π for full circle, π for semi-circle)
   */
  private buildRing(
    origin: THREE.Vector3,
    ringAxis: THREE.Vector3,
    ringX: THREE.Vector3,
    ringY: THREE.Vector3,
    color: number,
    handleId: string,
    arc: number,
  ) {
    const torusGeo = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE_RADIUS, 8, 32, arc);
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false });
    const torus = new THREE.Mesh(torusGeo, material);
    torus.userData.handleId = handleId;

    // TorusGeometry lies in the XY plane with Z as the ring axis.
    // We need to orient it so ringAxis is the ring's axis.
    const m = new THREE.Matrix4();
    m.makeBasis(ringX, ringY, ringAxis);
    torus.setRotationFromMatrix(m);
    torus.position.copy(origin);

    this.planeGizmoGroup.add(torus);
  }

  private rebuildArrow() {
    this.clearGroup(this.gizmoGroup);
    if (!this.arrowConfig) return;

    const { origin, normal, distance, direction } = this.arrowConfig;
    const sign = direction === 'reverse' ? -1 : 1;

    // Tip of the extrusion = origin + distance * normal * sign
    const extrudeTip = origin.clone().addScaledVector(normal, distance * sign);

    // outward = direction away from body along the extrude axis
    const outward = normal.clone().multiplyScalar(sign);

    // Shaft extends from extrudeTip outward; cone sits at far end with tip pointing outward
    const shaftCenter = extrudeTip.clone().addScaledVector(outward, ARROW_SHAFT_LENGTH / 2);
    const headCenter = extrudeTip.clone().addScaledVector(outward, ARROW_SHAFT_LENGTH + ARROW_HEAD_HEIGHT / 2);

    const color = this.arrowHovered ? ARROW_HOVER_COLOR : ARROW_COLOR;
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false });

    // Shaft
    const shaftGeo = new THREE.CylinderGeometry(ARROW_SHAFT_RADIUS, ARROW_SHAFT_RADIUS, ARROW_SHAFT_LENGTH, 8);
    const shaft = new THREE.Mesh(shaftGeo, material);
    shaft.position.copy(shaftCenter);

    // Head — ConeGeometry tip (radius=0) is at +Y, base at -Y.
    // We want the tip pointing outward (same as `outward`).
    const headGeo = new THREE.ConeGeometry(ARROW_HEAD_RADIUS, ARROW_HEAD_HEIGHT, 12);
    const head = new THREE.Mesh(headGeo, material.clone());
    head.position.copy(headCenter);

    // Rotate +Y to outward direction
    const quat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      outward,
    );
    shaft.setRotationFromQuaternion(quat);
    head.setRotationFromQuaternion(quat);

    this.gizmoGroup.add(shaft);
    this.gizmoGroup.add(head);
  }

  private updateArrowDuringDrag(newValue: number, isNegative: boolean) {
    if (!this.activeDrag?.arrowOrigin || !this.activeDrag?.arrowNormal) return;
    const direction: 'forward' | 'reverse' = isNegative ? 'reverse' : 'forward';
    this.arrowConfig = {
      origin: this.activeDrag.arrowOrigin,
      normal: this.activeDrag.arrowNormal,
      distance: newValue,
      direction,
    };
    this.rebuildArrow();
  }

  private updatePlaneGizmoDuringDrag(signedNewValue: number) {
    if (!this.activeDrag?.planeGizmo) return;
    const delta = signedNewValue - this.activeDrag.initialValue;
    const newOrigin = this.activeDrag.planeGizmo.origin.clone()
      .addScaledVector(this.activeDrag.axisDir, delta);
    const pg = this.activeDrag.planeGizmo;
    this.setPlaneGizmo(
      [newOrigin.x, newOrigin.y, newOrigin.z],
      [pg.normal.x, pg.normal.y, pg.normal.z],
      [pg.xAxis.x, pg.xAxis.y, pg.xAxis.z],
    );
  }

  private clearGroup(group: THREE.Group) {
    while (group.children.length > 0) {
      const child = group.children[0]!;
      group.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
    }
  }

  private handleResize() {
    const container = this.renderer.domElement.parentElement;
    if (!container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    // Update resolution for fat line materials
    const res = new THREE.Vector2(w, h);
    for (const group of [this.outlineGroup, this.edgeHighlightGroup, this.edgeSelectionGroup]) {
      for (const child of group.children) {
        if (child instanceof LineSegments2) {
          (child.material as LineMaterial).resolution = res;
        }
      }
    }
  }

  private animate = () => {
    this.animationId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  enableDragInteraction(callbacks: DragInteractionCallbacks) {
    this.disableDragInteraction();
    this.dragCallbacks = callbacks;
    this.ensurePointerListeners();
  }

  disableDragInteraction() {
    this.dragCallbacks = null;
    this.activeDrag = null;
    this.clearExtrudeArrow();
    this.clearPlaneGizmo();
    // Remove pointer listeners only if face and edge picking are also inactive and no outlines
    if (!this.facePickCallback && !this.edgePickCallback && this.outlineEdgeRanges.length === 0) {
      this.removePointerListeners();
    }
  }

  private getNdc(e: PointerEvent): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private projectOntoAxis(ndc: THREE.Vector2): number {
    if (!this.activeDrag) return 0;
    this.raycaster.setFromCamera(ndc, this.camera);
    const { axisOrigin, axisDir } = this.activeDrag;
    const R = this.raycaster.ray.origin;
    const D = this.raycaster.ray.direction;

    // Closest point between two lines:
    // Line 1: P(t) = axisOrigin + t * axisDir
    // Line 2: Q(s) = R + s * D
    // With w = R - axisOrigin, t = (d - b*e) / (1 - b²)
    const w = new THREE.Vector3().subVectors(R, axisOrigin);
    const b = axisDir.dot(D);
    const d = axisDir.dot(w);
    const e = D.dot(w);
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-6) return this.activeDrag.initialT; // Lines parallel
    return (d - b * e) / denom;
  }

  private handlePointerMove(e: PointerEvent) {
    const ndc = this.getNdc(e);
    const canvas = this.renderer.domElement;

    if (this.activeDrag) {
      const t = this.projectOntoAxis(ndc);
      const delta = t - this.activeDrag.initialT;
      const newValue = this.activeDrag.initialValue + delta;
      const absValue = Math.abs(newValue);
      const isNeg = newValue < 0;
      this.dragCallbacks?.onDrag(absValue, isNeg, this.activeDrag.handleId);
      this.updateArrowDuringDrag(absValue, isNeg);
      this.updatePlaneGizmoDuringDrag(newValue);
      return;
    }

    // Hover detection — target gizmo handles or arrow or preview mesh
    if (this.dragCallbacks) {
      this.raycaster.setFromCamera(ndc, this.camera);
      const target = this.planeGizmoGroup.children.length > 0 ? this.planeGizmoGroup
        : this.gizmoGroup.children.length > 0 ? this.gizmoGroup
        : this.previewGroup;
      const hits = this.raycaster.intersectObjects(target.children, true);
      const hovering = hits.length > 0;
      canvas.style.cursor = hovering ? 'grab' : '';

      // Update arrow highlight
      if (this.gizmoGroup.children.length > 0 && hovering !== this.arrowHovered) {
        this.arrowHovered = hovering;
        this.rebuildArrow();
      }
    }

    // Edge hover highlight (always when outlines visible, or during edge picking)
    if (!this.activeDrag && (this.edgePickCallback || this.outlineEdgeRanges.length > 0)) {
      this.updateEdgeHighlight(ndc);
    }

    // Face picking hover highlight
    if (this.facePickCallback && !this.activeDrag) {
      this.updateFaceHighlight(ndc);
    }
  }

  private handlePointerDown(e: PointerEvent) {
    if (e.button !== 0) return;

    // Record position for face pick click detection
    if (this.facePickCallback) {
      this.facePickDownPos = { x: e.clientX, y: e.clientY };
    }
    // Record position for edge pick click detection
    if (this.edgePickCallback) {
      this.edgePickDownPos = { x: e.clientX, y: e.clientY };
    }

    if (!this.dragCallbacks) return;

    const ndc = this.getNdc(e);
    this.raycaster.setFromCamera(ndc, this.camera);
    // Raycast against plane gizmo, arrow gizmo, or preview mesh (in priority order)
    const target = this.planeGizmoGroup.children.length > 0 ? this.planeGizmoGroup
      : this.gizmoGroup.children.length > 0 ? this.gizmoGroup
      : this.previewGroup;
    const hits = this.raycaster.intersectObjects(target.children, true);
    if (hits.length === 0) return;

    // If face picking is active, let model geometry take priority over gizmo handles
    // (gizmo handles render on top via depthTest:false but may be physically behind the model)
    if (this.facePickCallback && target !== this.previewGroup) {
      const modelTarget = this.getFacePickTarget();
      if (modelTarget) {
        const modelHits = this.raycaster.intersectObjects(modelTarget.children, true);
        if (modelHits.length > 0 && modelHits[0]!.distance < hits[0]!.distance) {
          return; // Model surface is closer — let face pick handle this click
        }
      }
    }

    const hit = hits[0]!;
    const hitPoint = hit.point;
    const handleId = hit.object.userData?.handleId as string | undefined;
    const result = this.dragCallbacks.onDragStart([hitPoint.x, hitPoint.y, hitPoint.z], handleId);
    if (!result) return;

    const axisDir = new THREE.Vector3(...result.axis).normalize();
    const axisOrigin = hitPoint.clone();

    // Compute initial t
    const R = this.raycaster.ray.origin;
    const D = this.raycaster.ray.direction;
    const w = new THREE.Vector3().subVectors(R, axisOrigin);
    const b2 = axisDir.dot(D);
    const d2 = axisDir.dot(w);
    const e2 = D.dot(w);
    const denom = 1 - b2 * b2;
    const initialT = Math.abs(denom) < 1e-6 ? 0 : (d2 - b2 * e2) / denom;

    this.activeDrag = {
      axisOrigin,
      axisDir,
      initialT,
      initialValue: result.initialValue,
      arrowOrigin: this.arrowConfig?.origin.clone(),
      arrowNormal: this.arrowConfig?.normal.clone(),
      handleId,
      planeGizmo: this.planeGizmoConfig ? {
        origin: this.planeGizmoConfig.origin.clone(),
        normal: this.planeGizmoConfig.normal.clone(),
        xAxis: this.planeGizmoConfig.xAxis.clone(),
      } : undefined,
    };
    this.controls.enabled = false;
    this.renderer.domElement.style.cursor = 'grabbing';
    this.renderer.domElement.setPointerCapture(e.pointerId);
  }

  private handlePointerUp(e: PointerEvent) {
    if (this.activeDrag) {
      this.activeDrag = null;
      this.controls.enabled = true;
      this.renderer.domElement.style.cursor = '';
      this.arrowHovered = false;
      this.rebuildArrow();
      this.dragCallbacks?.onDragEnd?.();
      this.facePickDownPos = null;
      return;
    }

    // Face pick: only fire if pointer barely moved (< 3px), distinguishing click from orbit
    if (this.facePickCallback && this.facePickDownPos) {
      const dx = e.clientX - this.facePickDownPos.x;
      const dy = e.clientY - this.facePickDownPos.y;
      this.facePickDownPos = null;

      if (dx * dx + dy * dy < 9) {
        const ndc = this.getNdc(e);
        const target = this.getFacePickTarget();
        if (target) {
          this.raycaster.setFromCamera(ndc, this.camera);
          const hits = this.raycaster.intersectObjects(target.children, true);
          if (hits.length > 0) {
            const hit = hits[0]!;
            const geometry = (hit.object as THREE.Mesh).geometry as THREE.BufferGeometry;
            if (hit.faceIndex != null) {
              const faceNormal = this.computeHitNormal(geometry, hit);
              const boundaryLoops = this.extractFaceBoundary(geometry, hit);
              this.facePickCallback({ point: hit.point.clone(), normal: faceNormal, boundaryLoops });
            }
          }
        }
      }
    }

    // Edge pick: only fire if pointer barely moved (< 3px)
    if (this.edgePickCallback && this.edgePickDownPos) {
      const dx = e.clientX - this.edgePickDownPos.x;
      const dy = e.clientY - this.edgePickDownPos.y;
      this.edgePickDownPos = null;

      if (dx * dx + dy * dy < 9 && this.highlightedEdgeIndex !== null) {
        this.edgePickCallback(this.highlightedEdgeIndex);
      }
    }
  }

  enableFacePicking(callback: (info: { point: THREE.Vector3; normal: THREE.Vector3; boundaryLoops: [number, number, number][][] }) => void) {
    this.disableFacePicking();
    this.facePickCallback = callback;
    this.ensurePointerListeners();
  }

  disableFacePicking() {
    this.facePickCallback = null;
    this.facePickDownPos = null;
    this.highlightedFaceId = null;
    this.clearGroup(this.faceHighlightGroup);
    // Remove pointer listeners only if drag and edge picking are also inactive and no outlines
    if (!this.dragCallbacks && !this.edgePickCallback && this.outlineEdgeRanges.length === 0) {
      this.removePointerListeners();
    }
  }

  private ensurePointerListeners() {
    if (this.boundPointerMove) return; // Already attached
    const canvas = this.renderer.domElement;
    this.boundPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
    this.boundPointerDown = (e: PointerEvent) => this.handlePointerDown(e);
    this.boundPointerUp = (e: PointerEvent) => this.handlePointerUp(e);
    canvas.addEventListener('pointermove', this.boundPointerMove);
    canvas.addEventListener('pointerdown', this.boundPointerDown);
    canvas.addEventListener('pointerup', this.boundPointerUp);
  }

  private removePointerListeners() {
    const canvas = this.renderer.domElement;
    if (this.boundPointerMove) canvas.removeEventListener('pointermove', this.boundPointerMove);
    if (this.boundPointerDown) canvas.removeEventListener('pointerdown', this.boundPointerDown);
    if (this.boundPointerUp) canvas.removeEventListener('pointerup', this.boundPointerUp);
    this.boundPointerMove = null;
    this.boundPointerDown = null;
    this.boundPointerUp = null;
  }

  private getFacePickTarget(): THREE.Group | null {
    if (this.meshGroup.children.length > 0) return this.meshGroup;
    if (this.previewGroup.children.length > 0) return this.previewGroup;
    return null;
  }

  private updateFaceHighlight(ndc: THREE.Vector2) {
    const target = this.getFacePickTarget();
    if (!target) {
      this.clearFaceHighlight();
      return;
    }

    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(target.children, true);
    if (hits.length === 0) {
      this.clearFaceHighlight();
      return;
    }

    const hit = hits[0]!;
    const mesh = hit.object as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const faceIdAttr = geometry.getAttribute('faceId');
    if (!faceIdAttr || hit.faceIndex == null) {
      this.clearFaceHighlight();
      return;
    }

    const index = geometry.getIndex();
    if (!index) {
      this.clearFaceHighlight();
      return;
    }

    // Get faceId from the first vertex of the hit triangle
    const vertIdx = index.getX(hit.faceIndex * 3);
    const hitFaceId = faceIdAttr.getX(vertIdx);

    if (hitFaceId === this.highlightedFaceId) return; // Already highlighted
    this.highlightedFaceId = hitFaceId;

    this.clearGroup(this.faceHighlightGroup);

    // Build highlight mesh from faceRanges
    const faceRanges = geometry.userData.faceRanges as { start: number; count: number }[] | undefined;
    if (!faceRanges || !faceRanges[hitFaceId]) return;

    const range = faceRanges[hitFaceId]!;
    const posAttr = geometry.getAttribute('position');

    const highlightPositions: number[] = [];
    for (let i = range.start; i < range.start + range.count; i++) {
      const vi = index.getX(i);
      highlightPositions.push(posAttr.getX(vi), posAttr.getY(vi), posAttr.getZ(vi));
    }

    const highlightGeometry = new THREE.BufferGeometry();
    highlightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(highlightPositions, 3));
    const highlightMaterial = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    const highlightMesh = new THREE.Mesh(highlightGeometry, highlightMaterial);
    // Copy world transform from the source mesh
    highlightMesh.matrixAutoUpdate = false;
    highlightMesh.matrix.copy(mesh.matrixWorld);
    this.faceHighlightGroup.add(highlightMesh);
  }

  private clearFaceHighlight() {
    if (this.highlightedFaceId === null) return;
    this.highlightedFaceId = null;
    this.clearGroup(this.faceHighlightGroup);
  }

  /** Interpolate vertex normals at the hit point using barycentric coordinates. */
  private computeHitNormal(geometry: THREE.BufferGeometry, hit: THREE.Intersection): THREE.Vector3 {
    const normalAttr = geometry.getAttribute('normal');
    const posAttr = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!normalAttr || !posAttr || !index || hit.faceIndex == null) {
      return new THREE.Vector3(0, 0, 1);
    }

    const i0 = index.getX(hit.faceIndex * 3);
    const i1 = index.getX(hit.faceIndex * 3 + 1);
    const i2 = index.getX(hit.faceIndex * 3 + 2);

    const a = new THREE.Vector3(posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0));
    const b = new THREE.Vector3(posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1));
    const c = new THREE.Vector3(posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2));

    const bary = new THREE.Vector3();
    THREE.Triangle.getBarycoord(hit.point, a, b, c, bary);

    const nA = new THREE.Vector3(normalAttr.getX(i0), normalAttr.getY(i0), normalAttr.getZ(i0));
    const nB = new THREE.Vector3(normalAttr.getX(i1), normalAttr.getY(i1), normalAttr.getZ(i1));
    const nC = new THREE.Vector3(normalAttr.getX(i2), normalAttr.getY(i2), normalAttr.getZ(i2));

    return new THREE.Vector3()
      .addScaledVector(nA, bary.x)
      .addScaledVector(nB, bary.y)
      .addScaledVector(nC, bary.z)
      .normalize();
  }

  /**
   * Extract boundary edge loops of the picked face from the tessellated geometry.
   * Boundary edges are triangle edges that appear exactly once within the face.
   */
  private extractFaceBoundary(geometry: THREE.BufferGeometry, hit: THREE.Intersection): [number, number, number][][] {
    const faceIdAttr = geometry.getAttribute('faceId');
    const posAttr = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!faceIdAttr || !posAttr || !index || hit.faceIndex == null) return [];

    // Get the faceId of the hit triangle
    const vertIdx = index.getX(hit.faceIndex * 3);
    const hitFaceId = faceIdAttr.getX(vertIdx);

    // Use faceRanges for efficient iteration
    const faceRanges = geometry.userData.faceRanges as { start: number; count: number }[] | undefined;
    if (!faceRanges || !faceRanges[hitFaceId]) return [];
    const range = faceRanges[hitFaceId]!;

    // Collect all triangle edges for this face, counting occurrences
    // Edge key: sorted pair of vertex indices
    const edgeCounts = new Map<string, [number, number]>();
    for (let i = range.start; i < range.start + range.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      for (const [v0, v1] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const key = v0 < v1 ? `${v0}_${v1}` : `${v1}_${v0}`;
        if (edgeCounts.has(key)) {
          edgeCounts.delete(key); // Appears twice → interior edge
        } else {
          edgeCounts.set(key, [v0, v1]);
        }
      }
    }

    if (edgeCounts.size === 0) return [];

    // Build adjacency: vertex → list of connected vertices
    const adjacency = new Map<number, number[]>();
    for (const [v0, v1] of edgeCounts.values()) {
      if (!adjacency.has(v0)) adjacency.set(v0, []);
      if (!adjacency.has(v1)) adjacency.set(v1, []);
      adjacency.get(v0)!.push(v1);
      adjacency.get(v1)!.push(v0);
    }

    // Walk connected loops
    const visited = new Set<number>();
    const loops: [number, number, number][][] = [];

    for (const startVert of adjacency.keys()) {
      if (visited.has(startVert)) continue;

      const loop: [number, number, number][] = [];
      let current = startVert;
      let prev = -1;

      while (!visited.has(current)) {
        visited.add(current);
        loop.push([posAttr.getX(current), posAttr.getY(current), posAttr.getZ(current)]);

        const neighbors = adjacency.get(current) ?? [];
        const next = neighbors.find((n) => n !== prev);
        if (next === undefined) break;
        prev = current;
        current = next;
      }

      // Close the loop if it returns to start
      if (current === startVert && loop.length > 2) {
        loop.push(loop[0]!);
      }

      if (loop.length >= 2) loops.push(loop);
    }

    return loops;
  }

  setEdgeWireframe(edgeData: EdgeData | null) {
    this.clearGroup(this.edgeWireframeGroup);
    this.edgeRanges = [];

    if (!edgeData || edgeData.positions.length === 0) return;

    this.edgeRanges = edgeData.edgeRanges;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(edgeData.positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: 0xcbd5e1,
      depthTest: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    this.edgeWireframeGroup.add(lines);
  }

  isEdgePickingActive(): boolean {
    return this.edgePickCallback !== null;
  }

  enableEdgePicking(callback: (edgeIndex: number) => void) {
    this.edgePickCallback = callback;
    // Hide outline edges to avoid raycast conflicts with the dedicated edge wireframe
    this.outlineGroup.visible = false;
    this.ensurePointerListeners();
  }

  disableEdgePicking() {
    this.edgePickCallback = null;
    this.edgePickDownPos = null;
    this.highlightedEdgeIndex = null;
    this.clearGroup(this.edgeHighlightGroup);
    this.clearGroup(this.edgeSelectionGroup);
    this.outlineGroup.visible = true;
    this.clearGroup(this.edgeWireframeGroup);
    this.edgeRanges = [];
    // Remove pointer listeners only if drag and face pick are also inactive and no outlines
    if (!this.dragCallbacks && !this.facePickCallback && this.outlineEdgeRanges.length === 0) {
      this.removePointerListeners();
    }
  }

  /** Build a fat line (LineSegments2) from a flat positions array. */
  private buildFatLine(positions: number[], color: number, linewidth: number): LineSegments2 {
    const geo = new LineSegmentsGeometry();
    geo.setPositions(positions);
    const container = this.renderer.domElement.parentElement;
    const w = container?.clientWidth ?? 1;
    const h = container?.clientHeight ?? 1;
    const mat = new LineMaterial({
      color,
      linewidth,
      depthTest: false,
      resolution: new THREE.Vector2(w, h),
    });
    return new LineSegments2(geo, mat);
  }

  /** Extract positions array for a single edge from the wireframe geometry. */
  private getEdgePositions(edgeIndex: number): number[] | null {
    return this.getOutlineEdgePositions(edgeIndex, this.edgeWireframeGroup, this.edgeRanges);
  }

  private getOutlineEdgePositions(edgeIndex: number, group: THREE.Group, ranges: EdgeData['edgeRanges']): number[] | null {
    if (group.children.length === 0) return null;
    // For outline group, use the invisible raycast LineSegments (child[1]) geometry
    const wireChild = (group === this.outlineGroup && group.children.length > 1)
      ? group.children[1]!
      : group.children[0]!;
    const wireGeo = (wireChild as THREE.LineSegments).geometry;
    const posAttr = wireGeo.getAttribute('position');
    if (!posAttr) return null;

    const range = ranges.find((r) => r.edgeIndex === edgeIndex);
    if (!range) return null;

    const positions: number[] = [];
    const startVertex = range.start / 3;
    for (let i = 0; i < range.count; i++) {
      positions.push(
        posAttr.getX(startVertex + i),
        posAttr.getY(startVertex + i),
        posAttr.getZ(startVertex + i),
      );
    }
    return positions;
  }

  setSelectedEdges(edgeIndices: number[]) {
    this.clearGroup(this.edgeSelectionGroup);
    if (this.edgeRanges.length === 0) return;

    for (const idx of edgeIndices) {
      const positions = this.getEdgePositions(idx);
      if (!positions || positions.length < 6) continue;
      const line = this.buildFatLine(positions, 0x22c55e, 3);
      this.edgeSelectionGroup.add(line);
    }
  }

  private updateEdgeHighlight(ndc: THREE.Vector2) {
    // Pick the appropriate line group and edge ranges
    const useOutline = this.edgeWireframeGroup.children.length === 0 && this.outlineGroup.children.length > 0;
    const lineGroup = useOutline ? this.outlineGroup : this.edgeWireframeGroup;
    const ranges = useOutline ? this.outlineEdgeRanges : this.edgeRanges;

    if (lineGroup.children.length === 0) {
      this.clearEdgeHighlight();
      return;
    }

    this.raycaster.setFromCamera(ndc, this.camera);
    // Scale line picking threshold by camera distance for consistent screen-space feel
    const camDist = this.camera.position.distanceTo(this.controls.target);
    const params = this.raycaster.params;
    if (params.Line) {
      // Tighter threshold for hover-only mode, wider for edge pick mode (fillet/chamfer)
      params.Line.threshold = this.edgePickCallback
        ? Math.max(camDist * 0.03, 3)
        : Math.max(camDist * 0.015, 1.5);
    }

    // For outline group, raycast against the invisible LineSegments (child[1]), not the fat LineSegments2
    const raycastTargets = (lineGroup === this.outlineGroup && lineGroup.children.length > 1)
      ? [lineGroup.children[1]!]
      : lineGroup.children;
    const hits = this.raycaster.intersectObjects(raycastTargets, true);
    if (hits.length === 0) {
      this.clearEdgeHighlight();
      return;
    }

    const hit = hits[0]!;
    const hitIndex = hit.index;
    if (hitIndex == null) {
      this.clearEdgeHighlight();
      return;
    }

    // Determine which edge range contains this hit vertex index
    // hitIndex is the vertex pair index in the LineSegments buffer
    const hitVertex = hitIndex; // LineSegments: each pair is 2 vertices
    let foundEdge: number | null = null;
    for (const range of ranges) {
      const startVertex = range.start / 3;
      if (hitVertex >= startVertex && hitVertex < startVertex + range.count) {
        foundEdge = range.edgeIndex;
        break;
      }
    }

    if (foundEdge === null) {
      this.clearEdgeHighlight();
      return;
    }

    if (foundEdge === this.highlightedEdgeIndex) return; // Already highlighted
    this.highlightedEdgeIndex = foundEdge;

    this.clearGroup(this.edgeHighlightGroup);

    // Build amber fat-line highlight for this edge
    const positions = this.getOutlineEdgePositions(foundEdge, lineGroup, ranges);
    if (!positions || positions.length < 6) return;

    const line = this.buildFatLine(positions, 0xf59e0b, 4);
    this.edgeHighlightGroup.add(line);
    this.renderer.domElement.style.cursor = 'pointer';
  }

  private clearEdgeHighlight() {
    if (this.highlightedEdgeIndex === null) return;
    this.highlightedEdgeIndex = null;
    this.clearGroup(this.edgeHighlightGroup);
    this.renderer.domElement.style.cursor = '';
  }

  dispose() {
    this.disableEdgePicking();
    this.disableFacePicking();
    this.disableDragInteraction();
    this.removePointerListeners();
    cancelAnimationFrame(this.animationId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.domElement.remove();
    this.renderer.dispose();
  }
}
