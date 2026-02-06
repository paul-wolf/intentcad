export interface Plane {
  origin: [number, number, number];
  normal: [number, number, number];
  xAxis: [number, number, number];
}

export interface ExtrudeFeature {
  id: string;
  type: 'extrude';
  sketchDocumentId: string;
  sketchId: string;
  plane: Plane;
  distance: number;
  operation: 'add' | 'remove';
}

export type Feature = ExtrudeFeature;

export interface Part {
  id: string;
  name: string;
  documentId: string;
  features: Feature[];
}

export const PLANE_PRESETS: Record<string, Plane> = {
  'Top (XY)': {
    origin: [0, 0, 0],
    normal: [0, 0, 1],
    xAxis: [1, 0, 0],
  },
  'Front (XZ)': {
    origin: [0, 0, 0],
    normal: [0, -1, 0],
    xAxis: [1, 0, 0],
  },
  'Right (YZ)': {
    origin: [0, 0, 0],
    normal: [1, 0, 0],
    xAxis: [0, 1, 0],
  },
};

export const DEFAULT_XY_PLANE: Plane = PLANE_PRESETS['Top (XY)']!;

export function planeWithOffset(plane: Plane, offset: number): Plane {
  return {
    origin: [
      plane.origin[0] + plane.normal[0] * offset,
      plane.origin[1] + plane.normal[1] * offset,
      plane.origin[2] + plane.normal[2] * offset,
    ],
    normal: plane.normal,
    xAxis: plane.xAxis,
  };
}
