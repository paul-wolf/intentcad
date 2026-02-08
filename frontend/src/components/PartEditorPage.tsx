import { useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { usePartStore } from '@/stores/partStore';
import { usePartEditorStore } from '@/stores/partEditorStore';
import { useThemeStore } from '@/theme';
import { partApi } from '@/api/client';
import { api } from '@/api/client';
import { setPartBackendId, startPartAutoSave } from '@/api/partAutoSave';
import { PartViewport, type DragInteractionCallbacks } from '@/part/PartViewport';
import { evaluateFeatures, exportFeaturesToSTEP } from '@/part/featureEngine';
import { exportSTL } from '@/part/stlExport';
import { buildSketchOverlay } from '@/part/sketchOverlay';
import { PartToolbar } from './PartToolbar';
import { FeaturePanel } from './FeaturePanel';
import { SketchRolodex } from './SketchRolodex';
import { ExtrudeForm, type ExtrudeFormHandle } from './ExtrudeForm';
import { RevolveForm } from './RevolveForm';
import { ShellForm } from './ShellForm';
import type { Part, Feature, ExtrudeFeature, RevolveFeature, Plane } from '@/types/part';
import { DEFAULT_XY_PLANE } from '@/types/part';
import type { Document } from '@/types/document';

export function PartEditorPage() {
  const { id } = useParams<{ id: string }>();
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

  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<PartViewport | null>(null);
  const rolodexSketchIdRef = useRef<string>('');
  const previewCounterRef = useRef(0);
  const lastPreviewTimeRef = useRef(0);
  const extrudeFormRef = useRef<ExtrudeFormHandle>(null);

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
      vp.disableDragInteraction();
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

  // Re-evaluate committed meshes when features change (only when not previewing)
  useEffect(() => {
    if (draftFeature) return; // Skip — preview effect handles display while drafting
    const features = part.features;
    if (features.length === 0) {
      viewportRef.current?.setMeshes([]);
      return;
    }

    const docIds = [...new Set(features.filter((f) => 'sketchDocumentId' in f).map((f) => (f as ExtrudeFeature | RevolveFeature).sketchDocumentId))];
    Promise.all(docIds.map((docId) => api.getDocument(docId).then((full) => [docId, full.data as unknown as Document] as const)))
      .then(async (entries) => {
        const docMap = new Map<string, Document>(entries);
        const meshes = await evaluateFeatures(features, docMap);
        // Only apply if we're still not drafting
        if (!usePartEditorStore.getState().draftFeature) {
          viewportRef.current?.setMeshes(meshes.map((m) => m.geometry));
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
      const docIds = [...new Set(previewFeatures.filter((f) => 'sketchDocumentId' in f).map((f) => (f as ExtrudeFeature | RevolveFeature).sketchDocumentId))];
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

      // Hide committed meshes, show preview
      vp.setMeshes([]);
      vp.setPreviewMesh(meshes.length > 0 ? meshes[0]!.geometry : null);

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

  const handleEditFeature = useCallback((feature: Feature) => {
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
    viewportRef.current?.clearPreview();
    viewportRef.current?.clearExtrudeArrow();
  }, [beginTransaction, updateFeature, addFeature, clearDraft]);

  const handleCancel = useCallback(() => {
    clearDraft();
    viewportRef.current?.clearPreview();
    viewportRef.current?.clearExtrudeArrow();
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

    const docIds = [...new Set(features.filter((f) => 'sketchDocumentId' in f).map((f) => (f as ExtrudeFeature | RevolveFeature).sketchDocumentId))];
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

    const docIds = [...new Set(features.filter((f) => 'sketchDocumentId' in f).map((f) => (f as ExtrudeFeature | RevolveFeature).sketchDocumentId))];
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
      <PartToolbar onAddExtrude={handleAddExtrude} onAddRevolve={handleAddRevolve} onAddShell={handleAddShell} onExportSTL={handleExportSTL} onExportSTEP={handleExportSTEP} />

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
