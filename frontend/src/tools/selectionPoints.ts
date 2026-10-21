import { useEditorStore } from '@/stores/editorStore';
import type { SelectedPoint } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';

/**
 * The two points a point relation (H/V between points) works on: two
 * selected points, or selected point entities and circles (their position,
 * their centre) making up two. null when the selection is anything else, so
 * H/V fall back to segments.
 */
export function resolveTwoPoints(): [SelectedPoint, SelectedPoint] | null {
  const es = useEditorStore.getState();
  const pts: SelectedPoint[] = [...es.selectedPoints];
  if (pts.length > 2) return null;
  if (pts.length < 2) {
    const sketch = useDocumentStore.getState().getActiveSketch();
    if (!sketch) return null;
    for (const id of es.selectedEntityIds) {
      if (pts.some((p) => p.entityId === id)) continue;
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
