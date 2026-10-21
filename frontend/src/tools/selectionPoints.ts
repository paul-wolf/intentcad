import { useEditorStore } from '@/stores/editorStore';
import type { SelectedPoint } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { addLog } from '@/stores/logStore';

/**
 * The two points a point relation (H/V between points) works on: two
 * selected points, or selected point entities and circles (their position,
 * their centre) making up two. null when the selection is anything else, so
 * H/V fall back to segments.
 */
export function resolveTwoPoints(besides: Set<string> = new Set()): [SelectedPoint, SelectedPoint] | null {
  const es = useEditorStore.getState();
  const pts: SelectedPoint[] = [...es.selectedPoints];
  if (pts.length > 2) return null;
  if (pts.length < 2) {
    const sketch = useDocumentStore.getState().getActiveSketch();
    if (!sketch) return null;
    for (const id of es.selectedEntityIds) {
      if (besides.has(id) || pts.some((p) => p.entityId === id)) continue;
      const e = sketch.entities.find((x) => x.id === id);
      if (!e || (e.type !== 'point' && e.type !== 'circle')) return null;
      pts.push({ entityId: id, pointIndex: 0 });
    }
  }
  return pts.length === 2 ? [pts[0]!, pts[1]!] : null;
}

/** H or V on the selection: between two points (resolveTwoPoints) if it is
 *  two points, else on segments. False when there's nothing to apply it to. */
export function applyHV(type: 'horizontal' | 'vertical'): boolean {
  const ds = useDocumentStore.getState();
  const label = type === 'horizontal' ? 'Toggle horizontal' : 'Toggle vertical';
  const two = resolveTwoPoints();
  if (two) {
    ds.beginTransaction(label);
    ds.togglePointsHV(type, two[0], two[1]);
    return true;
  }
  const es = useEditorStore.getState();
  const ids = es.selectedEntityIds;
  if (ids.size === 0) return false;
  const segs = es.selectedSegments.length > 0
    ? es.selectedSegments.map((s) => ({ entityId: s.entityId, segmentIndex: s.segmentIndex }))
    : undefined;
  ds.beginTransaction(label);
  if (type === 'horizontal') ds.toggleHorizontal([...ids], segs);
  else ds.toggleVertical([...ids], segs);
  return true;
}

export interface CurveRef { entityId: string; segmentIndex: number }

/**
 * A point and a curve for "point on curve": a selected point (or a point
 * entity, or a circle's centre) and one selected segment, or a selected
 * circle (segmentIndex -1). null when the selection is anything else.
 */
export function resolvePointAndCurve(): [SelectedPoint, CurveRef] | null {
  const es = useEditorStore.getState();
  const sketch = useDocumentStore.getState().getActiveSketch();
  if (!sketch) return null;
  const byId = (id: string) => sketch.entities.find((e) => e.id === id);
  const segs = es.selectedSegments;
  if (segs.length > 1) return null;
  const pts: SelectedPoint[] = [...es.selectedPoints];
  let others = [...es.selectedEntityIds].filter((id) => !segs.some((sg) => sg.entityId === id) && !pts.some((p) => p.entityId === id));
  let curve: CurveRef | null = segs[0] ? { entityId: segs[0].entityId, segmentIndex: segs[0].segmentIndex } : null;
  if (!curve) {
    // the curve is a selected circle: with a selected point, or a point entity
    const circles = others.filter((id) => byId(id)?.type === 'circle');
    if (circles.length !== 1 || pts.length + others.length !== 2) return null;
    curve = { entityId: circles[0]!, segmentIndex: -1 };
    others = others.filter((id) => id !== circles[0]);
  }
  for (const id of others) {
    const t = byId(id)?.type;
    if (t !== 'point' && t !== 'circle') return null;
    pts.push({ entityId: id, pointIndex: 0 });
  }
  return pts.length === 1 ? [pts[0]!, curve] : null;
}

/** Point on curve on the selection (resolvePointAndCurve). False when the
 *  selection isn't a point and a curve. */
export function applyPointOnCurve(): boolean {
  const pc = resolvePointAndCurve();
  if (!pc) {
    addLog('warn', 'Point on curve: select a point, then a line, an arc or a circle (Shift-click)');
    return false;
  }
  const ds = useDocumentStore.getState();
  ds.beginTransaction('Toggle point on curve');
  ds.togglePointOnCurve(pc[0], pc[1]);
  return true;
}

/** Symmetric on the selection: two points (resolveTwoPoints) and one line
 *  segment to mirror them about. False when the selection is anything else. */
export function applySymmetric(): boolean {
  const es = useEditorStore.getState();
  const segs = es.selectedSegments;
  const two = segs.length === 1 ? resolveTwoPoints(new Set([segs[0]!.entityId])) : null;
  if (!two) {
    addLog('warn', 'Symmetric: select two points, then the line to mirror them about (Shift-click)');
    return false;
  }
  const ds = useDocumentStore.getState();
  ds.beginTransaction('Toggle symmetric');
  ds.toggleSymmetric(two[0], two[1], { entityId: segs[0]!.entityId, segmentIndex: segs[0]!.segmentIndex });
  return true;
}
