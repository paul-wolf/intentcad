import * as THREE from 'three';

export interface PartThumbnailOptions {
  background?: string;
}

/**
 * Render 3D geometries to a data URL image (one-shot, no animation loop).
 * Creates an offscreen WebGL renderer, renders one frame, captures it,
 * and disposes everything to avoid leaking WebGL contexts.
 */
export function renderPartThumbnail(
  geometries: THREE.BufferGeometry[],
  width: number,
  height: number,
  options?: PartThumbnailOptions,
): string {
  const dpr = window.devicePixelRatio;

  // Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height);

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options?.background ?? '#0f172a');

  // Lights (matching PartViewport)
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight(0xffffff, 0.8);
  directional.position.set(50, 100, 50);
  scene.add(directional);

  // Add meshes
  const material = new THREE.MeshStandardMaterial({
    color: 0x60a5fa,
    metalness: 0.2,
    roughness: 0.7,
    side: THREE.DoubleSide,
  });

  const group = new THREE.Group();
  for (const geometry of geometries) {
    group.add(new THREE.Mesh(geometry, material.clone()));
  }
  scene.add(group);

  // Compute bounding box and fit camera
  const box = new THREE.Box3().setFromObject(group);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  // Camera: isometric-ish angle matching PartViewport (Z-up, front-right elevated)
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
  camera.up.set(0, 0, 1);
  const dist = maxDim / (2 * Math.tan((Math.PI * 45) / 360)) * 1.6;
  // Position: front-right, elevated (same proportions as PartViewport 100,-80,60)
  const dirVec = new THREE.Vector3(100, -80, 60).normalize();
  camera.position.copy(center).addScaledVector(dirVec, dist);
  camera.lookAt(center);
  camera.updateProjectionMatrix();

  // Render one frame
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL();

  // Dispose everything
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      if (obj.material instanceof THREE.Material) {
        obj.material.dispose();
      }
    }
  });
  material.dispose();
  renderer.dispose();
  renderer.forceContextLoss();

  return dataUrl;
}
