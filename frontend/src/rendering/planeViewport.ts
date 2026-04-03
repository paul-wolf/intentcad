/**
 * Viewport implementation for sketching on a 3D plane.
 *
 * Maps between screen pixels (as used by the render pipeline and tools)
 * and plane-local 2D coordinates (millimeters in the sketch's own frame).
 *
 * The mapping goes through the Three.js camera:
 *   screen pixels → NDC → ray → plane intersection → plane-local 2D
 *   plane-local 2D → 3D world → NDC → screen pixels
 */
import * as THREE from 'three';
import type { Point } from '@/types/document';
import type { Viewport } from '@/types/renderer';
import type { Plane } from '@/types/part';

/** Build the plane basis vectors from a Plane definition. */
function planeBasis(plane: Plane) {
  const origin = new THREE.Vector3(...plane.origin);
  const normal = new THREE.Vector3(...plane.normal).normalize();
  const xAxis = new THREE.Vector3(...plane.xAxis).normalize();
  // yAxis = xAxis × normal (matches the 2D editor convention)
  const yAxis = new THREE.Vector3().crossVectors(xAxis, normal);
  return { origin, normal, xAxis, yAxis };
}

export class PlaneViewport implements Viewport {
  private camera: THREE.Camera;
  private plane: Plane;
  private basis: ReturnType<typeof planeBasis>;
  private threePlane: THREE.Plane;
  private raycaster = new THREE.Raycaster();
  private tmpVec2 = new THREE.Vector2();
  private tmpVec3 = new THREE.Vector3();
  readonly width: number;
  readonly height: number;

  constructor(camera: THREE.Camera, plane: Plane, width: number, height: number) {
    this.camera = camera;
    this.plane = plane;
    this.basis = planeBasis(plane);
    this.threePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      this.basis.normal,
      this.basis.origin,
    );
    this.width = width;
    this.height = height;
  }

  /**
   * Effective scale: world-units-per-screen-pixel at the plane origin.
   * This is an approximation — it varies across the screen with perspective,
   * but is accurate enough for snap radii and point sizes.
   */
  get scale(): number {
    const origin3D = this.basis.origin;
    const dist = origin3D.distanceTo(this.camera.position);
    if (this.camera instanceof THREE.PerspectiveCamera) {
      const fovRad = (this.camera.fov * Math.PI) / 180;
      const worldHeight = 2 * dist * Math.tan(fovRad / 2);
      return this.height / worldHeight;
    }
    // Orthographic
    const ortho = this.camera as THREE.OrthographicCamera;
    const worldHeight = ortho.top - ortho.bottom;
    return this.height / worldHeight;
  }

  get offset(): Point {
    // The offset concept from the 2D viewport doesn't map cleanly to 3D.
    // Return the screen position of the plane origin as a reasonable proxy.
    return this.worldToScreen({ x: 0, y: 0 });
  }

  /** Convert a plane-local 2D point to screen pixels. */
  worldToScreen(p: Point): Point {
    const { origin, xAxis, yAxis } = this.basis;
    const world3D = new THREE.Vector3(
      origin.x + p.x * xAxis.x + p.y * yAxis.x,
      origin.y + p.x * xAxis.y + p.y * yAxis.y,
      origin.z + p.x * xAxis.z + p.y * yAxis.z,
    );
    const ndc = world3D.project(this.camera);
    return {
      x: (ndc.x + 1) / 2 * this.width,
      y: (-ndc.y + 1) / 2 * this.height,
    };
  }

  /** Convert screen pixels to plane-local 2D point via raycasting. */
  screenToWorld(p: Point): Point {
    const ndcX = (p.x / this.width) * 2 - 1;
    const ndcY = -(p.y / this.height) * 2 + 1;

    this.tmpVec2.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.tmpVec2, this.camera);

    const hit = this.raycaster.ray.intersectPlane(this.threePlane, this.tmpVec3);
    if (!hit) {
      return { x: 0, y: 0 };
    }

    return this.worldToPlaneLocal(this.tmpVec3);
  }

  /** Project a 3D world point onto the plane and return plane-local 2D coords. */
  worldToPlaneLocal(world: THREE.Vector3): Point {
    const { origin, xAxis, yAxis } = this.basis;
    const relative = new THREE.Vector3().subVectors(world, origin);
    return {
      x: relative.dot(xAxis),
      y: relative.dot(yAxis),
    };
  }

  /** Convert plane-local 2D to 3D world position. */
  planeLocalToWorld(p: Point): THREE.Vector3 {
    const { origin, xAxis, yAxis } = this.basis;
    return new THREE.Vector3(
      origin.x + p.x * xAxis.x + p.y * yAxis.x,
      origin.y + p.x * xAxis.y + p.y * yAxis.y,
      origin.z + p.x * xAxis.z + p.y * yAxis.z,
    );
  }

  /** Get the approximate world-units per screen pixel at the plane origin. */
  getWorldPerPixel(): number {
    return 1 / this.scale;
  }

  /** Get the plane definition. */
  getPlane(): Plane {
    return this.plane;
  }
}
