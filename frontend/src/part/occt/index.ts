export { getOC } from './init';
export type { OC } from './init';
export { OcctCleanup, entityToWire, entitiesToWire, polylineToWire, buildFace } from './shapes';
export { extrudeShape, extrudeShapeSymmetric, revolveShape, booleanFuse, booleanCut, shellShape, filletShape, chamferShape, loftShape } from './operations';
export { tessellate, extractEdges } from './tessellate';
export type { EdgeData } from './tessellate';
export { exportSTEP } from './stepExport';
