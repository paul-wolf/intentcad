import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { api } from '@/api/client';
import { useThemeStore } from '@/theme';
import type { Document } from '@/types/document';
import type { ExtrudeFeature, ExtrudeDirection, Plane } from '@/types/part';
import { PLANE_PRESETS } from '@/types/part';
import { getExtrudableEntities } from '@/part/profileDetect';
import { rotatePlane, decomposePlaneAngles, closestPreset } from '@/part/planeRotation';

/** Compute yAxis = xAxis × normal (matches screen-Y-down convention in 2D sketch editor) */
function getYAxis(normal: [number, number, number], xAxis: [number, number, number]): [number, number, number] {
  return [
    xAxis[1] * normal[2] - xAxis[2] * normal[1],
    xAxis[2] * normal[0] - xAxis[0] * normal[2],
    xAxis[0] * normal[1] - xAxis[1] * normal[0],
  ];
}

/** Decompose a plane origin into (normalOffset, xOffset, yOffset) relative to a base plane. */
function decomposeOrigin(origin: [number, number, number], base: Plane): { normalOff: number; xOff: number; yOff: number } {
  const [ox, oy, oz] = origin;
  const [bx, by, bz] = base.origin;
  const dx = ox - bx, dy = oy - by, dz = oz - bz;
  const n = base.normal, x = base.xAxis;
  const y = getYAxis(n, x);
  return {
    normalOff: dx * n[0] + dy * n[1] + dz * n[2],
    xOff: dx * x[0] + dy * x[1] + dz * x[2],
    yOff: dx * y[0] + dy * y[1] + dz * y[2],
  };
}

/** Build plane origin from base + three offsets. */
function buildPlaneOrigin(base: Plane, normalOff: number, xOff: number, yOff: number): [number, number, number] {
  const n = base.normal, x = base.xAxis;
  const y = getYAxis(n, x);
  return [
    base.origin[0] + n[0] * normalOff + x[0] * xOff + y[0] * yOff,
    base.origin[1] + n[1] * normalOff + x[1] * xOff + y[1] * yOff,
    base.origin[2] + n[2] * normalOff + x[2] * xOff + y[2] * yOff,
  ];
}

function buildFeature(
  documentId: string,
  initialId: string | undefined,
  selectedSketchId: string,
  planePreset: string,
  customPlane: Plane | null,
  planeOffset: number,
  originX: number,
  originY: number,
  spin: number,
  tilt: number,
  distance: number,
  direction: ExtrudeDirection,
  operation: 'add' | 'remove',
): ExtrudeFeature {
  const basePlane = (planePreset === 'Face' && customPlane)
    ? customPlane
    : (PLANE_PRESETS[planePreset] ?? PLANE_PRESETS[Object.keys(PLANE_PRESETS)[0]!]!);
  const { normal, xAxis } = rotatePlane(basePlane, spin, tilt);
  const plane: Plane = {
    origin: buildPlaneOrigin(basePlane, planeOffset, originX, originY),
    normal,
    xAxis,
  };
  return {
    id: initialId ?? crypto.randomUUID(),
    type: 'extrude',
    sketchDocumentId: documentId,
    sketchId: selectedSketchId,
    plane,
    distance,
    direction,
    operation,
  };
}

export interface ExtrudeFormHandle {
  setDistance(v: number): void;
  setDirection(d: ExtrudeDirection): void;
  setOperation(op: 'add' | 'remove'): void;
  setPlane(plane: Plane): void;
}

interface ExtrudeFormProps {
  documentId: string;
  initial?: ExtrudeFeature;
  defaultSketchId?: string;
  sketchDoc?: Document;
  onSubmit: (feature: ExtrudeFeature) => void;
  onCancel: () => void;
  onChange?: (feature: ExtrudeFeature) => void;
}

