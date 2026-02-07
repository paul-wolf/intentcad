import { useState, useEffect } from 'react';
import { usePartStore } from '@/stores/partStore';
import { usePartEditorStore } from '@/stores/partEditorStore';
import { useThemeStore } from '@/theme';
import { api } from '@/api/client';
import type { Feature, ExtrudeFeature, RevolveFeature } from '@/types/part';
import type { Document } from '@/types/document';

interface FeaturePanelProps {
  onEditFeature: (feature: Feature) => void;
}

export function FeaturePanel({ onEditFeature }: FeaturePanelProps) {
  const features = usePartStore((s) => s.part.features);
  const beginTransaction = usePartStore((s) => s.beginTransaction);
  const removeFeature = usePartStore((s) => s.removeFeature);
  const selectedFeatureId = usePartEditorStore((s) => s.selectedFeatureId);
  const setSelectedFeatureId = usePartEditorStore((s) => s.setSelectedFeatureId);
  const palette = useThemeStore((s) => s.palette);

  // Build a map of sketchId → sketch name from referenced documents
  const [sketchNames, setSketchNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const docIds = [
      ...new Set(
        features
          .filter((f): f is ExtrudeFeature | RevolveFeature => 'sketchDocumentId' in f)
          .map((f) => f.sketchDocumentId),
      ),
    ];
    if (docIds.length === 0) {
      setSketchNames(new Map());
      return;
    }
    let cancelled = false;
    Promise.all(
      docIds.map((docId) =>
        api.getDocument(docId).then((full) => full.data as unknown as Document).catch(() => null),
      ),
    ).then((docs) => {
      if (cancelled) return;
      const map = new Map<string, string>();
      for (const doc of docs) {
        if (!doc) continue;
        for (const sk of doc.sketches) {
          map.set(sk.id, sk.name);
        }
      }
      setSketchNames(map);
    });
    return () => { cancelled = true; };
  }, [features]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          fontSize: '13px',
          fontWeight: 600,
          color: palette.text,
          borderBottom: `1px solid ${palette.border}`,
        }}
      >
        Features
      </div>

      {features.length === 0 && (
        <div style={{ padding: '12px', fontSize: '12px', color: palette.textSecondary }}>
          No features yet. Click "Add Extrude" or "Add Revolve" to begin.
        </div>
      )}

      {features.map((f) => (
        <div
          key={f.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 12px',
            cursor: 'pointer',
            background: selectedFeatureId === f.id ? palette.activeItemBg : 'transparent',
            borderBottom: `1px solid ${palette.border}`,
          }}
          onClick={() => setSelectedFeatureId(f.id)}
          onDoubleClick={() => onEditFeature(f)}
        >
          <span style={{ fontSize: '12px', color: palette.accent }}>
            {f.type === 'extrude' ? 'E' : f.type === 'revolve' ? 'R' : f.type === 'shell' ? 'S' : '?'}
          </span>
          <span style={{ flex: 1, fontSize: '12px', color: palette.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {f.type === 'shell'
              ? `Shell ${f.thickness}mm`
              : f.type === 'revolve'
                ? `${f.operation === 'remove' ? 'Cut' : 'Revolve'} ${f.angle}\u00B0`
                : `${f.operation === 'remove' ? 'Cut' : 'Extrude'} ${Math.abs(f.distance)}mm`}
            {'sketchId' in f && sketchNames.has(f.sketchId) && (
              <span style={{ color: palette.textSecondary, marginLeft: '4px' }}>
                ({sketchNames.get(f.sketchId)})
              </span>
            )}
          </span>
          <button
            style={{
              background: 'none',
              border: 'none',
              color: palette.danger,
              cursor: 'pointer',
              fontSize: '13px',
              padding: '0 2px',
            }}
            onClick={(e) => {
              e.stopPropagation();
              beginTransaction('Remove feature');
              removeFeature(f.id);
            }}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}
