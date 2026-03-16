import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { api } from '@/api/client';
import { useThemeStore } from '@/theme';
import type { Document } from '@/types/document';
import type { LoftFeature, Plane, Feature } from '@/types/part';
import { PLANE_PRESETS, getConstructionPlanes } from '@/types/part';
import { rotatePlane, decomposePlaneAngles, closestPreset } from '@/part/planeRotation';

interface SectionState {
  sketchDocumentId: string;
  sketchId: string;
  planePreset: string;
  planeOffset: number;
  spin: number;
  tilt: number;
  originX: number;
  originY: number;
}

/** Compute yAxis = xAxis × normal */
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

function resolveBasePlane(planePreset: string, features?: Feature[]): Plane {
  if (planePreset.startsWith('cp:') && features) {
    const cpId = planePreset.slice(3);
    const cp = getConstructionPlanes(features).find((c) => c.id === cpId);
    if (cp) return cp.plane;
  }
  return PLANE_PRESETS[planePreset] ?? PLANE_PRESETS[Object.keys(PLANE_PRESETS)[0]!]!;
}

function buildFeature(
  initialId: string,
  sections: SectionState[],
  operation: 'add' | 'remove',
  features?: Feature[],
): LoftFeature {
  return {
    id: initialId,
    type: 'loft',
    sections: sections.map((s) => {
      const basePlane = resolveBasePlane(s.planePreset, features);
      const { normal, xAxis } = rotatePlane(basePlane, s.spin, s.tilt);
      const plane: Plane = {
        origin: buildPlaneOrigin(basePlane, s.planeOffset, s.originX, s.originY),
        normal,
        xAxis,
      };
      return {
        sketchDocumentId: s.sketchDocumentId,
        sketchId: s.sketchId,
        plane,
      };
    }),
    operation,
  };
}

export interface LoftFormHandle {
  setPlane(plane: Plane): void;
  setOffset(v: number): void;
  setOriginX(v: number): void;
  setOriginY(v: number): void;
  setSpin(v: number): void;
  setTilt(v: number): void;
  getActiveSection(): {
    basePlane: Plane;
    offset: number;
    originX: number;
    originY: number;
    spin: number;
    tilt: number;
  } | null;
}

interface LoftFormProps {
  documentId: string;
  initial?: LoftFeature;
  features?: Feature[];
  onSubmit: (feature: LoftFeature) => void;
  onCancel: () => void;
  onChange?: (feature: LoftFeature) => void;
  onActiveSectionChange?: (index: number) => void;
}

