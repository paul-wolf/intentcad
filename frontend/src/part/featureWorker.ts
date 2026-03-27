/**
 * Web Worker for OCCT feature evaluation.
 * Runs shape building + tessellation off the main thread.
 */
import type { Feature } from '@/types/part';
import type { Document, Entity, LineEntity } from '@/types/document';
import { findHoles, findTopLevelProfiles, findClosedChains } from './profileDetect';
import {
  getOC,
  OcctCleanup,
  entityToWire,
  polylineToWire,
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
  exportSTEP,
} from './occt';
import type { OC } from './occt';
import { tessellateRaw, extractEdgesRaw } from './occt/tessellateRaw';
import type { RawMeshData, RawEdgeData } from './occt/tessellateRaw';

export interface WorkerRequest {
  id: number;
  type: 'evaluate' | 'exportSTEP';
  features: Feature[];
  sketchDocsEntries: [string, Document][];
}

export interface WorkerEvalResult {
  id: number;
  type: 'evaluate';
  featureId: string;
  mesh: RawMeshData;
  edges: RawEdgeData;
}

export interface WorkerSTEPResult {
  id: number;
  type: 'exportSTEP';
  data: ArrayBuffer;
}

export interface WorkerEmptyResult {
  id: number;
  type: 'empty';
}

export interface WorkerErrorResult {
  id: number;
  type: 'error';
  message: string;
}

export type WorkerResult = WorkerEvalResult | WorkerSTEPResult | WorkerEmptyResult | WorkerErrorResult;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    if (feature.type === 'constructionPlane') continue;

    if (feature.type === 'shell') {
      if (!accumulated) continue;
      try {
        accumulated = shellShape(oc, accumulated, feature.faceDirection, feature.thickness, cleanup);
      } catch (e) { console.error(`[OCCT] shellShape failed:`, e); }
      continue;
    }

    if (feature.type === 'fillet') {
      if (!accumulated) continue;
      try {
        accumulated = filletShape(oc, accumulated, feature.edgeIndices, feature.radius, cleanup);
      } catch (e) { console.error(`[OCCT] filletShape failed:`, e); }
      continue;
    }

    if (feature.type === 'chamfer') {
      if (!accumulated) continue;
      try {
        accumulated = chamferShape(oc, accumulated, feature.edgeIndices, feature.distance, cleanup);
      } catch (e) { console.error(`[OCCT] chamferShape failed:`, e); }
      continue;
    }

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
        try {
          const wire = entityToWire(oc, topLevel[0]!, section.plane, cleanup);
          if (wire) wires.push(wire);
        } catch (e) { console.error(`[OCCT] loft entityToWire failed:`, e); }
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
        } catch (e) { console.error(`[OCCT] loftShape failed:`, e); }
      }
      continue;
    }

    const doc = sketchDocs.get(feature.sketchDocumentId);
    if (!doc) continue;

    const sketch = doc.sketches.find((s) => s.id === feature.sketchId);
    if (!sketch) continue;

    const topLevel = findTopLevelProfiles(sketch);
    const chains = findClosedChains(sketch);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outerWires: { wire: any; entity?: Entity }[] = [];

    for (const topEntity of topLevel) {
      try {
        const wire = entityToWire(oc, topEntity, feature.plane, cleanup);
        if (wire) outerWires.push({ wire, entity: topEntity });
      } catch (e) { console.error(`[OCCT] entityToWire failed:`, e); }
    }

    for (const chain of chains) {
      try {
        const wire = polylineToWire(oc, chain.polyline, feature.plane, cleanup);
        if (wire) outerWires.push({ wire });
      } catch (e) { console.error(`[OCCT] polylineToWire failed for chain:`, e); }
    }

    if (outerWires.length === 0) continue;

    for (const { wire: outerWire, entity: topEntity } of outerWires) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const holeWires: any[] = [];
      if (topEntity) {
        const holeEntities = findHoles(topEntity, sketch);
        for (const he of holeEntities) {
          try {
            const hw = entityToWire(oc, he, feature.plane, cleanup);
            if (hw) holeWires.push(hw);
          } catch (e) { console.error(`[OCCT] entityToWire failed for hole:`, e); }
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

        const p0 = axisLine.points[0]!;
        const p1 = axisLine.points[1]!;
        const plane = feature.plane;

        const [ox, oy, oz] = plane.origin;
        const [nx, ny, nz] = plane.normal;
        const [xx, xy, xz] = plane.xAxis;
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

async function handleEvaluate(req: WorkerRequest): Promise<WorkerResult> {
  const oc = await getOC();
  const cleanup = new OcctCleanup();
  const sketchDocs = new Map<string, Document>(req.sketchDocsEntries);

  try {
    const shape = buildAccumulatedShape(oc, req.features, sketchDocs, cleanup);
    if (!shape) return { id: req.id, type: 'empty' };

    const lastFeatureId = req.features[req.features.length - 1]!.id;
    const mesh = tessellateRaw(oc, shape, 0.1, cleanup);
    const edges = extractEdgesRaw(oc, shape, cleanup, mesh);

    return { id: req.id, type: 'evaluate', featureId: lastFeatureId, mesh, edges };
  } catch (e) {
    return { id: req.id, type: 'error', message: String(e) };
  } finally {
    cleanup.dispose();
  }
}

async function handleExportSTEP(req: WorkerRequest): Promise<WorkerResult> {
  const oc = await getOC();
  const cleanup = new OcctCleanup();
  const sketchDocs = new Map<string, Document>(req.sketchDocsEntries);

  try {
    const shape = buildAccumulatedShape(oc, req.features, sketchDocs, cleanup);
    if (!shape) return { id: req.id, type: 'error', message: 'No geometry to export' };

    const blob = exportSTEP(oc, shape, cleanup);
    const buffer = await blob.arrayBuffer();
    return { id: req.id, type: 'exportSTEP', data: buffer };
  } catch (e) {
    return { id: req.id, type: 'error', message: String(e) };
  } finally {
    cleanup.dispose();
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  let result: WorkerResult;

  if (req.type === 'evaluate') {
    result = await handleEvaluate(req);
  } else if (req.type === 'exportSTEP') {
    result = await handleExportSTEP(req);
  } else {
    result = { id: req.id, type: 'error', message: `Unknown request type` };
  }

  // Transfer typed arrays for performance
  const transfers: ArrayBuffer[] = [];
  if (result.type === 'evaluate') {
    transfers.push(
      result.mesh.positions.buffer,
      result.mesh.normals.buffer,
      result.mesh.indices.buffer,
      result.mesh.faceIds.buffer,
      result.edges.positions.buffer,
    );
  } else if (result.type === 'exportSTEP') {
    transfers.push(result.data);
  }

  // @ts-expect-error postMessage transfer
  self.postMessage(result, transfers);
};
