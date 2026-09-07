import { useMemo } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { requestSave } from '@/api/autoSave';
import { NumberInput } from './NumberInput';
import type { Entity, DimensionEntity } from '@/types/document';
import { resolveDimensionEndpoints } from '@/utils/dimensionGeom';
import { computeAngleDimensionGeom } from '@/rendering/dimensionRenderer';
import { computeDerivedDimensionIds } from '@/utils/dof';
import { getSegmentCount, getSegmentPointIndices } from '@/utils/lineSegments';
import { clampCornerRadius } from '@/utils/rectPath';

interface PropertiesPanelProps {
  entity: Entity;
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  const palette = useThemeStore((s) => s.palette);
  return (
    <div style={{ marginBottom: '8px' }}>
      <div style={{ fontSize: '10px', color: palette.textMuted, marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
        {children}
      </div>
    </div>
  );
}

export function PropertiesPanel({ entity }: PropertiesPanelProps) {
  const palette = useThemeStore((s) => s.palette);
  const beginTransaction = useDocumentStore((s) => s.beginTransaction);
  const updateEntity = useDocumentStore((s) => s.updateEntity);
  const toggleConstruction = useDocumentStore((s) => s.toggleConstruction);
  const toggleReference = useDocumentStore((s) => s.toggleReference);
  const isFixed = useDocumentStore((s) => {
    const doc = s.document;
    const sketch = doc.sketches.find((sk) => sk.id === doc.activeSketchId);
    return sketch?.constraints.some((c) => c.type === 'fixed' && c.entityId === entity.id) ?? false;
  });
  const isHorizontal = useDocumentStore((s) => {
    const doc = s.document;
    const sketch = doc.sketches.find((sk) => sk.id === doc.activeSketchId);
    return sketch?.constraints.some((c) => c.type === 'horizontal' && c.entityId === entity.id) ?? false;
  });
  const isVertical = useDocumentStore((s) => {
    const doc = s.document;
    const sketch = doc.sketches.find((sk) => sk.id === doc.activeSketchId);
    return sketch?.constraints.some((c) => c.type === 'vertical' && c.entityId === entity.id) ?? false;
  });
  const isParallel = useDocumentStore((s) => {
    const doc = s.document;
    const sketch = doc.sketches.find((sk) => sk.id === doc.activeSketchId);
    return sketch?.constraints.some((c) => c.type === 'parallel' && (c.entityId === entity.id || c.targetEntityId === entity.id)) ?? false;
  });
  const isPerpendicular = useDocumentStore((s) => {
    const doc = s.document;
    const sketch = doc.sketches.find((sk) => sk.id === doc.activeSketchId);
    return sketch?.constraints.some((c) => c.type === 'perpendicular' && (c.entityId === entity.id || c.targetEntityId === entity.id)) ?? false;
  });
  const isTangent = useDocumentStore((s) => {
    const doc = s.document;
    const sketch = doc.sketches.find((sk) => sk.id === doc.activeSketchId);
    return sketch?.constraints.some((c) => c.type === 'tangent' && (c.entityId === entity.id || c.targetEntityId === entity.id)) ?? false;
  });
  const isMidpoint = useDocumentStore((s) => {
    const doc = s.document;
    const sketch = doc.sketches.find((sk) => sk.id === doc.activeSketchId);
    return sketch?.constraints.some((c) => c.type === 'midpoint' && (c.entityId === entity.id || c.targetEntityId === entity.id)) ?? false;
  });
  const isBisect = useDocumentStore((s) => {
    const doc = s.document;
    const sketch = doc.sketches.find((sk) => sk.id === doc.activeSketchId);
    return sketch?.constraints.some((c) => c.type === 'bisect' && (c.entityId === entity.id || c.targetEntityId === entity.id)) ?? false;
  });
  const constraintPartnersJson = useDocumentStore((s) => {
    const doc = s.document;
    const sketch = doc.sketches.find((sk) => sk.id === doc.activeSketchId);
    if (!sketch) return '[]';
    const results: { type: string; partnerId: string; partnerLabel: string }[] = [];
    for (const c of sketch.constraints) {
      if (c.type === 'fixed' || c.type === 'horizontal' || c.type === 'vertical') continue;
      let partnerId: string | null = null;
      if (c.entityId === entity.id) partnerId = c.targetEntityId;
      else if (c.targetEntityId === entity.id) partnerId = c.entityId;
      if (!partnerId) continue;
      const partner = sketch.entities.find((e) => e.id === partnerId);
      if (!partner) continue;
      const partnerLabel = partner.type === 'line' && 'polygonCenter' in partner && partner.polygonCenter
        ? 'Polygon'
        : partner.type.charAt(0).toUpperCase() + partner.type.slice(1);
      results.push({ type: c.type, partnerId, partnerLabel });
    }
    return JSON.stringify(results);
  });
  const constraintPartners: { type: string; partnerId: string; partnerLabel: string }[] = useMemo(
    () => JSON.parse(constraintPartnersJson),
    [constraintPartnersJson],
  );

  const isDerived = 'sourceId' in entity && !!entity.sourceId;

  const applyDimensionValue = useDocumentStore((s) => s.applyDimensionValue);
  const setDimensionExpression = useDocumentStore((s) => s.setDimensionExpression);

  const isDimensionDerived = useDocumentStore((s) => {
    if (entity.type !== 'dimension') return false;
    const doc = s.document;
    const sketch = doc.sketches.find((sk) => sk.id === doc.activeSketchId);
    if (!sketch) return false;
    return computeDerivedDimensionIds(sketch.entities, sketch.constraints).has(entity.id);
  });

  const dimensionValue = useDocumentStore((s) => {
    if (entity.type !== 'dimension') return null;
    const doc = s.document;
    const sketch = doc.sketches.find((sk) => sk.id === doc.activeSketchId);
    if (!sketch) return null;
    const dim = entity as DimensionEntity;

    // Angle dimension
    if (dim.angleMode && dim.targetEntityId2 != null) {
      const target = sketch.entities.find((e) => e.id === dim.targetEntityId);
      const target2 = sketch.entities.find((e) => e.id === dim.targetEntityId2);
      if (!target || !target2 || target.type !== 'line' || target2.type !== 'line') return null;
      const idx1 = dim.segmentIndex;
      const idx2 = dim.segmentIndex2!;
      if (idx1 < 0 || idx1 >= getSegmentCount(target)) return null;
      if (idx2 < 0 || idx2 >= getSegmentCount(target2)) return null;
      const [pi1, pi2] = getSegmentPointIndices(target, idx1);
      const [qi1, qi2] = getSegmentPointIndices(target2, idx2);
      const geom = computeAngleDimensionGeom(
        target.points[pi1]!, target.points[pi2]!,
        target2.points[qi1]!, target2.points[qi2]!,
        dim.offset,
      );
      if (!geom) return null;
      let sweep = geom.endAngle - geom.startAngle;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      return Math.abs(sweep) * 180 / Math.PI;
    }

    // Non-angle dimensions
    const endpoints = resolveDimensionEndpoints(dim, sketch.entities);
    if (!endpoints) return null;
    const { a, b } = endpoints;
    return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  });

  const update = (updated: Entity) => {
    beginTransaction('Edit property');
    updateEntity(entity.id, updated);
    requestSave();
  };

  const typeName = entity.type === 'line' && 'polygonCenter' in entity && entity.polygonCenter
    ? 'Polygon'
    : entity.type.charAt(0).toUpperCase() + entity.type.slice(1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 10px',
          borderBottom: `1px solid ${palette.border}`,
        }}
      >
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            color: palette.textMuted,
          }}
        >
          Properties
        </span>
      </div>

      {/* Content */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '11px', fontWeight: 600, color: palette.text }}>
            {typeName}
          </span>
        {isDerived && (
          <span style={{ fontSize: '10px', color: palette.warning, fontStyle: 'italic' }}>
            (Derived)
          </span>
        )}
        {isFixed && (
          <span style={{ fontSize: '10px', color: palette.constrained, fontStyle: 'italic' }}>
            (Fixed)
          </span>
        )}
        {isHorizontal && (
          <span style={{ fontSize: '10px', color: palette.constrained, fontStyle: 'italic' }}>
            (Horizontal)
          </span>
        )}
        {isVertical && (
          <span style={{ fontSize: '10px', color: palette.constrained, fontStyle: 'italic' }}>
            (Vertical)
          </span>
        )}
        {isParallel && !constraintPartners.some((cp) => cp.type === 'parallel') && (
          <span style={{ fontSize: '10px', color: palette.constrained, fontStyle: 'italic' }}>
            (Parallel)
          </span>
        )}
        {isPerpendicular && !constraintPartners.some((cp) => cp.type === 'perpendicular') && (
          <span style={{ fontSize: '10px', color: palette.constrained, fontStyle: 'italic' }}>
            (Perpendicular)
          </span>
        )}
        {isTangent && !constraintPartners.some((cp) => cp.type === 'tangent') && (
          <span style={{ fontSize: '10px', color: palette.constrained, fontStyle: 'italic' }}>
            (Tangent)
          </span>
        )}
        {isMidpoint && !constraintPartners.some((cp) => cp.type === 'midpoint') && (
          <span style={{ fontSize: '10px', color: palette.constrained, fontStyle: 'italic' }}>
            (Midpoint)
          </span>
        )}
        {isBisect && !constraintPartners.some((cp) => cp.type === 'bisect') && (
          <span style={{ fontSize: '10px', color: palette.constrained, fontStyle: 'italic' }}>
            (Bisect)
          </span>
        )}
        {constraintPartners.map((cp, i) => (
          <span
            key={i}
            style={{
              fontSize: '10px',
              color: palette.constraintLink,
              fontStyle: 'italic',
              cursor: 'pointer',
              textDecoration: 'underline',
              textDecorationStyle: 'dotted',
            }}
            onClick={() => {
              useEditorStore.getState().setSelectedEntityIds(new Set([cp.partnerId]));
            }}
          >
            ({cp.type.charAt(0).toUpperCase() + cp.type.slice(1)} → {cp.partnerLabel})
          </span>
        ))}
      </div>

      {entity.type === 'point' && (
        <FieldGroup label="Position">
          <NumberInput label="X" value={entity.position.x} disabled={isDerived} onChange={(x) => update({ ...entity, position: { ...entity.position, x } })} />
          <NumberInput label="Y" value={entity.position.y} disabled={isDerived} onChange={(y) => update({ ...entity, position: { ...entity.position, y } })} />
        </FieldGroup>
      )}

      {entity.type === 'circle' && (
        <>
          <FieldGroup label="Center">
            <NumberInput label="X" value={entity.center.x} disabled={isDerived} onChange={(x) => update({ ...entity, center: { ...entity.center, x } })} />
            <NumberInput label="Y" value={entity.center.y} disabled={isDerived} onChange={(y) => update({ ...entity, center: { ...entity.center, y } })} />
          </FieldGroup>
          <FieldGroup label="Diameter">
            <NumberInput value={entity.radius * 2} disabled={isDerived} onChange={(diameter) => update({ ...entity, radius: diameter / 2 })} />
          </FieldGroup>
        </>
      )}

      {entity.type === 'rectangle' && (
        <>
          <FieldGroup label="Center">
            <NumberInput label="X" value={entity.center.x} disabled={isDerived} onChange={(x) => update({ ...entity, center: { ...entity.center, x } })} />
            <NumberInput label="Y" value={entity.center.y} disabled={isDerived} onChange={(y) => update({ ...entity, center: { ...entity.center, y } })} />
          </FieldGroup>
          <FieldGroup label="Size">
            <NumberInput label="W" value={entity.width} disabled={isDerived} onChange={(width) => update({ ...entity, width })} />
            <NumberInput label="H" value={entity.height} disabled={isDerived} onChange={(height) => update({ ...entity, height })} />
          </FieldGroup>
          <FieldGroup label="Fillet">
            <NumberInput
              label="R"
              value={entity.cornerRadius ?? 0}
              disabled={isDerived}
              onChange={(r) => {
                const cornerRadius = clampCornerRadius(r, entity.width, entity.height);
                update({ ...entity, cornerRadius: cornerRadius > 0 ? cornerRadius : undefined });
              }}
            />
          </FieldGroup>
        </>
      )}

      {entity.type === 'line' && (
        <FieldGroup label={entity.polygonCenter ? 'Polygon Points' : 'Points'}>
          <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
            {entity.points.map((pt, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '4px' }}>
                <span style={{ fontSize: '10px', color: palette.textSecondary }}>P{i}</span>
                <NumberInput
                  label="X"
                  value={pt.x}
                  disabled={isDerived}
                  onChange={(x) => {
                    const newPoints = [...entity.points];
                    newPoints[i] = { ...pt, x };
                    update({ ...entity, points: newPoints });
                  }}
                />
                <NumberInput
                  label="Y"
                  value={pt.y}
                  disabled={isDerived}
                  onChange={(y) => {
                    const newPoints = [...entity.points];
                    newPoints[i] = { ...pt, y };
                    update({ ...entity, points: newPoints });
                  }}
                />
              </div>
            ))}
          </div>
        </FieldGroup>
      )}

      {entity.type === 'bezier' && (
        <FieldGroup label="Control Points">
          {(['P0 (start)', 'P1 (handle)', 'P2 (handle)', 'P3 (end)'] as const).map((label, i) => {
            const pt = entity.controlPoints[i]!;
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '4px' }}>
                <span style={{ fontSize: '10px', color: palette.textSecondary }}>{label}</span>
                <NumberInput
                  label="X"
                  value={pt.x}
                  disabled={isDerived}
                  onChange={(x) => {
                    const newCPs = [...entity.controlPoints] as [import('@/types/document').Point, import('@/types/document').Point, import('@/types/document').Point, import('@/types/document').Point];
                    newCPs[i] = { ...pt, x };
                    update({ ...entity, controlPoints: newCPs });
                  }}
                />
                <NumberInput
                  label="Y"
                  value={pt.y}
                  disabled={isDerived}
                  onChange={(y) => {
                    const newCPs = [...entity.controlPoints] as [import('@/types/document').Point, import('@/types/document').Point, import('@/types/document').Point, import('@/types/document').Point];
                    newCPs[i] = { ...pt, y };
                    update({ ...entity, controlPoints: newCPs });
                  }}
                />
              </div>
            );
          })}
        </FieldGroup>
      )}

      {entity.type === 'dimension' && (
        <>
          {dimensionValue != null && (
            <FieldGroup label={entity.angleMode ? 'Angle' : 'Value'}>
              {isDimensionDerived ? (
                <span style={{ fontSize: '12px', color: palette.text }}>
                  ({entity.angleMode ? `${dimensionValue.toFixed(1)}°` : dimensionValue.toFixed(2)})
                </span>
              ) : entity.expression ? (
                <span style={{ fontSize: '12px', color: palette.text }}>
                  {entity.angleMode ? `${dimensionValue.toFixed(1)}°` : dimensionValue.toFixed(2)}
                </span>
              ) : (
                <NumberInput
                  value={dimensionValue}
                  onChange={(v) => {
                    beginTransaction('Edit dimension');
                    applyDimensionValue(entity.id, v);
                    requestSave();
                  }}
                />
              )}
            </FieldGroup>
          )}
          {entity.expression && !isDimensionDerived && (
            <FieldGroup label="Expression">
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ fontSize: '12px', color: palette.text, fontFamily: 'monospace', flex: 1 }}>
                  {entity.expression}
                </span>
                <button
                  style={{
                    background: 'none',
                    border: `1px solid ${palette.inputBorder}`,
                    borderRadius: '2px',
                    color: palette.textMuted,
                    cursor: 'pointer',
                    fontSize: '10px',
                    padding: '1px 4px',
                  }}
                  onClick={() => {
                    beginTransaction('Clear expression');
                    setDimensionExpression(entity.id, undefined);
                    requestSave();
                  }}
                >
                  Clear
                </button>
              </div>
            </FieldGroup>
          )}
          <FieldGroup label="Offset">
            <NumberInput value={entity.offset} onChange={(offset) => update({ ...entity, offset })} />
          </FieldGroup>
          <FieldGroup label="Segment Index">
            <span style={{ fontSize: '12px', color: palette.text }}>{entity.segmentIndex}</span>
          </FieldGroup>
        </>
      )}

      {entity.type !== 'dimension' && (
        <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <input
            type="checkbox"
            checked={!!entity.construction}
            disabled={isDerived}
            onChange={() => {
              beginTransaction('Toggle construction');
              toggleConstruction([entity.id]);
              requestSave();
            }}
          />
          <span style={{ fontSize: '12px', color: palette.text }}>Construction</span>
        </div>
      )}

      {entity.type !== 'dimension' && (
        <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <input
            type="checkbox"
            checked={!!entity.reference}
            onChange={() => {
              toggleReference([entity.id]);
              requestSave();
            }}
          />
          <span
            style={{ fontSize: '12px', color: palette.text }}
            title="Datum/reference feature: kept and exported as normal geometry, but ignored when centring the sketch on the origin"
          >
            Reference (datum)
          </span>
        </div>
      )}

      {(entity.type === 'circle' || entity.type === 'rectangle' || (entity.type === 'line' && entity.closed)) && (
        <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <input
            type="checkbox"
            checked={!!entity.fill}
            disabled={isDerived}
            onChange={() => update({ ...entity, fill: !entity.fill })}
          />
          <span style={{ fontSize: '12px', color: palette.text }}>Fill</span>
        </div>
      )}
      </div>
    </div>
  );
}
