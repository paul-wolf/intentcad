import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { patternToEdit } from '@/utils/copyPattern';
import type { CopyPattern } from '@/types/document';

/** Reopens a grid or circular copy with its settings, on its originals. */
export function editPattern(p: CopyPattern) {
  const es = useEditorStore.getState();
  if (es.activeTool !== 'select') es.setActiveTool('select');
  es.setSelectedEntityIds(new Set(p.sourceIds));   // what gets copied
  if (p.kind === 'grid') es.setGridCopyEntityIds(p.sourceIds, p.id);
  else es.setCircularCopyEntityIds(p.sourceIds, p.id);
}

/** Grid or circular copy of the selection (G / A). A selection that is
 *  already such a copy, or its original, reopens that copy instead of
 *  laying a second one over it. */
export function openCopyDialog(kind: CopyPattern['kind']) {
  const es = useEditorStore.getState();
  const ids = [...es.selectedEntityIds];
  if (ids.length === 0) return;
  const { document } = useDocumentStore.getState();
  const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
  const existing = sketch && patternToEdit(sketch.patterns, sketch.entities, ids, kind);
  if (existing) return editPattern(existing);
  if (es.activeTool !== 'select') es.setActiveTool('select');
  if (kind === 'grid') es.setGridCopyEntityIds(ids);
  else es.setCircularCopyEntityIds(ids);
}
