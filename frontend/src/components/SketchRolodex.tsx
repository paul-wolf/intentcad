import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePartStore } from '@/stores/partStore';
import { useThemeStore } from '@/theme';
import { api } from '@/api/client';
import type { Document, Sketch } from '@/types/document';
import { getExtrudableEntities } from '@/part/profileDetect';
import type { ExtrudeFeature } from '@/types/part';
import { DEFAULT_XY_PLANE } from '@/types/part';
import { SketchThumbnail } from './SketchThumbnail';

interface SketchRolodexProps {
  onSketchChange?: (sketchId: string) => void;
}

export function SketchRolodex({ onSketchChange }: SketchRolodexProps = {}) {
  const navigate = useNavigate();
  const part = usePartStore((s) => s.part);
  const beginTransaction = usePartStore((s) => s.beginTransaction);
  const addFeature = usePartStore((s) => s.addFeature);
  const palette = useThemeStore((s) => s.palette);
  const [sketches, setSketches] = useState<Sketch[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    if (!part.documentId) return;
    api.getDocument(part.documentId)
      .then((full) => {
        const doc = full.data as unknown as Document;
        setSketches(doc.sketches);
      })
      .catch(() => setSketches([]));
  }, [part.documentId]);

  // Notify parent of current sketch selection
  useEffect(() => {
    if (sketches.length > 0 && sketches[selectedIdx]) {
      onSketchChange?.(sketches[selectedIdx]!.id);
    }
  }, [selectedIdx, sketches, onSketchChange]);

  if (sketches.length === 0) return null;

  const currentSketch = sketches[selectedIdx]!;
  const canPrev = selectedIdx > 0;
  const canNext = selectedIdx < sketches.length - 1;
  const hasExtrudable = getExtrudableEntities(currentSketch).length > 0;
  // Check if this sketch already has a feature
  const alreadyExtruded = part.features.some(
    (f) => 'sketchId' in f && f.sketchId === currentSketch.id,
  );

  const handleExtrude = () => {
    if (!hasExtrudable) return;
    beginTransaction('Add extrude');
    const feature: ExtrudeFeature = {
      id: crypto.randomUUID(),
      type: 'extrude',
      sketchDocumentId: part.documentId,
      sketchId: currentSketch.id,
      plane: DEFAULT_XY_PLANE,
      distance: 20,
      operation: 'add',
    };
    addFeature(feature);
  };

  const navBtnStyle: React.CSSProperties = {
    background: 'none',
    border: `1px solid ${palette.border}`,
    borderRadius: '3px',
    color: palette.text,
    cursor: 'pointer',
    fontSize: '14px',
    width: '24px',
    height: '24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderBottom: `1px solid ${palette.border}`,
        padding: '8px',
        gap: '6px',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{
          fontSize: '12px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: palette.textMuted,
        }}>
          Sketches
        </span>
        <button
          style={{
            background: 'none',
            border: `1px solid ${palette.border}`,
            borderRadius: '3px',
            color: palette.accent,
            cursor: 'pointer',
            fontSize: '10px',
            padding: '2px 6px',
          }}
          onClick={() => navigate(`/edit/${part.documentId}`)}
          title="Edit sketches"
        >
          Edit
        </button>
      </div>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      }}>
        <button
          style={{ ...navBtnStyle, opacity: canPrev ? 1 : 0.3 }}
          disabled={!canPrev}
          onClick={() => setSelectedIdx((i) => i - 1)}
        >
          {'\u2039'}
        </button>
        <SketchThumbnail
          sketch={currentSketch}
          width={160}
          height={100}
          background={palette.background}
          stroke={palette.line}
          label={currentSketch.name}
          onClick={hasExtrudable && !alreadyExtruded ? handleExtrude : undefined}
        />
        <button
          style={{ ...navBtnStyle, opacity: canNext ? 1 : 0.3 }}
          disabled={!canNext}
          onClick={() => setSelectedIdx((i) => i + 1)}
        >
          {'\u203a'}
        </button>
      </div>
      <div style={{ fontSize: '10px', color: palette.textSecondary, textAlign: 'center' }}>
        {selectedIdx + 1} / {sketches.length}
        {hasExtrudable && !alreadyExtruded && (
          <span style={{ color: palette.accent, marginLeft: '6px' }}>
            Click to extrude
          </span>
        )}
        {alreadyExtruded && (
          <span style={{ color: palette.constrained, marginLeft: '6px' }}>
            Extruded
          </span>
        )}
      </div>
    </div>
  );
}
