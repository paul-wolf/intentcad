import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usePartStore } from '@/stores/partStore';
import { usePartEditorStore } from '@/stores/partEditorStore';
import { useThemeStore } from '@/theme';
import { partApi } from '@/api/client';
import { api } from '@/api/client';
import { setPartBackendId, startPartAutoSave } from '@/api/partAutoSave';
import { PartViewport, type DragInteractionCallbacks } from '@/part/PartViewport';
import { evaluateFeatures, exportFeaturesToSTEP } from '@/part/featureEngine';
import type { EdgeData } from '@/part/occt/tessellate';
import { exportSTL } from '@/part/stlExport';
import { buildSketchOverlay } from '@/part/sketchOverlay';
import { PartToolbar } from './PartToolbar';
import { FeaturePanel } from './FeaturePanel';
import { SketchRolodex } from './SketchRolodex';
import { ExtrudeForm, type ExtrudeFormHandle } from './ExtrudeForm';
import { RevolveForm, type RevolveFormHandle } from './RevolveForm';
import { ShellForm } from './ShellForm';
import { FilletForm } from './FilletForm';
import { ChamferForm } from './ChamferForm';
import { LoftForm, type LoftFormHandle } from './LoftForm';
import type { Part, Feature, ExtrudeFeature, RevolveFeature, FilletFeature, ChamferFeature, LoftFeature, Plane } from '@/types/part';
import { DEFAULT_XY_PLANE, planeWithOffset } from '@/types/part';
import type { Document } from '@/types/document';
import { useDocumentStore } from '@/stores/documentStore';
import { migrateDocument } from '@/utils/document';
import { generateId } from '@/utils/id';
import type { LineEntity } from '@/types/document';

function computeXAxis(normal: [number, number, number]): [number, number, number] {
  const ref: [number, number, number] = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  // cross(ref, normal)
  const x: [number, number, number] = [
    ref[1] * normal[2] - ref[2] * normal[1],
    ref[2] * normal[0] - ref[0] * normal[2],
    ref[0] * normal[1] - ref[1] * normal[0],
  ];
  const len = Math.sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
  if (len < 1e-12) return [1, 0, 0];
  return [x[0] / len, x[1] / len, x[2] / len];
}

/** Extract all sketch document IDs from features, including loft sections. */
function collectDocIds(features: Feature[]): string[] {
  const ids = new Set<string>();
  for (const f of features) {
    if ('sketchDocumentId' in f) {
      ids.add((f as ExtrudeFeature | RevolveFeature).sketchDocumentId);
    }
    if (f.type === 'loft') {
      for (const sec of (f as LoftFeature).sections) {
        ids.add(sec.sketchDocumentId);
      }
    }
  }
  return [...ids];
}

