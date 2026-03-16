import * as THREE from 'three';
import type { Feature } from '@/types/part';
import type { Document, LineEntity } from '@/types/document';
import { findHoles, findTopLevelProfiles } from './profileDetect';
import {
  getOC,
  OcctCleanup,
  entityToWire,
  buildFace,
  extrudeShape,
  extrudeShapeSymmetric,
  revolveShape,
  shellShape,
  filletShape,
  chamferShape,
  loftShape,
  booleanFuse,
  booleanCut,
  tessellate,
  extractEdges,
  exportSTEP,
} from './occt';
import type { OC } from './occt';
import type { EdgeData } from './occt';

export interface FeatureMesh {
  featureId: string;
  geometry: THREE.BufferGeometry;
  edgeData?: EdgeData;
}

/**
 * Build the accumulated OCCT shape from all features.
 * Returns the final TopoDS_Shape or null if no valid geometry.
 */
function buildAccumulatedShape(
  oc: OC,
  features: Feature[],
  sketchDocs: Map<string, Document>,
  cleanup: OcctCleanup,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let accumulated: any | null = null;

  for (const feature of features) {
    // Construction planes produce no geometry
    if (feature.type === 'constructionPlane') continue;

    // Shell operates on the accumulated shape, not a sketch
    if (feature.type === 'shell') {
      if (!accumulated) continue;
      try {
        accumulated = shellShape(oc, accumulated, feature.faceDirection, feature.thickness, cleanup);
      } catch (e) {
        console.error(`[OCCT] shellShape failed:`, e);
      }
      continue;
    }

    // Fillet operates on the accumulated shape
    if (feature.type === 'fillet') {
      if (!accumulated) continue;
      try {
        accumulated = filletShape(oc, accumulated, feature.edgeIndices, feature.radius, cleanup);
      } catch (e) {
        console.error(`[OCCT] filletShape failed:`, e);
      }
      continue;
    }

    // Chamfer operates on the accumulated shape
    if (feature.type === 'chamfer') {
      if (!accumulated) continue;
      try {
        accumulated = chamferShape(oc, accumulated, feature.edgeIndices, feature.distance, cleanup);
      } catch (e) {
        console.error(`[OCCT] chamferShape failed:`, e);
      }
      continue;
    }

    // Loft: join profiles across planes
    if (feature.type === 'loft') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wires: any[] = [];
      for (const section of feature.sections) {
        const sDoc = sketchDocs.get(section.sketchDocumentId);
        if (!sDoc) continue;
        const sketch = sDoc.sketches.find((s) => s.id === section.sketchId);
        if (!sketch) continue;
        const topLevel = findTopLevelProfiles(sketch);
        if (topLevel.length === 0) continue;
        // Use first (largest) profile
        try {
          const wire = entityToWire(oc, topLevel[0]!, section.plane, cleanup);
          if (wire) wires.push(wire);
        } catch (e) {
          console.error(`[OCCT] loft entityToWire failed:`, e);
        }
      }
      if (wires.length >= 2) {
        try {
          const loftResult = loftShape(oc, wires, true, cleanup);
          if (!accumulated) {
            accumulated = loftResult;
          } else {
            if (feature.operation === 'remove') {
              accumulated = booleanCut(oc, accumulated, loftResult, cleanup);
            } else {
              accumulated = booleanFuse(oc, accumulated, loftResult, cleanup);
            }
          }
        } catch (e) {
          console.error(`[OCCT] loftShape failed:`, e);
        }
      }
      continue;
    }

    const doc = sketchDocs.get(feature.sketchDocumentId);
    if (!doc) continue;

    const sketch = doc.sketches.find((s) => s.id === feature.sketchId);
    if (!sketch) continue;

    const topLevel = findTopLevelProfiles(sketch);
    if (topLevel.length === 0) continue;

    for (const topEntity of topLevel) {
      let outerWire;
      try {
        outerWire = entityToWire(oc, topEntity, feature.plane, cleanup);
      } catch (e) {
        console.error(`[OCCT] entityToWire failed for ${topEntity.type} ${topEntity.id}:`, e);
        continue;
      }
      if (!outerWire) continue;

      const holeEntities = findHoles(topEntity, sketch);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const holeWires: any[] = [];
      for (const he of holeEntities) {
        try {
          const hw = entityToWire(oc, he, feature.plane, cleanup);
          if (hw) holeWires.push(hw);
        } catch (e) {
          console.error(`[OCCT] entityToWire failed for hole ${he.type} ${he.id}:`, e);
        }
      }

      let face;
      try {
        face = buildFace(oc, outerWire, holeWires, cleanup);
      } catch (e) {
        console.error(`[OCCT] buildFace failed:`, e);
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let featureShape: any;

      if (feature.type === 'extrude') {
        const dist = Math.abs(feature.distance);
        if (dist === 0) continue;
        const dir = feature.direction ?? 'forward';
        try {
          if (dir === 'both') {
            featureShape = extrudeShapeSymmetric(oc, face, feature.plane.normal, dist, cleanup);
          } else {
            const signedDist = dir === 'reverse' ? -dist : dist;
            featureShape = extrudeShape(oc, face, feature.plane.normal, signedDist, cleanup);
          }
        } catch (e) {
          console.error(`[OCCT] extrudeShape failed:`, e);
          continue;
        }
      } else if (feature.type === 'revolve') {
        const axisEntity = sketch.entities.find((e) => e.id === feature.axisEntityId);
        if (!axisEntity || axisEntity.type !== 'line') continue;
        const axisLine = axisEntity as LineEntity;
        if (axisLine.points.length < 2) continue;

        // Transform axis endpoints to 3D
        const p0 = axisLine.points[0]!;
        const p1 = axisLine.points[1]!;
        const plane = feature.plane;

        const [ox, oy, oz] = plane.origin;
        const [nx, ny, nz] = plane.normal;
        const [xx, xy, xz] = plane.xAxis;
        // yAxis = xAxis × normal (matches screen-Y-down convention in 2D sketch editor)
        const yx = xy * nz - xz * ny;
        const yy = xz * nx - xx * nz;
        const yz = xx * ny - xy * nx;

        const ax0: [number, number, number] = [
          ox + p0.x * xx + p0.y * yx,
          oy + p0.x * xy + p0.y * yy,
          oz + p0.x * xz + p0.y * yz,
        ];
        const ax1: [number, number, number] = [
          ox + p1.x * xx + p1.y * yx,
          oy + p1.x * xy + p1.y * yy,
          oz + p1.x * xz + p1.y * yz,
        ];

        const dx = ax1[0] - ax0[0];
        const dy = ax1[1] - ax0[1];
        const dz = ax1[2] - ax0[2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-10) continue;

        const axisDir: [number, number, number] = [dx / len, dy / len, dz / len];
        const angleRad = (feature.angle * Math.PI) / 180;

        featureShape = revolveShape(oc, face, ax0, axisDir, angleRad, cleanup);
      } else {
        continue;
      }

      if (!accumulated) {
        accumulated = featureShape;
      } else {
        if (feature.operation === 'remove') {
          accumulated = booleanCut(oc, accumulated, featureShape, cleanup);
        } else {
          accumulated = booleanFuse(oc, accumulated, featureShape, cleanup);
        }
      }
    }
  }

  return accumulated;
}

