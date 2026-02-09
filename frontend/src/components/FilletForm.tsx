import { useState, useEffect, useRef } from 'react';
import { useThemeStore } from '@/theme';
import type { FilletFeature } from '@/types/part';

interface FilletFormProps {
  initial?: FilletFeature;
  selectedEdges: number[];
  onSubmit: (feature: FilletFeature) => void;
  onCancel: () => void;
  onChange?: (feature: FilletFeature) => void;
}

export function FilletForm({ initial, selectedEdges, onSubmit, onCancel, onChange }: FilletFormProps) {
  const palette = useThemeStore((s) => s.palette);

  const [radius, setRadius] = useState(initial?.radius ?? 2);
  const featureIdRef = useRef(initial?.id ?? crypto.randomUUID());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const canSubmit = radius > 0 && selectedEdges.length > 0;

  useEffect(() => {
    if (!onChangeRef.current) return;
    const feature: FilletFeature = {
      id: featureIdRef.current,
      type: 'fillet',
      radius,
      edgeIndices: selectedEdges,
    };
    onChangeRef.current(feature);
  }, [radius, selectedEdges]);

  const handleSubmit = () => {
    if (!canSubmit) return;
    const feature: FilletFeature = {
      id: featureIdRef.current,
      type: 'fillet',
      radius,
      edgeIndices: selectedEdges,
    };
    onSubmit(feature);
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    color: palette.textSecondary,
    marginBottom: '2px',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '3px 6px',
    background: palette.inputBg,
    color: palette.text,
    border: `1px solid ${palette.inputBorder}`,
    borderRadius: '4px',
    fontSize: '12px',
    boxSizing: 'border-box',
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '8px 10px',
      }}
    >
      <div style={{ fontSize: '13px', fontWeight: 600, color: palette.text }}>
        {initial ? 'Edit Fillet' : 'Add Fillet'}
      </div>

      <div style={{ fontSize: '11px', color: palette.textSecondary }}>
        Click edges on the model to select them. Hover to highlight.
      </div>

      <div style={{ fontSize: '12px', color: palette.text }}>
        {selectedEdges.length} edge{selectedEdges.length !== 1 ? 's' : ''} selected
      </div>

      <div>
        <div style={labelStyle}>Radius (mm)</div>
        <input
          type="number"
          style={inputStyle}
          value={radius}
          min={0.1}
          step={0.5}
          onChange={(e) => setRadius(parseFloat(e.target.value) || 0)}
        />
      </div>

      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '4px' }}>
        <button
          style={{
            padding: '4px 12px',
            background: palette.buttonBg,
            color: palette.text,
            border: `1px solid ${palette.border}`,
            borderRadius: '4px',
            fontSize: '12px',
            cursor: 'pointer',
          }}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          style={{
            padding: '4px 12px',
            background: canSubmit ? palette.primaryBtn : palette.border,
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            fontSize: '12px',
            cursor: canSubmit ? 'pointer' : 'default',
            opacity: canSubmit ? 1 : 0.5,
          }}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {initial ? 'Update' : 'Apply'}
        </button>
      </div>
    </div>
  );
}