export const ExtrudeForm = forwardRef<ExtrudeFormHandle, ExtrudeFormProps>(function ExtrudeForm({ documentId, initial, defaultSketchId, sketchDoc: externalSketchDoc, onSubmit, onCancel, onChange }, ref) {
  const palette = useThemeStore((s) => s.palette);

  const [internalSketchDoc, setInternalSketchDoc] = useState<Document | null>(null);
  const sketchDoc = externalSketchDoc ?? internalSketchDoc;
  const [selectedSketchId, setSelectedSketchId] = useState(initial?.sketchId ?? defaultSketchId ?? '');
  const [distance, setDistance] = useState(Math.abs(initial?.distance ?? 20));
  const [direction, setDirection] = useState<ExtrudeDirection>(initial?.direction ?? 'forward');
  const [operation, setOperation] = useState<'add' | 'remove'>(initial?.operation ?? 'add');

  const [customPlane, setCustomPlane] = useState<Plane | null>(null);

  // Stable ID ref for new features
  const featureIdRef = useRef(initial?.id ?? crypto.randomUUID());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    setDistance(v: number) { setDistance(v); },
    setDirection(d: ExtrudeDirection) { setDirection(d); },
    setOperation(op: 'add' | 'remove') { setOperation(op); },
    setPlane(plane: Plane) {
      setCustomPlane(plane);
      setPlanePreset('Face');
      setSpin(0);
      setTilt(0);
      setPlaneOffset(0);
      setOriginX(0);
      setOriginY(0);
    },
  }));

  // Plane controls
  const presetNames = Object.keys(PLANE_PRESETS);
  const [planePreset, setPlanePreset] = useState(() => {
    if (!initial) return presetNames[0]!;
    return closestPreset(initial.plane.normal, PLANE_PRESETS);
  });

  // Recover spin/tilt from stored plane
  const [spin, setSpin] = useState(() => {
    if (!initial) return 0;
    const base = PLANE_PRESETS[closestPreset(initial.plane.normal, PLANE_PRESETS)]!;
    return decomposePlaneAngles(initial.plane, base).spinDeg;
  });
  const [tilt, setTilt] = useState(() => {
    if (!initial) return 0;
    const base = PLANE_PRESETS[closestPreset(initial.plane.normal, PLANE_PRESETS)]!;
    return decomposePlaneAngles(initial.plane, base).tiltDeg;
  });

  // Decompose initial plane origin into three offsets
  const [planeOffset, setPlaneOffset] = useState(() => {
    if (!initial) return 0;
    const base = PLANE_PRESETS[closestPreset(initial.plane.normal, PLANE_PRESETS)]!;
    return decomposeOrigin(initial.plane.origin, base).normalOff;
  });
  const [originX, setOriginX] = useState(() => {
    if (!initial) return 0;
    const base = PLANE_PRESETS[closestPreset(initial.plane.normal, PLANE_PRESETS)]!;
    return decomposeOrigin(initial.plane.origin, base).xOff;
  });
  const [originY, setOriginY] = useState(() => {
    if (!initial) return 0;
    const base = PLANE_PRESETS[closestPreset(initial.plane.normal, PLANE_PRESETS)]!;
    return decomposeOrigin(initial.plane.origin, base).yOff;
  });

  // Load the document (only if not provided externally)
  useEffect(() => {
    if (externalSketchDoc || !documentId) return;
    api.getDocument(documentId)
      .then((full) => {
        setInternalSketchDoc(full.data as unknown as Document);
      })
      .catch(() => setInternalSketchDoc(null));
  }, [documentId, externalSketchDoc]);

  // Auto-select sketch when doc loads (prefer last sketch)
  useEffect(() => {
    if (sketchDoc && !selectedSketchId && sketchDoc.sketches.length > 0) {
      setSelectedSketchId(sketchDoc.sketches[sketchDoc.sketches.length - 1]!.id);
    }
  }, [sketchDoc, selectedSketchId]);

  const sketch = sketchDoc?.sketches.find((s) => s.id === selectedSketchId);
  const hasExtrudable = sketch ? getExtrudableEntities(sketch).length > 0 : false;

  const canSubmit = selectedSketchId && hasExtrudable && distance > 0;

  // Fire onChange whenever parameters change
  useEffect(() => {
    if (!onChangeRef.current || !selectedSketchId) return;
    const feature = buildFeature(documentId, featureIdRef.current, selectedSketchId, planePreset, customPlane, planeOffset, originX, originY, spin, tilt, distance, direction, operation);
    onChangeRef.current(feature);
  }, [documentId, selectedSketchId, planePreset, customPlane, planeOffset, originX, originY, spin, tilt, distance, direction, operation]);

  const handleSubmit = () => {
    if (!canSubmit) return;
    const feature = buildFeature(documentId, featureIdRef.current, selectedSketchId, planePreset, customPlane, planeOffset, originX, originY, spin, tilt, distance, direction, operation);
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
        {initial ? 'Edit Extrude' : 'Add Extrude'}
      </div>

      {sketchDoc && (
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
        <div style={{ fontSize: '11px', color: palette.danger }}>
          No extrudable profiles found (need a rectangle, circle, or closed polygon).
        </div>
      )}

      <div>
        <div style={labelStyle}>Plane</div>
        <select
          style={inputStyle}
          value={planePreset}
          onChange={(e) => {
            const v = e.target.value;
            setPlanePreset(v);
            if (v !== 'Face') setCustomPlane(null);
          }}
        >
          {presetNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
          {customPlane && <option value="Face">Face</option>}
        </select>
      </div>

      <div>
        <div style={labelStyle}>Plane rotation (degrees)</div>
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

      <div>
        <div style={labelStyle}>Depth offset (mm)</div>
        <input
          type="number"
          style={inputStyle}
          value={planeOffset}
          step={1}
          onChange={(e) => setPlaneOffset(parseFloat(e.target.value) || 0)}
        />
      </div>

      <div>
        <div style={labelStyle}>Origin offset (mm)</div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            type="number"
            style={halfInputStyle}
            value={originX}
            step={1}
            placeholder="X"
            title="X offset on plane"
            onChange={(e) => setOriginX(parseFloat(e.target.value) || 0)}
          />
          <input
            type="number"
            style={halfInputStyle}
            value={originY}
            step={1}
            placeholder="Y"
            title="Y offset on plane"
            onChange={(e) => setOriginY(parseFloat(e.target.value) || 0)}
          />
        </div>
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
        <div style={labelStyle}>Direction</div>
        <select
          style={inputStyle}
          value={direction}
          onChange={(e) => setDirection(e.target.value as ExtrudeDirection)}
        >
          <option value="forward">Forward</option>
          <option value="reverse">Reverse</option>
          <option value="both">Both (symmetric)</option>
        </select>
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
});
