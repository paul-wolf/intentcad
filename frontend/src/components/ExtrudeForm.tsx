import { useState, useEffect } from 'react';
import { api } from '@/api/client';
import { useThemeStore } from '@/theme';
import type { Document } from '@/types/document';
import type { ExtrudeFeature, Plane } from '@/types/part';
import { PLANE_PRESETS, planeWithOffset } from '@/types/part';
import { getExtrudableEntities } from '@/part/profileDetect';

interface ExtrudeFormProps {
  documentId: string;
  initial?: ExtrudeFeature;
  onSubmit: (feature: ExtrudeFeature) => void;
  onCancel: () => void;
}

export function ExtrudeForm({ documentId, initial, onSubmit, onCancel }: ExtrudeFormProps) {
  const palette = useThemeStore((s) => s.palette);

  const [sketchDoc, setSketchDoc] = useState<Document | null>(null);
  const [selectedSketchId, setSelectedSketchId] = useState(initial?.sketchId ?? '');
  const [distance, setDistance] = useState(initial?.distance ?? 20);
  const [operation, setOperation] = useState<'add' | 'remove'>(initial?.operation ?? 'add');

  // Plane controls
  const presetNames = Object.keys(PLANE_PRESETS);
  const [planePreset, setPlanePreset] = useState(() => {
    if (!initial) return presetNames[0]!;
    for (const [name, preset] of Object.entries(PLANE_PRESETS)) {
      if (preset.normal[0] === initial.plane.normal[0] &&
          preset.normal[1] === initial.plane.normal[1] &&
          preset.normal[2] === initial.plane.normal[2]) {
        return name;
      }
    }
    return presetNames[0]!;
  });
  const [planeOffset, setPlaneOffset] = useState(() => {
    if (!initial) return 0;
    const p = initial.plane;
    return p.origin[0] * p.normal[0] + p.origin[1] * p.normal[1] + p.origin[2] * p.normal[2];
  });

  // Load the document
  useEffect(() => {
    if (!documentId) return;
    api.getDocument(documentId)
      .then((full) => {
        setSketchDoc(full.data as unknown as Document);
      })
      .catch(() => setSketchDoc(null));
  }, [documentId]);

  // Auto-select sketch when doc loads
  useEffect(() => {
    if (sketchDoc && !selectedSketchId && sketchDoc.sketches.length > 0) {
      setSelectedSketchId(sketchDoc.sketches[0]!.id);
    }
  }, [sketchDoc, selectedSketchId]);

  const sketch = sketchDoc?.sketches.find((s) => s.id === selectedSketchId);
  const hasExtrudable = sketch ? getExtrudableEntities(sketch).length > 0 : false;

  const canSubmit = selectedSketchId && hasExtrudable && distance > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const basePlane = PLANE_PRESETS[planePreset] ?? PLANE_PRESETS[presetNames[0]!]!;
    const plane: Plane = planeOffset !== 0 ? planeWithOffset(basePlane, planeOffset) : basePlane;
    const feature: ExtrudeFeature = {
      id: initial?.id ?? crypto.randomUUID(),
      type: 'extrude',
      sketchDocumentId: documentId,
      sketchId: selectedSketchId,
      plane,
      distance,
      operation,
    };
    onSubmit(feature);
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '12px',
    color: palette.textSecondary,
    marginBottom: '4px',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '4px 8px',
    background: palette.inputBg,
    color: palette.text,
    border: `1px solid ${palette.inputBorder}`,
    borderRadius: '4px',
    fontSize: '13px',
    boxSizing: 'border-box',
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: palette.panelBg,
        border: `1px solid ${palette.border}`,
        borderRadius: '8px',
        padding: '16px',
        width: '320px',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ fontSize: '14px', fontWeight: 600, color: palette.text }}>
        {initial ? 'Edit Extrude' : 'Add Extrude'}
      </div>

      {sketchDoc && sketchDoc.sketches.length > 1 && (
        <div>
          <div style={labelStyle}>Sketch</div>
          <select
            style={inputStyle}
            value={selectedSketchId}
            onChange={(e) => setSelectedSketchId(e.target.value)}
          >
            {sketchDoc.sketches.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      )}

      {sketchDoc && !hasExtrudable && (
        <div style={{ fontSize: '12px', color: palette.danger }}>
          No extrudable profiles found (need a rectangle, circle, or closed polygon).
        </div>
      )}

      <div>
        <div style={labelStyle}>Plane</div>
        <select
          style={inputStyle}
          value={planePreset}
          onChange={(e) => setPlanePreset(e.target.value)}
        >
          {presetNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      <div>
        <div style={labelStyle}>Plane offset (mm)</div>
        <input
          type="number"
          style={inputStyle}
          value={planeOffset}
          step={1}
          onChange={(e) => setPlaneOffset(parseFloat(e.target.value) || 0)}
        />
      </div>

      <div>
        <div style={labelStyle}>Distance (mm)</div>
        <input
          type="number"
          style={inputStyle}
          value={distance}
          min={0.1}
          step={1}
          onChange={(e) => setDistance(parseFloat(e.target.value) || 0)}
        />
      </div>

      <div>
        <div style={labelStyle}>Operation</div>
        <select
          style={inputStyle}
          value={operation}
          onChange={(e) => setOperation(e.target.value as 'add' | 'remove')}
        >
          <option value="add">Add</option>
          <option value="remove">Remove</option>
        </select>
      </div>

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button
          style={{
            padding: '6px 16px',
            background: palette.buttonBg,
            color: palette.text,
            border: `1px solid ${palette.border}`,
            borderRadius: '4px',
            fontSize: '13px',
            cursor: 'pointer',
          }}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          style={{
            padding: '6px 16px',
            background: canSubmit ? palette.primaryBtn : palette.border,
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            fontSize: '13px',
            cursor: canSubmit ? 'pointer' : 'default',
            opacity: canSubmit ? 1 : 0.5,
          }}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {initial ? 'Update' : 'Add'}
        </button>
      </div>
    </div>
  );
}
