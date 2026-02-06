import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { usePartStore } from '@/stores/partStore';
import { useThemeStore } from '@/theme';
import { partApi } from '@/api/client';
import { api } from '@/api/client';
import { setPartBackendId, startPartAutoSave } from '@/api/partAutoSave';
import { PartViewport } from '@/part/PartViewport';
import { evaluateFeatures } from '@/part/featureEngine';
import { exportSTL } from '@/part/stlExport';
import { PartToolbar } from './PartToolbar';
import { FeaturePanel } from './FeaturePanel';
import { SketchRolodex } from './SketchRolodex';
import { ExtrudeForm } from './ExtrudeForm';
import type { Part, Feature, ExtrudeFeature } from '@/types/part';
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

  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<PartViewport | null>(null);
  const [showExtrudeForm, setShowExtrudeForm] = useState(false);
  const [editingFeature, setEditingFeature] = useState<ExtrudeFeature | null>(null);

  // Load part from backend
  useEffect(() => {
    if (!id) return;
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

  // Re-evaluate meshes when features change
  useEffect(() => {
    const features = part.features;
    if (features.length === 0) {
      viewportRef.current?.setMeshes([]);
      return;
    }

    // Fetch all referenced sketch documents
    const docIds = [...new Set(features.map((f) => f.sketchDocumentId))];
    Promise.all(docIds.map((docId) => api.getDocument(docId).then((full) => [docId, full.data as unknown as Document] as const)))
      .then((entries) => {
        const docMap = new Map<string, Document>(entries);
        const meshes = evaluateFeatures(features, docMap);
        viewportRef.current?.setMeshes(meshes.map((m) => m.geometry));
      })
      .catch((err) => {
        console.error('Failed to evaluate features:', err);
      });
  }, [part.features]);

  const handleAddExtrude = useCallback(() => {
    setEditingFeature(null);
    setShowExtrudeForm(true);
  }, []);

  const handleEditFeature = useCallback((feature: Feature) => {
    if (feature.type === 'extrude') {
      setEditingFeature(feature);
      setShowExtrudeForm(true);
    }
  }, []);

  const handleExtrudeSubmit = useCallback((feature: ExtrudeFeature) => {
    beginTransaction(editingFeature ? 'Edit extrude' : 'Add extrude');
    if (editingFeature) {
      updateFeature(feature.id, feature);
    } else {
      addFeature(feature);
    }
    setShowExtrudeForm(false);
    setEditingFeature(null);
  }, [editingFeature, beginTransaction, updateFeature, addFeature]);

  const handleExportSTL = useCallback(() => {
    const features = usePartStore.getState().part.features;
    if (features.length === 0) return;

    const docIds = [...new Set(features.map((f) => f.sketchDocumentId))];
    Promise.all(docIds.map((docId) => api.getDocument(docId).then((full) => [docId, full.data as unknown as Document] as const)))
      .then((entries) => {
        const docMap = new Map<string, Document>(entries);
        const meshes = evaluateFeatures(features, docMap);
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
      <PartToolbar onAddExtrude={handleAddExtrude} onExportSTL={handleExportSTL} />

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
          <SketchRolodex />
          <FeaturePanel onEditFeature={handleEditFeature} />
        </div>

        {showExtrudeForm && (
          <ExtrudeForm
            documentId={part.documentId}
            initial={editingFeature ?? undefined}
            onSubmit={handleExtrudeSubmit}
            onCancel={() => { setShowExtrudeForm(false); setEditingFeature(null); }}
          />
        )}
      </div>
    </div>
  );
}
