import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { useThemeStore } from '@/theme';
import type { Feature, ConstructionPlaneFeature, Plane } from '@/types/part';
import { PLANE_PRESETS, planeWithOffset, getConstructionPlanes } from '@/types/part';
import { rotatePlane } from '@/part/planeRotation';

function resolveBasePlane(
  basePlane: string,
  customBasePlane: Plane | undefined,
  features: Feature[],
): Plane {
  if (basePlane === 'Face' && customBasePlane) return customBasePlane;
  if (basePlane.startsWith('cp:')) {
    const cpId = basePlane.slice(3);
    const cp = getConstructionPlanes(features).find((c) => c.id === cpId);
    if (cp) return cp.plane;
  }
  return PLANE_PRESETS[basePlane] ?? PLANE_PRESETS[Object.keys(PLANE_PRESETS)[0]!]!;
}

function buildFeature(
  id: string,
  name: string,
  basePlane: string,
  customBasePlane: Plane | undefined,
  offset: number,
  spin: number,
  tilt: number,
  features: Feature[],
): ConstructionPlaneFeature {
  const base = resolveBasePlane(basePlane, customBasePlane, features);
  const { normal, xAxis } = rotatePlane(base, spin, tilt);
  const rotatedBase: Plane = { origin: base.origin, normal, xAxis };
  const plane = planeWithOffset(rotatedBase, offset);
  return { id, type: 'constructionPlane', name, basePlane, customBasePlane, offset, spin, tilt, plane };
}

export interface ConstructionPlaneFormHandle {
  setPlane(plane: Plane): void;
}

interface ConstructionPlaneFormProps {
  initial?: ConstructionPlaneFeature;
  features: Feature[];
  onSubmit: (feature: ConstructionPlaneFeature) => void;
  onCancel: () => void;
  onChange?: (feature: ConstructionPlaneFeature) => void;
}

export const ConstructionPlaneForm = forwardRef<ConstructionPlaneFormHandle, ConstructionPlaneFormProps>(
  function ConstructionPlaneForm({ initial, features, onSubmit, onCancel, onChange }, ref) {
    const palette = useThemeStore((s) => s.palette);

    const [name, setName] = useState(initial?.name ?? 'Plane');
    const [basePlane, setBasePlane] = useState(initial?.basePlane ?? Object.keys(PLANE_PRESETS)[0]!);
    const [customBasePlane, setCustomBasePlane] = useState<Plane | undefined>(initial?.customBasePlane);
    const [offset, setOffset] = useState(initial?.offset ?? 0);
    const [spin, setSpin] = useState(initial?.spin ?? 0);
    const [tilt, setTilt] = useState(initial?.tilt ?? 0);

    const featureIdRef = useRef(initial?.id ?? crypto.randomUUID());
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useImperativeHandle(ref, () => ({
      setPlane(plane: Plane) {
        setCustomBasePlane(plane);
        setBasePlane('Face');
        setOffset(0);
        setSpin(0);
        setTilt(0);
      },
    }));

    const constructionPlanes = getConstructionPlanes(features);
    const presetNames = Object.keys(PLANE_PRESETS);

    useEffect(() => {
      if (!onChangeRef.current) return;
      onChangeRef.current(buildFeature(featureIdRef.current, name, basePlane, customBasePlane, offset, spin, tilt, features));
    }, [name, basePlane, customBasePlane, offset, spin, tilt]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleSubmit = () => {
      onSubmit(buildFeature(featureIdRef.current, name, basePlane, customBasePlane, offset, spin, tilt, features));
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

    const halfInputStyle: React.CSSProperties = {
      ...inputStyle,
      width: 'calc(50% - 3px)',
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
          {initial ? 'Edit Plane' : 'Add Plane'}
        </div>

        <div style={{ fontSize: '11px', color: palette.textSecondary }}>
          Click a face to use it as the base plane, or choose a preset below.
        </div>

        <div>
          <div style={labelStyle}>Name</div>
          <input
            type="text"
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <div style={labelStyle}>Base plane</div>
          <select
            style={inputStyle}
            value={basePlane}
            onChange={(e) => {
              const v = e.target.value;
              setBasePlane(v);
              if (v !== 'Face') setCustomBasePlane(undefined);
            }}
          >
            {presetNames.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
            {constructionPlanes.map((cp) => (
              <option key={cp.id} value={`cp:${cp.id}`}>{cp.name}</option>
            ))}
            {customBasePlane && <option value="Face">Face</option>}
          </select>
        </div>

        <div>
          <div style={labelStyle}>Offset (mm)</div>
          <input
            type="number"
            style={inputStyle}
            value={offset}
            step={5}
            onChange={(e) => setOffset(parseFloat(e.target.value) || 0)}
          />
        </div>

        <div>
          <div style={labelStyle}>Rotation (degrees)</div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="number"
              style={halfInputStyle}
              value={spin}
              step={5}
              placeholder="Spin"
              title="Spin: rotate in-plane"
              onChange={(e) => setSpin(parseFloat(e.target.value) || 0)}
            />
            <input
              type="number"
              style={halfInputStyle}
              value={tilt}
              step={5}
              placeholder="Tilt"
              title="Tilt: tip forward/backward"
              onChange={(e) => setTilt(parseFloat(e.target.value) || 0)}
            />
          </div>
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
              background: palette.primaryBtn,
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              fontSize: '12px',
              cursor: 'pointer',
            }}
            onClick={handleSubmit}
          >
            {initial ? 'Update' : 'Apply'}
          </button>
        </div>
      </div>
    );
  },
);
