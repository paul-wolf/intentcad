import * as THREE from 'three';
import { Evaluator, Brush, ADDITION, SUBTRACTION } from 'three-bvh-csg';
import type { Feature } from '@/types/part';
import type { Document } from '@/types/document';
import { buildProfileMesh, entityToShapeDef } from './meshBuilder';
import type { ShapeDef } from './meshBuilder';
import { findHoles, findTopLevelProfiles } from './profileDetect';

export interface FeatureMesh {
  featureId: string;
  geometry: THREE.BufferGeometry;
}

/**
 * Evaluate all features in order and produce meshes.
 * `sketchDocs` is a map from document UUID to the document data.
 *
 * Features are processed sequentially with CSG boolean operations:
 * - 'add' operations union geometry with the accumulated solid
 * - 'remove' operations subtract geometry from the accumulated solid
 */
export function evaluateFeatures(
  features: Feature[],
  sketchDocs: Map<string, Document>,
): FeatureMesh[] {
  const evaluator = new Evaluator();
  let accumulated: Brush | null = null;
  let lastFeatureId = '';

  for (const feature of features) {
    if (feature.type === 'extrude') {
      const doc = sketchDocs.get(feature.sketchDocumentId);
      if (!doc) continue;

      const sketch = doc.sketches.find((s) => s.id === feature.sketchId);
      if (!sketch) continue;

      const topLevel = findTopLevelProfiles(sketch);
      if (topLevel.length === 0) continue;

      const dist = Math.abs(feature.distance);
      if (dist === 0) continue;

      for (const topEntity of topLevel) {
        const outerShape = entityToShapeDef(topEntity);
        if (!outerShape) continue;

        const holeEntities = findHoles(topEntity, sketch);
        const holes: ShapeDef[] = [];
        for (const he of holeEntities) {
          const shapeDef = entityToShapeDef(he);
          if (shapeDef) holes.push(shapeDef);
        }

        const geometry = buildProfileMesh(outerShape, holes, feature.plane, dist);
        const brush = new Brush(geometry);
        brush.updateMatrixWorld();

        if (!accumulated) {
          accumulated = brush;
        } else {
          const op = feature.operation === 'remove' ? SUBTRACTION : ADDITION;
          accumulated = evaluator.evaluate(accumulated, brush, op);
        }
      }
      lastFeatureId = feature.id;
    }
  }

  if (!accumulated) return [];
  return [{ featureId: lastFeatureId, geometry: accumulated.geometry }];
}
