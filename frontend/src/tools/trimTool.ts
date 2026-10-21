import type { Tool, ToolContext } from './types';
import type { Entity, Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { addLog } from '@/stores/logStore';
import { getStyles } from '@/rendering/styles';
import { renderEntity } from '@/rendering/pipeline';
import { getThemePalette } from '@/theme';
import { hitTrim, trimPreview, type TrimHit } from '@/utils/trim';
import { requestSave } from '@/api/autoSave';

/** How near (screen px) the cursor must be to a curve to trim it. */
const PICK_PX = 8;
/** Drag path sampling (screen px), so a quick swipe doesn't skip a piece. */
const STEP_PX = 4;

const TRIM_COLOR = '#e5484d';

function activeEntities(): Entity[] {
  const doc = useDocumentStore.getState().document;
  return doc.sketches.find((s) => s.id === doc.activeSketchId)?.entities ?? [];
}

/** Trim the pieces at `points` (each a point on the curve, as hitTrim gave
 *  it) as one undo step, saying what happened. */
export function applyTrims(points: Point[], tolWorld: number): number {
  if (!points.length) return 0;
  const store = useDocumentStore.getState();
  store.beginTransaction(points.length === 1 ? 'Trim' : `Trim ${points.length} pieces`);
  let trimmed = 0, dropped = 0;
  for (const p of points) {
    // looked up again: an earlier trim in the same swipe renumbers things
    const hit = hitTrim(activeEntities(), p, tolWorld);
    if (!hit) continue;
    const out = store.trimPiece(hit.entityId, hit.s);
    if (!out) continue;
    trimmed++;
    dropped += out.dropped;
  }
  if (!trimmed) return 0;
  addLog('info', `Trimmed ${trimmed} piece${trimmed === 1 ? '' : 's'}`
    + (dropped ? `; dropped ${dropped} constraint${dropped === 1 ? '' : 's'} / dimension${dropped === 1 ? '' : 's'} that no longer applied` : ''));
  requestSave();
  return trimmed;
}

export function createTrimTool(): Tool {
  let hover: { hit: TrimHit; key: string; piece: Entity } | null = null;
  // a press: the pieces swiped over so far (key → a point on it)
  let swipe: { marked: Map<string, { point: Point; piece: Entity }>; last: Point } | null = null;

  const pick = (world: Point, ctx: ToolContext) => {
    const entities = activeEntities();
    const hit = hitTrim(entities, world, PICK_PX / ctx.viewport.scale);
    const pv = hit && trimPreview(entities, hit);
    return hit && pv ? { hit, key: pv.key, piece: pv.entity } : null;
  };

  const mark = (h: NonNullable<typeof hover>) => {
    if (swipe && !swipe.marked.has(h.key)) swipe.marked.set(h.key, { point: h.hit.point, piece: h.piece });
  };

  return {
    cursor: 'crosshair',

    onMouseDown(world: Point, _screen: Point, ctx: ToolContext) {
      swipe = { marked: new Map(), last: ctx.worldToScreen(world) };
      hover = pick(world, ctx);
      if (hover) mark(hover);
    },

    onMouseMove(world: Point, screen: Point, ctx: ToolContext) {
      hover = pick(world, ctx);
      if (!swipe) return;
      const from = swipe.last;
      const steps = Math.max(1, Math.ceil(Math.hypot(screen.x - from.x, screen.y - from.y) / STEP_PX));
      for (let i = 1; i <= steps; i++) {
        const s = { x: from.x + ((screen.x - from.x) * i) / steps, y: from.y + ((screen.y - from.y) * i) / steps };
        const h = pick(ctx.screenToWorld(s), ctx);
        if (h) mark(h);
      }
      swipe.last = screen;
    },

    onMouseUp(_world: Point, _screen: Point, ctx: ToolContext) {
      const s = swipe;
      swipe = null;
      if (!s || !s.marked.size) return;
      applyTrims([...s.marked.values()].map((m) => m.point), 1e-3 + 1 / ctx.viewport.scale);
      hover = null;
    },

    onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (swipe) swipe = null;
        else useEditorStore.getState().setActiveTool('select');
      }
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      const styles = getStyles(getThemePalette());
      const style = { ...styles.preview, color: TRIM_COLOR, width: 3, dash: [6, 4] };
      if (swipe) for (const m of swipe.marked.values()) renderEntity(renderer, viewport, m.piece, style, false, true);
      if (hover && !swipe?.marked.has(hover.key)) renderEntity(renderer, viewport, hover.piece, style, false, true);
    },
  };
}