/**
 * Evaluate all features and produce meshes.
 * Now async because OCCT WASM must be initialized first.
 */
export async function evaluateFeatures(
  features: Feature[],
  sketchDocs: Map<string, Document>,
): Promise<FeatureMesh[]> {
  if (features.length === 0) return [];

  const oc = await getOC();
  const cleanup = new OcctCleanup();

  try {
    const shape = buildAccumulatedShape(oc, features, sketchDocs, cleanup);
    if (!shape) return [];

    const lastFeatureId = features[features.length - 1]!.id;
    const geometry = tessellate(oc, shape, 0.1, cleanup);
    const edgeData = extractEdges(oc, shape, cleanup);

    return [{ featureId: lastFeatureId, geometry, edgeData }];
  } finally {
    cleanup.dispose();
  }
}

/**
 * Evaluate features and return the raw OCCT shape (for STEP export).
 * Caller must dispose the returned cleanup object after use.
 */
export async function evaluateToShape(
  features: Feature[],
  sketchDocs: Map<string, Document>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ shape: any; cleanup: OcctCleanup } | null> {
  if (features.length === 0) return null;

  const oc = await getOC();
  const cleanup = new OcctCleanup();

  const shape = buildAccumulatedShape(oc, features, sketchDocs, cleanup);
  if (!shape) {
    cleanup.dispose();
    return null;
  }

  return { shape, cleanup };
}

/** Export the accumulated shape as STEP. */
export async function exportFeaturesToSTEP(
  features: Feature[],
  sketchDocs: Map<string, Document>,
): Promise<Blob> {
  const result = await evaluateToShape(features, sketchDocs);
  if (!result) throw new Error('No geometry to export');

  const oc = await getOC();
  try {
    return exportSTEP(oc, result.shape, result.cleanup);
  } finally {
    result.cleanup.dispose();
  }
}
