/**
 * A 3D reference plane. Retained as lightweight metadata on a Sketch so a sketch
 * can record the plane it was authored on. (The in-app 3D modeler was removed;
 * plane-driven modeling now happens server-side.)
 */
export interface Plane {
  origin: [number, number, number];
  normal: [number, number, number];
  xAxis: [number, number, number];
}
