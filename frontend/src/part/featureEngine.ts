import * as THREE from 'three';
import type { Feature } from '@/types/part';
import type { Document } from '@/types/document';
import type { WorkerRequest, WorkerResult, WorkerEvalResult } from './featureWorker';

export interface EdgeData {
  positions: Float32Array;
  edgeRanges: { edgeIndex: number; start: number; count: number }[];
}

export interface FeatureMesh {
  featureId: string;
  geometry: THREE.BufferGeometry;
  edgeData?: EdgeData;
}

// --- Worker singleton ---

let worker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, { resolve: (r: WorkerResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./featureWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerResult>) => {
      const result = e.data;
      const pending = pendingRequests.get(result.id);
      if (pending) {
        pendingRequests.delete(result.id);
        pending.resolve(result);
      }
    };
    worker.onerror = (e) => {
      console.error('[FeatureWorker] error:', e);
      // Reject all pending
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error(e.message));
        pendingRequests.delete(id);
      }
    };
  }
  return worker;
}

function postToWorker(req: Omit<WorkerRequest, 'id'>): Promise<WorkerResult> {
  const id = nextRequestId++;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    w.postMessage({ ...req, id } as WorkerRequest);
  });
}

/** Reconstruct THREE.BufferGeometry from raw arrays. */
function rawToGeometry(result: WorkerEvalResult): { geometry: THREE.BufferGeometry; edgeData: EdgeData } {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(result.mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(result.mesh.normals, 3));
  geometry.setAttribute('faceId', new THREE.Int32BufferAttribute(result.mesh.faceIds, 1));
  geometry.setIndex(new THREE.Uint32BufferAttribute(result.mesh.indices, 1));
  geometry.userData.faceRanges = result.mesh.faceRanges;

  const edgeData: EdgeData = {
    positions: result.edges.positions,
    edgeRanges: result.edges.edgeRanges,
  };

  return { geometry, edgeData };
}

/**
 * Evaluate all features and produce meshes.
 * Runs OCCT in a web worker to avoid blocking the UI.
 */
export async function evaluateFeatures(
  features: Feature[],
  sketchDocs: Map<string, Document>,
): Promise<FeatureMesh[]> {
  if (features.length === 0) return [];

  const result = await postToWorker({
    type: 'evaluate',
    features,
    sketchDocsEntries: Array.from(sketchDocs.entries()),
  });

  if (result.type === 'empty') return [];
  if (result.type === 'error') {
    console.error('[FeatureWorker] evaluation failed:', result.message);
    return [];
  }
  if (result.type !== 'evaluate') return [];

  const { geometry, edgeData } = rawToGeometry(result);
  return [{ featureId: result.featureId, geometry, edgeData }];
}

/** Export the accumulated shape as STEP (runs in worker). */
export async function exportFeaturesToSTEP(
  features: Feature[],
  sketchDocs: Map<string, Document>,
): Promise<Blob> {
  if (features.length === 0) throw new Error('No geometry to export');

  const result = await postToWorker({
    type: 'exportSTEP',
    features,
    sketchDocsEntries: Array.from(sketchDocs.entries()),
  });

  if (result.type === 'error') throw new Error(result.message);
  if (result.type !== 'exportSTEP') throw new Error('Unexpected worker result');

  return new Blob([result.data], { type: 'application/step' });
}