export const LoftForm = forwardRef<LoftFormHandle, LoftFormProps>(function LoftForm({ documentId, initial, features: featuresProp, onSubmit, onCancel, onChange, onActiveSectionChange }, ref) {
  const palette = useThemeStore((s) => s.palette);
  const constructionPlanes = featuresProp ? getConstructionPlanes(featuresProp) : [];
  const presetNames = Object.keys(PLANE_PRESETS);

  const featureIdRef = useRef(initial?.id ?? crypto.randomUUID());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [activeSectionIndex, setActiveSectionIndex] = useState(1); // Default to second section

  const onActiveSectionChangeRef = useRef(onActiveSectionChange);
  onActiveSectionChangeRef.current = onActiveSectionChange;

  const [sections, setSections] = useState<SectionState[]>(() => {
    if (initial) {
      return initial.sections.map((s) => {
        const preset = closestPreset(s.plane.normal, PLANE_PRESETS);
        const base = PLANE_PRESETS[preset]!;
        const angles = decomposePlaneAngles(s.plane, base);
        const origin = decomposeOrigin(s.plane.origin, base);
        return {
          sketchDocumentId: s.sketchDocumentId,
          sketchId: s.sketchId,
          planePreset: preset,
          planeOffset: origin.normalOff,
          spin: angles.spinDeg,
          tilt: angles.tiltDeg,
          originX: origin.xOff,
          originY: origin.yOff,
        };
      });
    }
    return [
      { sketchDocumentId: documentId, sketchId: '', planePreset: presetNames[0]!, planeOffset: 0, spin: 0, tilt: 0, originX: 0, originY: 0 },
      { sketchDocumentId: documentId, sketchId: '', planePreset: presetNames[0]!, planeOffset: 20, spin: 0, tilt: 0, originX: 0, originY: 0 },
    ];
  });

  const [operation, setOperation] = useState<'add' | 'remove'>(initial?.operation ?? 'add');

  useImperativeHandle(ref, () => ({
    setPlane(plane: Plane) {
      const preset = closestPreset(plane.normal, PLANE_PRESETS);
      const base = PLANE_PRESETS[preset]!;
      const angles = decomposePlaneAngles(plane, base);
      const origin = decomposeOrigin(plane.origin, base);
      setSections((prev) => prev.map((s, i) => i === activeSectionIndex ? {
        ...s,
        planePreset: preset,
        planeOffset: origin.normalOff,
        spin: angles.spinDeg,
        tilt: angles.tiltDeg,
        originX: origin.xOff,
        originY: origin.yOff,
      } : s));
    },
    setOffset(v: number) {
      setSections((prev) => prev.map((s, i) => i === activeSectionIndex ? { ...s, planeOffset: v } : s));
    },
    setOriginX(v: number) {
      setSections((prev) => prev.map((s, i) => i === activeSectionIndex ? { ...s, originX: v } : s));
    },
    setOriginY(v: number) {
      setSections((prev) => prev.map((s, i) => i === activeSectionIndex ? { ...s, originY: v } : s));
    },
    setSpin(v: number) {
      setSections((prev) => prev.map((s, i) => i === activeSectionIndex ? { ...s, spin: v } : s));
    },
    setTilt(v: number) {
      setSections((prev) => prev.map((s, i) => i === activeSectionIndex ? { ...s, tilt: v } : s));
    },
    getActiveSection() {
      const sec = sections[activeSectionIndex];
      if (!sec) return null;
      const basePlane = PLANE_PRESETS[sec.planePreset] ?? PLANE_PRESETS[Object.keys(PLANE_PRESETS)[0]!]!;
      return {
        basePlane,
        offset: sec.planeOffset,
        originX: sec.originX,
        originY: sec.originY,
        spin: sec.spin,
        tilt: sec.tilt,
      };
    },
  }), [activeSectionIndex, sections]);

  // Notify parent when active section changes
  useEffect(() => {
    onActiveSectionChangeRef.current?.(activeSectionIndex);
  }, [activeSectionIndex]);

  // Per-section sketch docs
  const [sectionDocs, setSectionDocs] = useState<Map<string, Document>>(new Map());

  // Load sketch docs for all unique docIds
  useEffect(() => {
    const docIds = [...new Set(sections.map((s) => s.sketchDocumentId).filter(Boolean))];
    let cancelled = false;
    Promise.all(
      docIds.map((docId) =>
        api.getDocument(docId)
          .then((full) => [docId, full.data as unknown as Document] as const)
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const map = new Map<string, Document>();
      for (const r of results) {
        if (r) map.set(r[0], r[1]);
      }
      setSectionDocs(map);
    });
    return () => { cancelled = true; };
  }, [sections.map((s) => s.sketchDocumentId).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select sketch when doc loads
  useEffect(() => {
    setSections((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        if (s.sketchId) return s;
        const doc = sectionDocs.get(s.sketchDocumentId);
        if (doc && doc.sketches.length > 0) {
          changed = true;
          return { ...s, sketchId: doc.sketches[doc.sketches.length - 1]!.id };
        }
        return s;
      });
      return changed ? next : prev;
    });
  }, [sectionDocs]);

  const canSubmit = sections.length >= 2 && sections.every((s) => s.sketchId);

  // Fire onChange
  useEffect(() => {
    if (!onChangeRef.current) return;
    const feature = buildFeature(featureIdRef.current, sections, operation, featuresProp);
    onChangeRef.current(feature);
  }, [sections, operation]);

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(buildFeature(featureIdRef.current, sections, operation, featuresProp));
  };

  const updateSection = (index: number, patch: Partial<SectionState>) => {
    setSections((prev) => prev.map((s, i) => i === index ? { ...s, ...patch } : s));
  };

  const addSection = () => {
    const lastOffset = sections.length > 0 ? sections[sections.length - 1]!.planeOffset : 0;
    setSections((prev) => [
      ...prev,
      { sketchDocumentId: documentId, sketchId: '', planePreset: presetNames[0]!, planeOffset: lastOffset + 20, spin: 0, tilt: 0, originX: 0, originY: 0 },
    ]);
  };

  const removeSection = (index: number) => {
    if (sections.length <= 2) return;
    setSections((prev) => prev.filter((_, i) => i !== index));
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
        {initial ? 'Edit Loft' : 'Add Loft'}
      </div>

      {sections.map((sec, i) => {
        const doc = sectionDocs.get(sec.sketchDocumentId);
        const isActive = i === activeSectionIndex;
        return (
          <div
            key={i}
            style={{
              border: `1px solid ${isActive ? palette.primaryBtn : palette.border}`,
              borderRadius: '4px',
              padding: '6px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              cursor: 'pointer',
            }}
            onClick={() => setActiveSectionIndex(i)}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: isActive ? palette.primaryBtn : palette.text }}>
                Section {i + 1}{isActive ? ' — click face to set plane' : ''}
              </span>
              {sections.length > 2 && (
                <button
                  style={{
                    background: 'none',
                    border: 'none',
                    color: palette.danger,
                    cursor: 'pointer',
                    fontSize: '12px',
                    padding: '0 2px',
                  }}
                  onClick={() => removeSection(i)}
                >
                  x
                </button>
              )}
            </div>

            {doc && (
              <div>
                <div style={labelStyle}>Sketch</div>
                <select
                  style={inputStyle}
                  value={sec.sketchId}
                  onChange={(e) => updateSection(i, { sketchId: e.target.value })}
                >
                  <option value="">-- Select --</option>
                  {doc.sketches.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <div style={labelStyle}>Plane</div>
              <select
                style={inputStyle}
                value={sec.planePreset}
                onChange={(e) => updateSection(i, { planePreset: e.target.value })}
              >
                {presetNames.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
                {constructionPlanes.map((cp) => (
                  <option key={cp.id} value={`cp:${cp.id}`}>{cp.name}</option>
                ))}
              </select>
            </div>

            <div>
              <div style={labelStyle}>Plane rotation (degrees)</div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="number"
                  style={halfInputStyle}
                  value={sec.spin}
                  step={5}
                  placeholder="Spin"
                  title="Spin: rotate in-plane"
                  onChange={(e) => updateSection(i, { spin: parseFloat(e.target.value) || 0 })}
                />
                <input
                  type="number"
                  style={halfInputStyle}
                  value={sec.tilt}
                  step={5}
                  placeholder="Tilt"
                  title="Tilt: tip forward/backward"
                  onChange={(e) => updateSection(i, { tilt: parseFloat(e.target.value) || 0 })}
                />
              </div>
            </div>

            <div>
              <div style={labelStyle}>Depth offset (mm)</div>
              <input
                type="number"
                style={inputStyle}
                value={sec.planeOffset}
                step={1}
                onChange={(e) => updateSection(i, { planeOffset: parseFloat(e.target.value) || 0 })}
              />
            </div>

            <div>
              <div style={labelStyle}>Origin offset (mm)</div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="number"
                  style={halfInputStyle}
                  value={sec.originX}
                  step={1}
                  placeholder="X"
                  title="X offset on plane"
                  onChange={(e) => updateSection(i, { originX: parseFloat(e.target.value) || 0 })}
                />
                <input
                  type="number"
                  style={halfInputStyle}
                  value={sec.originY}
                  step={1}
                  placeholder="Y"
                  title="Y offset on plane"
                  onChange={(e) => updateSection(i, { originY: parseFloat(e.target.value) || 0 })}
                />
              </div>
            </div>
          </div>
        );
      })}

      <button
        style={{
          padding: '4px 8px',
          background: palette.buttonBg,
          color: palette.text,
          border: `1px solid ${palette.border}`,
          borderRadius: '4px',
          fontSize: '12px',
          cursor: 'pointer',
        }}
        onClick={addSection}
      >
        + Add Section
      </button>

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