export function PartEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const part = usePartStore((s) => s.part);
  const setPart = usePartStore((s) => s.setPart);
  const beginTransaction = usePartStore((s) => s.beginTransaction);
  const addFeature = usePartStore((s) => s.addFeature);
  const updateFeature = usePartStore((s) => s.updateFeature);
  const restoreHistory = usePartStore((s) => s.restoreHistory);
  const palette = useThemeStore((s) => s.palette);

  const selectedFeatureId = usePartEditorStore((s) => s.selectedFeatureId);
  const draftFeature = usePartEditorStore((s) => s.draftFeature);
  const editingExistingId = usePartEditorStore((s) => s.editingExistingId);
  const draftSketchDoc = usePartEditorStore((s) => s.draftSketchDoc);
  const setDraftFeature = usePartEditorStore((s) => s.setDraftFeature);
  const setDraftSketchDoc = usePartEditorStore((s) => s.setDraftSketchDoc);
  const startCreating = usePartEditorStore((s) => s.startCreating);
  const startEditing = usePartEditorStore((s) => s.startEditing);
  const clearDraft = usePartEditorStore((s) => s.clearDraft);

  const [selectedEdges, setSelectedEdges] = useState<number[]>([]);
  const [activeLoftSection, setActiveLoftSection] = useState(1);
  const [sketchOnFacePending, setSketchOnFacePending] = useState(false);
  const edgeDataRef = useRef<EdgeData | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<PartViewport | null>(null);
  const rolodexSketchIdRef = useRef<string>('');
  const previewCounterRef = useRef(0);
  const lastPreviewTimeRef = useRef(0);
  const extrudeFormRef = useRef<ExtrudeFormHandle>(null);
  const revolveFormRef = useRef<RevolveFormHandle>(null);
  const loftFormRef = useRef<LoftFormHandle>(null);

  // Load part from backend
  useEffect(() => {
    if (!id) return;
    setPart({ id, name: '', documentId: '', features: [] });
    partApi.getPart(id).then((full) => {
      const data = full.data as unknown as Part;
      if (data && data.features) {
        setPart(data);
      } else {
        setPart({ id: full.id, name: full.name, documentId: (full.data as { documentId?: string })?.documentId ?? '', features: [] });
      }
      setPartBackendId(full.id);
      if (full.history && typeof full.history === 'object' && 'undo' in (full.history as Record<string, unknown>)) {
        const h = full.history as { undo: unknown[]; redo: unknown[] };
        restoreHistory(h as Parameters<typeof restoreHistory>[0]);
      }
    }).catch((err) => {
      console.error('Failed to load part:', err);
    });

    return () => setPartBackendId(null);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start auto-save
  useEffect(() => {
    const cleanup = startPartAutoSave();
    return cleanup;
  }, []);

  // On mount: check sessionStorage for sketchOnFace intent → auto-start extrude
  useEffect(() => {
    const raw = sessionStorage.getItem('sketchOnFace_intent');
    if (!raw) return;
    try {
      const intent = JSON.parse(raw) as { returnToPartId: string; sketchId: string; plane: Plane; sketchDocumentId: string };
      sessionStorage.removeItem('sketchOnFace_intent');
      // Wait for part to be loaded before starting the extrude draft
      const unsub = usePartStore.subscribe((state) => {
        if (!state.part.documentId) return;
        unsub();
        startCreating({
          id: crypto.randomUUID(),
          type: 'extrude',
          sketchDocumentId: intent.sketchDocumentId,
          sketchId: intent.sketchId,
          plane: intent.plane,
          distance: 20,
          direction: 'forward',
          operation: 'add',
        });
      });
      // Check if already loaded
      if (usePartStore.getState().part.documentId) {
        unsub();
        startCreating({
          id: crypto.randomUUID(),
          type: 'extrude',
          sketchDocumentId: intent.sketchDocumentId,
          sketchId: intent.sketchId,
          plane: intent.plane,
          distance: 20,
          direction: 'forward',
          operation: 'add',
        });
      }
    } catch {
      sessionStorage.removeItem('sketchOnFace_intent');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Enable face picking for "Sketch on Face" mode
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || !sketchOnFacePending) return;

    vp.enableFacePicking(async (info) => {
      setSketchOnFacePending(false);
      vp.disableFacePicking();

      const normal: [number, number, number] = [info.normal.x, info.normal.y, info.normal.z];
      const hitPoint = info.point;
      const xAxis = computeXAxis(normal);
      const depth = hitPoint.x * normal[0] + hitPoint.y * normal[1] + hitPoint.z * normal[2];
      const origin: [number, number, number] = [normal[0] * depth, normal[1] * depth, normal[2] * depth];
      const plane: Plane = { origin, normal, xAxis };

      // Compute yAxis = xAxis × normal (matches screen-Y-down convention in 2D sketch editor)
      const yAxis: [number, number, number] = [
        xAxis[1] * normal[2] - xAxis[2] * normal[1],
        xAxis[2] * normal[0] - xAxis[0] * normal[2],
        xAxis[0] * normal[1] - xAxis[1] * normal[0],
      ];

      // Project 3D boundary loops onto the 2D sketch plane as construction lines
      const constructionEntities: LineEntity[] = [];
      for (const loop of info.boundaryLoops) {
        if (loop.length < 2) continue;
        const points = loop.map((pt) => {
          const dx = pt[0] - origin[0];
          const dy = pt[1] - origin[1];
          const dz = pt[2] - origin[2];
          return {
            x: dx * xAxis[0] + dy * xAxis[1] + dz * xAxis[2],
            y: dx * yAxis[0] + dy * yAxis[1] + dz * yAxis[2],
          };
        });
        constructionEntities.push({
          id: generateId('ln'),
          type: 'line',
          points,
          construction: true,
        });
      }

      const currentPart = usePartStore.getState().part;
      const docId = currentPart.documentId;
      if (!docId) return;

      try {
        // Load the document into documentStore
        const full = await api.getDocument(docId);
        const doc = migrateDocument(full.data as unknown as Document);
        useDocumentStore.getState().setDocument(doc);

        // Create a new sketch with the face plane
        const sketchName = `Face Sketch ${doc.sketches.length + 1}`;
        const sketchId = useDocumentStore.getState().addSketch(sketchName, plane);

        // Add face boundary as construction geometry
        const docStore = useDocumentStore.getState();
        for (const entity of constructionEntities) {
          docStore.addEntity(entity);
        }

        // Save back to backend
        const updatedDoc = useDocumentStore.getState().document;
        await api.updateDocument(docId, { name: updatedDoc.name, data: updatedDoc as unknown as Record<string, unknown> });

        // Write intent to sessionStorage
        sessionStorage.setItem('sketchOnFace_intent', JSON.stringify({
          returnToPartId: currentPart.id,
          sketchId,
          plane,
          sketchDocumentId: docId,
        }));

        // Navigate to the 2D sketch editor
        navigate(`/edit/${docId}`);
      } catch (err) {
        console.error('Sketch on face failed:', err);
      }
    });

    return () => vp.disableFacePicking();
  }, [sketchOnFacePending, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialize Three.js viewport
  useEffect(() => {
    if (!containerRef.current) return;
    const vp = new PartViewport({
      container: containerRef.current,
      background: palette.background,
    });
    viewportRef.current = vp;
    return () => {
      vp.dispose();
      viewportRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update background when theme changes
  useEffect(() => {
    viewportRef.current?.setBackground(palette.background);
  }, [palette.background]);

  // Enable/disable drag interaction when draft is an extrude
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    if (!draftFeature || draftFeature.type !== 'extrude') {
      return;
    }

    const callbacks: DragInteractionCallbacks = {
      onDragStart(_hitPoint) {
        const draft = usePartEditorStore.getState().draftFeature;
        if (!draft || draft.type !== 'extrude') return null;
        const ext = draft as ExtrudeFeature;
        const sign = ext.direction === 'reverse' ? -1 : 1;
        return {
          axis: ext.plane.normal,
          initialValue: ext.distance * sign,
        };
      },
      onDrag(newValue, isNegative) {
        const handle = extrudeFormRef.current;
        if (!handle) return;
        handle.setDistance(Math.max(0.1, newValue));
        handle.setDirection(isNegative ? 'reverse' : 'forward');
        handle.setOperation(isNegative ? 'remove' : 'add');
      },
    };

    vp.enableDragInteraction(callbacks);
    return () => vp.disableDragInteraction();
  }, [draftFeature?.type]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enable drag interaction for loft plane manipulation
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    if (!draftFeature || draftFeature.type !== 'loft') {
      return;
    }

    const RING_RADIUS = 12; // Must match PartViewport's RING_RADIUS
    const DEG_PER_UNIT = 180 / (Math.PI * RING_RADIUS);

    const callbacks: DragInteractionCallbacks = {
      onDragStart(hitPoint, handleId) {
        const active = loftFormRef.current?.getActiveSection();
        if (!active || !handleId) return null;

        const bn = active.basePlane.normal;
        const bx = active.basePlane.xAxis;
        const by: [number, number, number] = [
          bx[1] * bn[2] - bx[2] * bn[1],
          bx[2] * bn[0] - bx[0] * bn[2],
          bx[0] * bn[1] - bx[1] * bn[0],
        ];

        if (handleId === 'normal') {
          return { axis: bn, initialValue: active.offset };
        } else if (handleId === 'x') {
          return { axis: bx, initialValue: active.originX };
        } else if (handleId === 'y') {
          return { axis: by, initialValue: active.originY };
        } else if (handleId === 'spin' || handleId === 'tilt') {
          // Compute tangent at the hit point for rotation drag
          const draft = usePartEditorStore.getState().draftFeature as LoftFeature | null;
          if (!draft) return null;
          const section = draft.sections[activeLoftSection];
          if (!section) return null;
          const o = section.plane.origin;

          // Rotation axis: normal for spin, xAxis for tilt
          const rotAxis = handleId === 'spin' ? bn : bx;

          // Radius vector: hit point minus origin, projected perpendicular to rotation axis
          const toHit: [number, number, number] = [hitPoint[0] - o[0], hitPoint[1] - o[1], hitPoint[2] - o[2]];
          const dot = toHit[0] * rotAxis[0] + toHit[1] * rotAxis[1] + toHit[2] * rotAxis[2];
          const proj: [number, number, number] = [
            toHit[0] - rotAxis[0] * dot,
            toHit[1] - rotAxis[1] * dot,
            toHit[2] - rotAxis[2] * dot,
          ];

          // Tangent = rotationAxis × radiusVector
          const tangent: [number, number, number] = [
            rotAxis[1] * proj[2] - rotAxis[2] * proj[1],
            rotAxis[2] * proj[0] - rotAxis[0] * proj[2],
            rotAxis[0] * proj[1] - rotAxis[1] * proj[0],
          ];
          const len = Math.sqrt(tangent[0] ** 2 + tangent[1] ** 2 + tangent[2] ** 2);
          if (len < 1e-6) return null;
          const axis: [number, number, number] = [tangent[0] / len, tangent[1] / len, tangent[2] / len];

          const currentAngle = handleId === 'spin' ? active.spin : active.tilt;
          // Convert angle to arc-length so the drag system works in linear units
          return { axis, initialValue: currentAngle / DEG_PER_UNIT };
        }
        return null;
      },
      onDrag(newValue, isNegative, handleId) {
        const signedValue = isNegative ? -newValue : newValue;
        if (handleId === 'normal') {
          loftFormRef.current?.setOffset(signedValue);
        } else if (handleId === 'x') {
          loftFormRef.current?.setOriginX(signedValue);
        } else if (handleId === 'y') {
          loftFormRef.current?.setOriginY(signedValue);
        } else if (handleId === 'spin') {
          loftFormRef.current?.setSpin(signedValue * DEG_PER_UNIT);
        } else if (handleId === 'tilt') {
          loftFormRef.current?.setTilt(signedValue * DEG_PER_UNIT);
        }
      },
    };

    vp.enableDragInteraction(callbacks);
    return () => vp.disableDragInteraction();
  }, [draftFeature?.type]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show plane gizmo for active loft section
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    if (!draftFeature || draftFeature.type !== 'loft') {
      vp.clearPlaneGizmo();
      return;
    }

    const loft = draftFeature as LoftFeature;
    const section = loft.sections[activeLoftSection];
    if (section) {
      vp.setPlaneGizmo(section.plane.origin, section.plane.normal, section.plane.xAxis);
    }
  }, [draftFeature, activeLoftSection]);

  // Enable face picking when draft is extrude, revolve, or loft
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    if (!draftFeature || (draftFeature.type !== 'extrude' && draftFeature.type !== 'revolve' && draftFeature.type !== 'loft')) {
      vp.disableFacePicking();
      return;
    }

    vp.enableFacePicking((info) => {
      const normal: [number, number, number] = [info.normal.x, info.normal.y, info.normal.z];
      const hitPoint = info.point;
      const xAxis = computeXAxis(normal);
      // Project world origin onto the face plane — keeps depth along normal,
      // discards in-plane click position so the sketch stays centered
      const depth = hitPoint.x * normal[0] + hitPoint.y * normal[1] + hitPoint.z * normal[2];
      const origin: [number, number, number] = [normal[0] * depth, normal[1] * depth, normal[2] * depth];
      const plane: Plane = { origin, normal, xAxis };

      const draft = usePartEditorStore.getState().draftFeature;
      if (draft?.type === 'extrude') {
        extrudeFormRef.current?.setPlane(plane);
      } else if (draft?.type === 'revolve') {
        revolveFormRef.current?.setPlane(plane);
      } else if (draft?.type === 'loft') {
        loftFormRef.current?.setPlane(plane);
      }
    });

    return () => vp.disableFacePicking();
  }, [draftFeature?.type]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enable edge picking when draft is fillet or chamfer
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    if (!draftFeature || (draftFeature.type !== 'fillet' && draftFeature.type !== 'chamfer')) {
      vp.disableEdgePicking();
      vp.setEdgeWireframe(null);
      return;
    }

    // Show edge wireframe from the latest edge data
    vp.setEdgeWireframe(edgeDataRef.current);

    // Set up toggle callback
    vp.enableEdgePicking((edgeIndex: number) => {
      setSelectedEdges((prev) => {
        const next = prev.includes(edgeIndex)
          ? prev.filter((i) => i !== edgeIndex)
          : [...prev, edgeIndex];
        // Update selection visualization
        viewportRef.current?.setSelectedEdges(next);
        return next;
      });
    });

    // Restore selection visualization if editing existing
    const currentEdges = usePartEditorStore.getState().draftFeature;
    if (currentEdges && 'edgeIndices' in currentEdges) {
      const indices = (currentEdges as FilletFeature | ChamferFeature).edgeIndices;
      if (indices.length > 0) {
        vp.setSelectedEdges(indices);
      }
    }

    return () => {
      vp.disableEdgePicking();
      vp.setEdgeWireframe(null);
    };
  }, [draftFeature?.type]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-evaluate committed meshes when features change (only when not previewing)
  useEffect(() => {
    if (draftFeature) return; // Skip — preview effect handles display while drafting
    const features = part.features;
    if (features.length === 0) {
      viewportRef.current?.setMeshes([]);
      viewportRef.current?.setSketchPlaneOverlays([]);
      return;
    }

    const docIds = collectDocIds(features);
    Promise.all(docIds.map((docId) => api.getDocument(docId).then((full) => [docId, full.data as unknown as Document] as const)))
      .then(async (entries) => {
        const docMap = new Map<string, Document>(entries);
        const meshes = await evaluateFeatures(features, docMap);
        // Only apply if we're still not drafting
        if (!usePartEditorStore.getState().draftFeature) {
          const vp = viewportRef.current;
          const latestEdgeData = meshes.length > 0 ? meshes[0]!.edgeData : null;
          vp?.setMeshes(meshes.map((m) => m.geometry), latestEdgeData);
          // Capture edge data for edge picking
          if (latestEdgeData) {
            edgeDataRef.current = latestEdgeData;
          }
          // Build persistent sketch plane overlays for all sketch-based features
          // Build persistent sketch plane overlays for all sketch-based features
          const overlays: Parameters<PartViewport['setSketchPlaneOverlays']>[0] = [];
          const addOverlay = (sketchDocId: string, sketchId: string, plane: Plane) => {
            const doc = docMap.get(sketchDocId);
            if (!doc) return;
            const sketch = doc.sketches.find((s) => s.id === sketchId);
            if (!sketch) return;
            const ov = buildSketchOverlay(sketch, plane);
            overlays.push({
              linePositions: ov.linePositions,
              center: ov.planeCenter,
              normal: ov.planeNormal,
              xAxis: ov.planeXAxis,
              size: ov.planeSize,
            });
          };
          for (const f of features) {
            if (f.type === 'loft') {
              for (const sec of (f as LoftFeature).sections) {
                addOverlay(sec.sketchDocumentId, sec.sketchId, sec.plane);
              }
            } else if ('plane' in f && 'sketchDocumentId' in f) {
              const sf = f as ExtrudeFeature | RevolveFeature;
              addOverlay(sf.sketchDocumentId, sf.sketchId, sf.plane);
            }
          }
          vp?.setSketchPlaneOverlays(overlays);
        }
      })
      .catch((err) => {
        console.error('Failed to evaluate features:', err);
      });
  }, [part.features, draftFeature]);

  // Show sketch overlay when a committed feature is selected (not drafting)
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    if (draftFeature || !selectedFeatureId) {
      if (!draftFeature) vp.setSketchOverlay(null, null);
      return;
    }

    const feature = part.features.find((f) => f.id === selectedFeatureId);
    if (!feature || !('plane' in feature) || !('sketchDocumentId' in feature)) {
      vp.setSketchOverlay(null, null);
      return;
    }

    let cancelled = false;
    const sketchFeature = feature as ExtrudeFeature | RevolveFeature;
    api.getDocument(sketchFeature.sketchDocumentId)
      .then((full) => {
        if (cancelled) return;
        const doc = full.data as unknown as Document;
        const sketch = doc.sketches.find((s) => s.id === sketchFeature.sketchId);
        if (sketch) {
          const overlay = buildSketchOverlay(sketch, sketchFeature.plane);
          vp.setSketchOverlay(
            overlay.linePositions,
            { center: overlay.planeCenter, normal: overlay.planeNormal, xAxis: overlay.planeXAxis, size: overlay.planeSize },
          );
        } else {
          vp.setSketchOverlay(null, null);
        }
      })
      .catch(() => {
        if (!cancelled) vp.setSketchOverlay(null, null);
      });

    return () => { cancelled = true; };
  }, [selectedFeatureId, draftFeature, part.features]);

  // Fetch sketch doc when draft feature changes sketch reference
  useEffect(() => {
    if (!draftFeature || !('sketchDocumentId' in draftFeature)) {
      return;
    }
    const docId = draftFeature.sketchDocumentId;
    if (!docId) return;
    // Don't re-fetch if we already have it for the same doc
    if (draftSketchDoc && draftSketchDoc.id === docId) return;

    api.getDocument(docId)
      .then((full) => {
        setDraftSketchDoc(full.data as unknown as Document);
      })
      .catch(() => setDraftSketchDoc(null));
  }, [draftFeature && 'sketchDocumentId' in draftFeature ? draftFeature.sketchDocumentId : null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Instant overlay update — no throttle, sub-millisecond math only
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || !draftFeature) return;

    // Update sketch overlay for features with a sketch + plane
    if ('sketchId' in draftFeature && 'plane' in draftFeature) {
      const df = draftFeature as ExtrudeFeature | RevolveFeature;
      const doc = draftSketchDoc;
      const sketch = doc?.sketches.find((s) => s.id === df.sketchId);
      if (sketch) {
        const overlay = buildSketchOverlay(sketch, df.plane);
        vp.setSketchOverlay(
          overlay.linePositions,
          { center: overlay.planeCenter, normal: overlay.planeNormal, xAxis: overlay.planeXAxis, size: overlay.planeSize },
        );
      }
    }

    // Update extrude arrow gizmo
    if (draftFeature.type === 'extrude') {
      const ext = draftFeature as ExtrudeFeature;
      vp.setExtrudeArrow(
        ext.plane.origin,
        ext.plane.normal,
        ext.distance,
        ext.direction === 'reverse' ? 'reverse' : 'forward',
      );
    }
  }, [draftFeature, draftSketchDoc]);

  // Throttled preview evaluation when draftFeature changes
  // Fires at most once per 250ms, ensuring updates during continuous drag
  useEffect(() => {
    if (!draftFeature) {
      viewportRef.current?.clearPreview();
      viewportRef.current?.clearExtrudeArrow();
      return;
    }

    const counter = ++previewCounterRef.current;
    const now = Date.now();
    const elapsed = now - lastPreviewTimeRef.current;

    // If enough time has passed, fire immediately
    if (elapsed >= 250) {
      lastPreviewTimeRef.current = now;
      runPreview(counter);
      return;
    }

    // Otherwise schedule for the remaining interval
    const timer = setTimeout(() => {
      lastPreviewTimeRef.current = Date.now();
      runPreview(counter);
    }, 250 - elapsed);

    return () => clearTimeout(timer);
  }, [draftFeature]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runPreview(counter: number) {
    const draft = usePartEditorStore.getState().draftFeature;
    if (!draft) return;

    const committedFeatures = usePartStore.getState().part.features;
    const existingId = usePartEditorStore.getState().editingExistingId;

    // Build preview feature list
    let previewFeatures: Feature[];
    if (existingId) {
      previewFeatures = committedFeatures.map((f) => f.id === existingId ? draft : f);
    } else {
      previewFeatures = [...committedFeatures, draft];
    }

    try {
      // Gather all sketch doc IDs needed
      const docIds = collectDocIds(previewFeatures);
      const entries = await Promise.all(
        docIds.map(async (docId) => {
          // Use cached draftSketchDoc if available
          const cached = usePartEditorStore.getState().draftSketchDoc;
          if (cached && cached.id === docId) return [docId, cached] as const;
          const full = await api.getDocument(docId);
          return [docId, full.data as unknown as Document] as const;
        }),
      );

      if (previewCounterRef.current !== counter) return; // Stale

      const docMap = new Map<string, Document>(entries);
      const meshes = await evaluateFeatures(previewFeatures, docMap);

      if (previewCounterRef.current !== counter) return; // Stale

      const vp = viewportRef.current;
      if (!vp) return;

      // Capture edge data for edge picking
      if (meshes.length > 0 && meshes[0]!.edgeData) {
        edgeDataRef.current = meshes[0]!.edgeData;
        // If edge picking is active but wireframe wasn't set yet (async race),
        // update the wireframe now so edges become hoverable
        if (vp.isEdgePickingActive()) {
          vp.setEdgeWireframe(edgeDataRef.current);
        }
      }

      // Hide committed meshes, show preview
      const previewEdgeData = meshes.length > 0 ? meshes[0]!.edgeData : null;
      vp.setMeshes([]);
      vp.setPreviewMesh(meshes.length > 0 ? meshes[0]!.geometry : null, previewEdgeData);

      // Position extrude arrow gizmo
      if (draft.type === 'extrude') {
        const ext = draft as ExtrudeFeature;
        vp.setExtrudeArrow(
          ext.plane.origin,
          ext.plane.normal,
          ext.distance,
          ext.direction === 'reverse' ? 'reverse' : 'forward',
        );
      }

      // Build sketch overlay (only for features with a sketch/plane)
      if ('sketchId' in draft && 'plane' in draft) {
        const sketchDocId = (draft as ExtrudeFeature | RevolveFeature).sketchDocumentId;
        const sketchId = (draft as ExtrudeFeature | RevolveFeature).sketchId;
        const plane: Plane = (draft as ExtrudeFeature | RevolveFeature).plane;
        const doc = docMap.get(sketchDocId);
        const sketch = doc?.sketches.find((s) => s.id === sketchId);
        if (sketch) {
          const overlay = buildSketchOverlay(sketch, plane);
          vp.setSketchOverlay(
            overlay.linePositions,
            { center: overlay.planeCenter, normal: overlay.planeNormal, xAxis: overlay.planeXAxis, size: overlay.planeSize },
          );
        } else {
          vp.setSketchOverlay(null, null);
        }
      } else {
        vp.setSketchOverlay(null, null);
      }
    } catch (err) {
      console.error('Preview evaluation failed:', err);
    }
  }

  // --- Toolbar handlers ---

  const handleAddExtrude = useCallback(() => {
    const sketchId = rolodexSketchIdRef.current;
    const docId = usePartStore.getState().part.documentId;
    startCreating({
      id: crypto.randomUUID(),
      type: 'extrude',
      sketchDocumentId: docId,
      sketchId,
      plane: DEFAULT_XY_PLANE,
      distance: 20,
      direction: 'forward',
      operation: 'add',
    });
  }, [startCreating]);

  const handleAddRevolve = useCallback(() => {
    const sketchId = rolodexSketchIdRef.current;
    const docId = usePartStore.getState().part.documentId;
    startCreating({
      id: crypto.randomUUID(),
      type: 'revolve',
      sketchDocumentId: docId,
      sketchId,
      plane: DEFAULT_XY_PLANE,
      axisEntityId: '',
      angle: 360,
      operation: 'add',
    });
  }, [startCreating]);

  const handleAddShell = useCallback(() => {
    startCreating({
      id: crypto.randomUUID(),
      type: 'shell',
      thickness: 1,
      faceDirection: [0, 0, 1],
    });
  }, [startCreating]);

  const handleAddFillet = useCallback(() => {
    const features = usePartStore.getState().part.features;
    if (features.length === 0) return;
    setSelectedEdges([]);
    startCreating({
      id: crypto.randomUUID(),
      type: 'fillet',
      radius: 2,
      edgeIndices: [],
    });
  }, [startCreating]);

  const handleAddChamfer = useCallback(() => {
    const features = usePartStore.getState().part.features;
    if (features.length === 0) return;
    setSelectedEdges([]);
    startCreating({
      id: crypto.randomUUID(),
      type: 'chamfer',
      distance: 1,
      edgeIndices: [],
    });
  }, [startCreating]);

  const handleAddLoft = useCallback(() => {
    const docId = usePartStore.getState().part.documentId;
    startCreating({
      id: crypto.randomUUID(),
      type: 'loft',
      sections: [
        { sketchDocumentId: docId, sketchId: '', plane: DEFAULT_XY_PLANE },
        { sketchDocumentId: docId, sketchId: '', plane: planeWithOffset(DEFAULT_XY_PLANE, 20) },
      ],
      operation: 'add',
    });
  }, [startCreating]);

  const handleSketchOnFace = useCallback(() => {
    setSketchOnFacePending(true);
  }, []);

  const handleEditFeature = useCallback((feature: Feature) => {
    if (feature.type === 'fillet' || feature.type === 'chamfer') {
      setSelectedEdges((feature as FilletFeature | ChamferFeature).edgeIndices);
    }
    startEditing(feature);
  }, [startEditing]);

  // --- Unified submit/cancel ---

  const handleSubmit = useCallback((feature: Feature) => {
    const existingId = usePartEditorStore.getState().editingExistingId;
    beginTransaction(existingId ? `Edit ${feature.type}` : `Add ${feature.type}`);
    if (existingId) {
      updateFeature(feature.id, feature);
    } else {
      addFeature(feature);
    }
    clearDraft();
    setSelectedEdges([]);
    viewportRef.current?.clearPreview();
    viewportRef.current?.clearExtrudeArrow();
    viewportRef.current?.clearPlaneGizmo();
    viewportRef.current?.disableEdgePicking();
    viewportRef.current?.setEdgeWireframe(null);
  }, [beginTransaction, updateFeature, addFeature, clearDraft]);

  const handleCancel = useCallback(() => {
    clearDraft();
    setSelectedEdges([]);
    viewportRef.current?.clearPreview();
    viewportRef.current?.clearExtrudeArrow();
    viewportRef.current?.clearPlaneGizmo();
    viewportRef.current?.disableEdgePicking();
    viewportRef.current?.setEdgeWireframe(null);
  }, [clearDraft]);

  const handleDraftChange = useCallback((feature: Feature) => {
    setDraftFeature(feature);
  }, [setDraftFeature]);

  const handleRolodexChange = useCallback((sketchId: string) => {
    rolodexSketchIdRef.current = sketchId;
  }, []);

  // --- Export handlers (unchanged) ---

  const handleExportSTL = useCallback(() => {
    const features = usePartStore.getState().part.features;
    if (features.length === 0) return;

    const docIds = collectDocIds(features);
    Promise.all(docIds.map((docId) => api.getDocument(docId).then((full) => [docId, full.data as unknown as Document] as const)))
      .then(async (entries) => {
        const docMap = new Map<string, Document>(entries);
        const meshes = await evaluateFeatures(features, docMap);
        const blob = exportSTL(meshes.map((m) => m.geometry));
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${part.name || 'part'}.stl`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((err) => {
        console.error('STL export failed:', err);
      });
  }, [part.name]);

  const handleExportSTEP = useCallback(() => {
    const features = usePartStore.getState().part.features;
    if (features.length === 0) return;

    const docIds = collectDocIds(features);
    Promise.all(docIds.map((docId) => api.getDocument(docId).then((full) => [docId, full.data as unknown as Document] as const)))
      .then(async (entries) => {
        const docMap = new Map<string, Document>(entries);
        const blob = await exportFeaturesToSTEP(features, docMap);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${part.name || 'part'}.step`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((err) => {
        console.error('STEP export failed:', err);
      });
  }, [part.name]);

  // --- Render sidebar content ---

  function renderSidebarContent() {
    if (draftFeature) {
      const initial = editingExistingId
        ? part.features.find((f) => f.id === editingExistingId) ?? undefined
        : undefined;

      switch (draftFeature.type) {
        case 'extrude':
          return (
            <ExtrudeForm
              ref={extrudeFormRef}
              documentId={part.documentId}
              initial={initial?.type === 'extrude' ? initial : undefined}
              defaultSketchId={rolodexSketchIdRef.current}
              sketchDoc={draftSketchDoc ?? undefined}
              onSubmit={(f) => handleSubmit(f)}
              onCancel={handleCancel}
              onChange={(f) => handleDraftChange(f)}
            />
          );
        case 'revolve':
          return (
            <RevolveForm
              ref={revolveFormRef}
              documentId={part.documentId}
              initial={initial?.type === 'revolve' ? initial : undefined}
              defaultSketchId={rolodexSketchIdRef.current}
              sketchDoc={draftSketchDoc ?? undefined}
              onSubmit={(f) => handleSubmit(f)}
              onCancel={handleCancel}
              onChange={(f) => handleDraftChange(f)}
            />
          );
        case 'shell':
          return (
            <ShellForm
              initial={initial?.type === 'shell' ? initial : undefined}
              onSubmit={(f) => handleSubmit(f)}
              onCancel={handleCancel}
              onChange={(f) => handleDraftChange(f)}
            />
          );
        case 'fillet':
          return (
            <FilletForm
              initial={initial?.type === 'fillet' ? initial : undefined}
              selectedEdges={selectedEdges}
              onSubmit={(f) => handleSubmit(f)}
              onCancel={handleCancel}
              onChange={(f) => handleDraftChange(f)}
            />
          );
        case 'chamfer':
          return (
            <ChamferForm
              initial={initial?.type === 'chamfer' ? initial : undefined}
              selectedEdges={selectedEdges}
              onSubmit={(f) => handleSubmit(f)}
              onCancel={handleCancel}
              onChange={(f) => handleDraftChange(f)}
            />
          );
        case 'loft':
          return (
            <LoftForm
              ref={loftFormRef}
              documentId={part.documentId}
              initial={initial?.type === 'loft' ? initial : undefined}
              onSubmit={(f) => handleSubmit(f)}
              onCancel={handleCancel}
              onChange={(f) => handleDraftChange(f)}
              onActiveSectionChange={setActiveLoftSection}
            />
          );
      }
    }

    return (
      <>
        <SketchRolodex onSketchChange={handleRolodexChange} />
        <FeaturePanel onEditFeature={handleEditFeature} />
      </>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: palette.background,
        color: palette.text,
      }}
    >
      <PartToolbar onAddExtrude={handleAddExtrude} onAddRevolve={handleAddRevolve} onAddShell={handleAddShell} onAddFillet={handleAddFillet} onAddChamfer={handleAddChamfer} onAddLoft={handleAddLoft} onSketchOnFace={handleSketchOnFace} onExportSTL={handleExportSTL} onExportSTEP={handleExportSTEP} />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
        <div
          ref={containerRef}
          style={{ flex: 1, position: 'relative' }}
        />

        <div style={{
          width: '240px',
          background: palette.panelBg,
          borderLeft: `1px solid ${palette.border}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
        }}>
          {renderSidebarContent()}
        </div>
      </div>
    </div>
  );
}
