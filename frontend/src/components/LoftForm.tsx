import { useState, useEffect, useRef } from 'react';
import { api } from '@/api/client';
import { useThemeStore } from '@/theme';
import type { Document } from '@/types/document';
import type { LoftFeature, Plane } from '@/types/part';
import { PLANE_PRESETS, planeWithOffset } from '@/types/part';

interface SectionState {
  sketchDocumentId: string;
  sketchId: string;
  planePreset: string;
  planeOffset: number;
}

function buildFeature(
  initialId: string,
  sections: SectionState[],
  operation: 'add' | 'remove',
): LoftFeature {
  return {
    id: initialId,
    type: 'loft',
    sections: sections.map((s) => {
      const basePlane = PLANE_PRESETS[s.planePreset] ?? PLANE_PRESETS[Object.keys(PLANE_PRESETS)[0]!]!;
      const plane: Plane = planeWithOffset(basePlane, s.planeOffset);
      return {
        sketchDocumentId: s.sketchDocumentId,
        sketchId: s.sketchId,
        plane,
      };
    }),
    operation,
  };
}

/** Find the closest preset name for a given plane (by normal match). */
function closestPresetForPlane(plane: Plane): string {
  const presetNames = Object.keys(PLANE_PRESETS);
  let best = presetNames[0]!;
  let bestDot = -Infinity;
  for (const name of presetNames) {
    const p = PLANE_PRESETS[name]!;
    const dot = p.normal[0] * plane.normal[0] + p.normal[1] * plane.normal[1] + p.normal[2] * plane.normal[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = name;
    }
  }
  return best;
}

/** Compute depth offset of a plane origin along the preset normal. */
function computeOffset(plane: Plane, presetName: string): number {
  const base = PLANE_PRESETS[presetName];
  if (!base) return 0;
  const o = plane.origin;
  const n = base.normal;
  return o[0] * n[0] + o[1] * n[1] + o[2] * n[2];
}

interface LoftFormProps {
  documentId: string;
  initial?: LoftFeature;
  onSubmit: (feature: LoftFeature) => void;
  onCancel: () => void;
  onChange?: (feature: LoftFeature) => void;
}

export function LoftForm({ documentId, initial, onSubmit, onCancel, onChange }: LoftFormProps) {
  const palette = useThemeStore((s) => s.palette);
  const presetNames = Object.keys(PLANE_PRESETS);

  const featureIdRef = useRef(initial?.id ?? crypto.randomUUID());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [sections, setSections] = useState<SectionState[]>(() => {
    if (initial) {
      return initial.sections.map((s) => {
        const preset = closestPresetForPlane(s.plane);
        return {
          sketchDocumentId: s.sketchDocumentId,
          sketchId: s.sketchId,
          planePreset: preset,
          planeOffset: computeOffset(s.plane, preset),
        };
      });
    }
    return [
      { sketchDocumentId: documentId, sketchId: '', planePreset: presetNames[0]!, planeOffset: 0 },
      { sketchDocumentId: documentId, sketchId: '', planePreset: presetNames[0]!, planeOffset: 20 },
    ];
  });

  const [operation, setOperation] = useState<'add' | 'remove'>(initial?.operation ?? 'add');

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
    const feature = buildFeature(featureIdRef.current, sections, operation);
    onChangeRef.current(feature);
  }, [sections, operation]);

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(buildFeature(featureIdRef.current, sections, operation));
  };

  const updateSection = (index: number, patch: Partial<SectionState>) => {
    setSections((prev) => prev.map((s, i) => i === index ? { ...s, ...patch } : s));
  };

  const addSection = () => {
    const lastOffset = sections.length > 0 ? sections[sections.length - 1]!.planeOffset : 0;
    setSections((prev) => [
      ...prev,
      { sketchDocumentId: documentId, sketchId: '', planePreset: presetNames[0]!, planeOffset: lastOffset + 20 },
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
        return (
          <div
            key={i}
            style={{
              border: `1px solid ${palette.border}`,
              borderRadius: '4px',
              padding: '6px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: palette.text }}>
                Section {i + 1}
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
              </select>
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
}
