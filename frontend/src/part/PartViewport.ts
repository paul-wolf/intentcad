import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { EdgeData } from './occt/tessellate';

export interface DragInteractionCallbacks {
  onDragStart: (hitPoint: [number, number, number]) => {
    axis: [number, number, number];
    initialValue: number;
  } | null;
  onDrag: (newValue: number, isNegative: boolean) => void;
  onDragEnd?: () => void;
}

const ARROW_SHAFT_RADIUS = 0.8;
const ARROW_SHAFT_LENGTH = 15;
const ARROW_HEAD_RADIUS = 2.5;
const ARROW_HEAD_HEIGHT = 6;
const ARROW_COLOR = 0xf59e0b;
const ARROW_HOVER_COLOR = 0xffffff;

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
  private gizmoGroup: THREE.Group;
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
  private facePickCallback: ((info: { point: THREE.Vector3; normal: THREE.Vector3 }) => void) | null = null;
  private facePickDownPos: { x: number; y: number } | null = null;
  private highlightedFaceId: number | null = null;
  private edgeWireframeGroup: THREE.Group;
  private edgeHighlightGroup: THREE.Group;
  private edgeSelectionGroup: THREE.Group;
  private edgePickCallback: ((edgeIndex: number) => void) | null = null;
  private edgePickDownPos: { x: number; y: number } | null = null;
  private highlightedEdgeIndex: number | null = null;
  private edgeRanges: EdgeData['edgeRanges'] = [];

  constructor(opts: PartViewportOptions) {
    const { container } = opts;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
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

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(50, 100, 50);
    this.scene.add(directional);

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

    // Sketch overlay group (3D sketch lines + plane quad)
    this.sketchOverlayGroup = new THREE.Group();
    this.scene.add(this.sketchOverlayGroup);

    // Gizmo group (arrow handle for extrude drag)
    this.gizmoGroup = new THREE.Group();
    this.gizmoGroup.renderOrder = 999;
    this.scene.add(this.gizmoGroup);

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

  setMeshes(geometries: THREE.BufferGeometry[]) {
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

    // Add new meshes
    const material = new THREE.MeshStandardMaterial({
      color: 0x60a5fa,
      metalness: 0.2,
      roughness: 0.7,
      side: THREE.DoubleSide,
    });

    for (const geometry of geometries) {
      const mesh = new THREE.Mesh(geometry, material.clone());
      this.meshGroup.add(mesh);
    }
  }

  setPreviewMesh(geometry: THREE.BufferGeometry | null) {
    this.clearGroup(this.previewGroup);
    if (!geometry) return;

    const material = new THREE.MeshStandardMaterial({
      color: 0x60a5fa,
      metalness: 0.2,
      roughness: 0.7,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    this.previewGroup.add(mesh);
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
    // Remove pointer listeners only if face and edge picking are also inactive
    if (!this.facePickCallback && !this.edgePickCallback) {
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
      this.dragCallbacks?.onDrag(absValue, isNeg);
      this.updateArrowDuringDrag(absValue, isNeg);
      return;
    }

    // Hover detection — target gizmo arrow if present, else preview mesh
    if (this.dragCallbacks) {
      this.raycaster.setFromCamera(ndc, this.camera);
      const target = this.gizmoGroup.children.length > 0 ? this.gizmoGroup : this.previewGroup;
      const hits = this.raycaster.intersectObjects(target.children, true);
      const hovering = hits.length > 0;
      canvas.style.cursor = hovering ? 'grab' : '';

      // Update arrow highlight
      if (this.gizmoGroup.children.length > 0 && hovering !== this.arrowHovered) {
        this.arrowHovered = hovering;
        this.rebuildArrow();
      }
    }

    // Edge picking hover highlight
    if (this.edgePickCallback && !this.activeDrag) {
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
    // Raycast against gizmo arrow if present, else preview mesh
    const target = this.gizmoGroup.children.length > 0 ? this.gizmoGroup : this.previewGroup;
    const hits = this.raycaster.intersectObjects(target.children, true);
    if (hits.length === 0) return;

    const hitPoint = hits[0]!.point;
    const result = this.dragCallbacks.onDragStart([hitPoint.x, hitPoint.y, hitPoint.z]);
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
              this.facePickCallback({ point: hit.point.clone(), normal: faceNormal });
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

  enableFacePicking(callback: (info: { point: THREE.Vector3; normal: THREE.Vector3 }) => void) {
    this.disableFacePicking();
    this.facePickCallback = callback;
    this.ensurePointerListeners();
  }

  disableFacePicking() {
    this.facePickCallback = null;
    this.facePickDownPos = null;
    this.highlightedFaceId = null;
    this.clearGroup(this.faceHighlightGroup);
    // Remove pointer listeners only if drag and edge picking are also inactive
    if (!this.dragCallbacks && !this.edgePickCallback) {
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

  setEdgeWireframe(edgeData: EdgeData | null) {
    this.clearGroup(this.edgeWireframeGroup);
    this.edgeRanges = [];

    if (!edgeData || edgeData.positions.length === 0) return;

    this.edgeRanges = edgeData.edgeRanges;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(edgeData.positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: 0x94a3b8,
      depthTest: true,
    });
    const lines = new THREE.LineSegments(geometry, material);
    this.edgeWireframeGroup.add(lines);
  }

  enableEdgePicking(callback: (edgeIndex: number) => void) {
    this.edgePickCallback = callback;
    this.ensurePointerListeners();
  }

  disableEdgePicking() {
    this.edgePickCallback = null;
    this.edgePickDownPos = null;
    this.highlightedEdgeIndex = null;
    this.clearGroup(this.edgeHighlightGroup);
    this.clearGroup(this.edgeSelectionGroup);
    this.clearGroup(this.edgeWireframeGroup);
    this.edgeRanges = [];
    // Remove pointer listeners only if drag and face pick are also inactive
    if (!this.dragCallbacks && !this.facePickCallback) {
      this.removePointerListeners();
    }
  }

  setSelectedEdges(edgeIndices: number[]) {
    this.clearGroup(this.edgeSelectionGroup);
    if (this.edgeRanges.length === 0) return;

    const wireChildren = this.edgeWireframeGroup.children;
    if (wireChildren.length === 0) return;
    const wireGeo = (wireChildren[0] as THREE.LineSegments).geometry;
    const posAttr = wireGeo.getAttribute('position');
    if (!posAttr) return;

    const selectedSet = new Set(edgeIndices);

    for (const range of this.edgeRanges) {
      if (!selectedSet.has(range.edgeIndex)) continue;

      const positions: number[] = [];
      // range.start is byte/float offset in the positions array (already *3 for xyz)
      const startVertex = range.start / 3;
      for (let i = 0; i < range.count; i++) {
        positions.push(
          posAttr.getX(startVertex + i),
          posAttr.getY(startVertex + i),
          posAttr.getZ(startVertex + i),
        );
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0x22c55e,
        linewidth: 2,
        depthTest: false,
      });
      const line = new THREE.LineSegments(geo, mat);
      this.edgeSelectionGroup.add(line);
    }
  }

  private updateEdgeHighlight(ndc: THREE.Vector2) {
    if (this.edgeWireframeGroup.children.length === 0) {
      this.clearEdgeHighlight();
      return;
    }

    this.raycaster.setFromCamera(ndc, this.camera);
    // Set threshold for line picking (in world units, scaled by camera distance)
    const params = this.raycaster.params;
    if (params.Line) {
      params.Line.threshold = 3;
    }

    const hits = this.raycaster.intersectObjects(this.edgeWireframeGroup.children, true);
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
    for (const range of this.edgeRanges) {
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

    // Build amber highlight for this edge
    const wireGeo = (this.edgeWireframeGroup.children[0] as THREE.LineSegments).geometry;
    const posAttr = wireGeo.getAttribute('position');
    if (!posAttr) return;

    const range = this.edgeRanges.find((r) => r.edgeIndex === foundEdge);
    if (!range) return;

    const positions: number[] = [];
    const startVertex = range.start / 3;
    for (let i = 0; i < range.count; i++) {
      positions.push(
        posAttr.getX(startVertex + i),
        posAttr.getY(startVertex + i),
        posAttr.getZ(startVertex + i),
      );
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xf59e0b,
      linewidth: 2,
      depthTest: false,
    });
    const line = new THREE.LineSegments(geo, mat);
    this.edgeHighlightGroup.add(line);
    this.renderer.domElement.style.cursor = 'pointer';
  }

  private clearEdgeHighlight() {
    if (this.highlightedEdgeIndex === null) return;
    this.highlightedEdgeIndex = null;
    this.clearGroup(this.edgeHighlightGroup);
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
