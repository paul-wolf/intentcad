import type { Tool, ToolContext } from './types';
import type { Entity, Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore, type ProjectSource } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { addLog } from '@/stores/logStore';
import { getStyles } from '@/rendering/styles';
import { renderEntity } from '@/rendering/pipeline';
import { getThemePalette } from '@/theme';
import { isProjected, isRef } from '@/utils/brokenRefs';
import { sameEdgeRef } from '@/build/edgePick';
import { edgeDistance } from '@/build/sketchRefs';
import { pickCandidate, projectCandidates, projectEdge, type ProjectCandidate } from '@/build/projectEdges';
import { requestSave } from '@/api/autoSave';

/** How near (screen px) the cursor must be to an edge to pick it. */
const PICK_PX = 8;

function activeEntities(): Entity[] {
  const doc = useDocumentStore.getState().document;
  return doc.sketches.find((s) => s.id === doc.activeSketchId)?.entities ?? [];
}

/** What a projection of `c` would duplicate in the sketch: an edge projected
 *  already, or (a face sketch) the face outline edge it lies on. */
function alreadyThere(c: ProjectCandidate, ent: Entity, entities: Entity[]): 'projected' | 'outline' | null {
  for (const e of entities) {
    if (!isRef(e)) continue;
    if (isProjected(e)) {
      const r = (e as { edgeRef?: Parameters<typeof sameEdgeRef>[0] }).edgeRef;
      if (r && c.edge.ref && sameEdgeRef(r, c.edge.ref)) return 'projected';
    } else if (edgeDistance(e, ent) < 1e-3) return 'outline';
  }
  return null;
}

/** Project part edge `c` into the active sketch as one undo step, saying
 *  what happened. */
export function applyProject(c: ProjectCandidate, source: ProjectSource): boolean {
  const ent = projectEdge(c.edge, source.plane);
  if (!ent) return false;
  const there = alreadyThere(c, ent, activeEntities());
  if (there) {
    addLog('info', there === 'projected' ? 'That edge is projected already' : "That edge is on the sketch's face outline already");
    return false;
  }
  const store = useDocumentStore.getState();
  store.beginTransaction('Project edge');
  store.addProjectedEdges([ent]);
  const what = c.edge.ref?.hint ?? `${c.edge.kind} edge`;
  addLog('info', `Projected ${what} onto the sketch as reference geometry; it follows the part when the part changes`);
  requestSave();
  return true;
}

export function createProjectTool(): Tool {
  let hover: ProjectCandidate | null = null;
  let cache: { source: ProjectSource; cands: ProjectCandidate[] } | null = null;

  const candidates = (): ProjectCandidate[] => {
    const source = useEditorStore.getState().projectSource;
    if (!source) return [];
    if (cache?.source !== source) cache = { source, cands: projectCandidates(source.edges, source.plane, source.clipped) };
    return cache.cands;
  };

  return {
    cursor: 'crosshair',

    onMouseDown(world: Point, _screen: Point, ctx: ToolContext) {
      const source = useEditorStore.getState().projectSource;
      if (!source) {
        addLog('warn', 'Project edges works when sketching on a part (a face or a plane in the 3D view)');
        return;
      }
      const c = pickCandidate(candidates(), world, PICK_PX / ctx.viewport.scale);
      if (c) applyProject(c, source);
    },

    onMouseMove(world: Point, _screen: Point, ctx: ToolContext) {
      hover = pickCandidate(candidates(), world, PICK_PX / ctx.viewport.scale);
    },

    onMouseUp() {},

    onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') useEditorStore.getState().setActiveTool('select');
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      const palette = getThemePalette();
      const styles = getStyles(palette);
      // every edge that can be projected, faintly (most lie behind the face)
      const faint = { color: palette.accent, width: 1, dash: [2, 3] };
      for (const c of candidates()) {
        for (let i = 0; i + 1 < c.pts.length; i++) {
          renderer.drawLine(viewport.worldToScreen(c.pts[i]!), viewport.worldToScreen(c.pts[i + 1]!), faint);
        }
      }
      const source = useEditorStore.getState().projectSource;
      if (!hover || !source) return;
      const ent = projectEdge(hover.edge, source.plane);
      if (ent) renderEntity(renderer, viewport, ent, { ...styles.preview, color: palette.accent, width: 3 }, false, true);
      const label = hover.edge.ref?.hint ?? `${hover.edge.kind} edge`;
      const at = viewport.worldToScreen(hover.pts[(hover.pts.length - 1) >> 1]!);
      renderer.drawText(label, { x: at.x + 8, y: at.y - 8 }, { color: palette.accent, fontSize: 12, textAlign: 'left', textBaseline: 'bottom' });
    },
  };
}
