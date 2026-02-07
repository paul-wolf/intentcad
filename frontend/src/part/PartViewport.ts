import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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

  dispose() {
    cancelAnimationFrame(this.animationId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.domElement.remove();
    this.renderer.dispose();
  }
}
