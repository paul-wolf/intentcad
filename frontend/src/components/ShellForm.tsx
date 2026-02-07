import { useState, useEffect, useRef } from 'react';
import { useThemeStore } from '@/theme';
import type { ShellFeature } from '@/types/part';

const DIRECTION_PRESETS: Record<string, [number, number, number]> = {
  'Top (+Z)': [0, 0, 1],
  'Bottom (-Z)': [0, 0, -1],
  'Front (-Y)': [0, -1, 0],
  'Back (+Y)': [0, 1, 0],
  'Left (-X)': [-1, 0, 0],
  'Right (+X)': [1, 0, 0],
};

interface ShellFormProps {
  initial?: ShellFeature;
  onSubmit: (feature: ShellFeature) => void;
  onCancel: () => void;
  onChange?: (feature: ShellFeature) => void;
}

export function ShellForm({ initial, onSubmit, onCancel, onChange }: ShellFormProps) {
  const palette = useThemeStore((s) => s.palette);

  const [thickness, setThickness] = useState(initial?.thickness ?? 1);
  const featureIdRef = useRef(initial?.id ?? crypto.randomUUID());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const presetNames = Object.keys(DIRECTION_PRESETS);
  const [dirPreset, setDirPreset] = useState(() => {
    if (!initial) return presetNames[0]!;
    for (const [name, dir] of Object.entries(DIRECTION_PRESETS)) {
      if (dir[0] === initial.faceDirection[0] &&
          dir[1] === initial.faceDirection[1] &&
          dir[2] === initial.faceDirection[2]) {
        return name;
      }
    }
    return presetNames[0]!;
  });

  const canSubmit = thickness > 0;

  // Fire onChange whenever parameters change
  useEffect(() => {
    if (!onChangeRef.current) return;
    const faceDirection = DIRECTION_PRESETS[dirPreset] ?? DIRECTION_PRESETS[presetNames[0]!]!;
    const feature: ShellFeature = {
      id: featureIdRef.current,
      type: 'shell',
      thickness,
      faceDirection,
    };
    onChangeRef.current(feature);
  }, [thickness, dirPreset]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = () => {
    if (!canSubmit) return;
    const faceDirection = DIRECTION_PRESETS[dirPreset] ?? DIRECTION_PRESETS[presetNames[0]!]!;
    const feature: ShellFeature = {
      id: featureIdRef.current,
      type: 'shell',
      thickness,
      faceDirection,
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
        {initial ? 'Edit Shell' : 'Add Shell'}
      </div>

      <div style={{ fontSize: '11px', color: palette.textSecondary }}>
        Hollows the solid by removing face(s) in the chosen direction and offsetting walls inward.
      </div>

      <div>
        <div style={labelStyle}>Open face direction</div>
        <select
          style={inputStyle}
          value={dirPreset}
          onChange={(e) => setDirPreset(e.target.value)}
        >
          {presetNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      <div>
        <div style={labelStyle}>Wall thickness (mm)</div>
        <input
          type="number"
          style={inputStyle}
          value={thickness}
          min={0.1}
          step={0.5}
          onChange={(e) => setThickness(parseFloat(e.target.value) || 0)}
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
