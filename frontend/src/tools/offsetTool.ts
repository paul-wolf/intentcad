import type { Tool, ToolContext } from './types';
import type { Entity, Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import type { OffsetToolState } from '@/types/editor';
import { useEditorStore, rememberOffset } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { addLog } from '@/stores/logStore';
import { getStyles } from '@/rendering/styles';
import { renderEntity } from '@/rendering/pipeline';
import { getThemePalette } from '@/theme';
import { canOffset, connectedChain, offsetEntity, offsetIsClosed, offsetMeasure, offsettable, type OffsetJoin } from '@/utils/offset';
import { cutterPrims, nearestOn } from '@/utils/trim';
import { requestSave } from '@/api/autoSave';

/** How near (screen px) the cursor must be to a curve to pick it. */
const PICK_PX = 8;
/** Movement (screen px) that turns a press into a distance drag. */
const DRAG_PX = 4;

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

function activeEntities(): Entity[] {
  const doc = useDocumentStore.getState().document;
  return doc.sketches.find((s) => s.id === doc.activeSketchId)?.entities ?? [];
}

const lookupIn = (entities: Entity[]) => {
  const byId = new Map(entities.map((e) => [e.id, e]));
  return (id: string) => byId.get(id);
};

function toolState(): OffsetToolState | null {
  const s = useEditorStore.getState().toolState;
  return s.type === 'offset' ? s : null;
}

function setOffsetState(patch: Partial<Omit<OffsetToolState, 'type'>>) {
  const s = toolState();
  if (s) useEditorStore.getState().setToolState({ ...s, ...patch });
}

/** The picked sources that can be offset (the selection the tool started
 *  with may hold dimensions, points, copies…). */
export function offsetSourceIds(ids: string[], entities: Entity[]): string[] {
  const lookup = lookupIn(entities);
  return ids.filter((id) => offsettable(lookup(id)));
}

/** "outside" / "inside" for a closed shape; nothing for an open chain (the
 *  arrow on the drawing shows its side). */
export function offsetSideWord(ids: string[], side: 1 | -1, entities: Entity[]): string | null {
  return offsetIsClosed(ids, lookupIn(entities)) ? (side === 1 ? 'outside' : 'inside') : null;
}

/** The offset as it would be made (id 'preview'), or null when it can't be. */
export function offsetPreview(ids: string[], distance: number, side: 1 | -1, join: OffsetJoin, entities: Entity[]): Entity | null {
  const lookup = lookupIn(entities);
  if (!canOffset(ids, lookup)) return null;
  return offsetEntity(ids, { type: 'offset', distance, side, join }, 'preview', lookup);
}

/** Offset `sourceIds` as one undo step, saying what happened. `expression`
 *  (a P / parameter expression) goes on the distance dimension. */
export function applyOffset(sourceIds: string[], distance: number, side: 1 | -1, join: OffsetJoin, expression?: string): boolean {
  const entities = activeEntities();
  const ids = offsetSourceIds(sourceIds, entities);
  if (!ids.length || !(distance > 0)) return false;
  if (!offsetPreview(ids, distance, side, join, entities)) {
    addLog('warn', canOffset(ids, lookupIn(entities))
      ? `Can't offset ${fmt(distance)} that way: the shape is too small for it`
      : 'Nothing to offset: pick a closed shape, a circle, or lines joined end to end (not copies)');
    return false;
  }
  const store = useDocumentStore.getState();
  store.beginTransaction('Offset');
  const id = store.addOffset(ids, { distance, side, join }, expression);
  if (!id) return false;
  rememberOffset(distance, join);
  const word = offsetSideWord(ids, side, entities);
  addLog('info', `Offset ${ids.length === 1 ? '1 entity' : `a chain of ${ids.length} lines`} by ${fmt(distance)}${expression ? ` (${expression})` : ''}`
    + `${word ? `, ${word}` : ''}; it follows its source (Unlink in the properties to make it independent)`);
  setOffsetState({ sourceIds: [] });
  requestSave();
  return true;
}

/** A distance rounded to a step that suits the zoom (about 4 px on screen). */
function niceDistance(d: number, scale: number): number {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
  const step = steps.find((s) => s * scale >= 4) ?? 10;
  return Math.max(step, Math.round(d / step) * step);
}

function distanceTo(e: Entity, p: Point): number {
  let best = Infinity;
  for (const prim of cutterPrims(e)) best = Math.min(best, nearestOn(prim, p).dist);
  return best;
}

/** The offsettable entity under the cursor, and what a click on it picks:
 *  itself, or for an open line, the lines joined to it end to end. */
function hitSource(entities: Entity[], world: Point, tol: number): { id: string; ids: string[] } | null {
  let best: string | null = null;
  let bestD = tol;
  for (const e of entities) {
    if (!offsettable(e)) continue;
    const d = distanceTo(e, world);
    if (d <= bestD) { best = e.id; bestD = d; }
  }
  if (!best) return null;
  return { id: best, ids: connectedChain(entities, best) };
}

export function createOffsetTool(): Tool {
  let hover: string[] | null = null;
  let press: { screen: Point; dragging: boolean; onCurve: boolean } | null = null;
  let shift = false;

  /** The distance and side the cursor asks for: as far as it is from the
   *  source, on the side whose offset passes nearer it. */
  const fromCursor = (world: Point, ctx: ToolContext) => {
    const s = toolState();
    const entities = activeEntities();
    const ids = s ? offsetSourceIds(s.sourceIds, entities) : [];
    if (!s || !ids.length) return;
    const lookup = lookupIn(entities);
    const d = Math.min(...ids.map((id) => distanceTo(lookup(id)!, world)));
    if (!isFinite(d) || d <= 0) return;
    const distance = niceDistance(d, ctx.viewport.scale);
    let side: 1 | -1 = s.side;
    let bestD = Infinity;
    for (const k of [1, -1] as const) {
      const e = offsetPreview(ids, distance, k, s.join, entities);
      const dd = e ? distanceTo(e, world) : Infinity;
      if (dd < bestD) { bestD = dd; side = k; }
    }
    setOffsetState({ distance, side });
  };

  return {
    cursor: 'crosshair',

    onMouseDown(world: Point, screen: Point, ctx: ToolContext) {
      shift = !!ctx.shiftKey;
      const s = toolState();
      if (!s) return;
      const hit = hitSource(activeEntities(), world, PICK_PX / ctx.viewport.scale);
      press = { screen, dragging: false, onCurve: !!hit };
      if (!hit) return;
      const current = offsetSourceIds(s.sourceIds, activeEntities());
      const picked = hit.ids.every((id) => current.includes(id));
      if (shift) {
        setOffsetState({ sourceIds: picked ? current.filter((id) => !hit.ids.includes(id)) : [...current, ...hit.ids.filter((id) => !current.includes(id))] });
      } else if (!picked) {
        setOffsetState({ sourceIds: hit.ids });
      }
    },

    onMouseMove(world: Point, screen: Point, ctx: ToolContext) {
      hover = hitSource(activeEntities(), world, PICK_PX / ctx.viewport.scale)?.ids ?? null;
      if (!press) return;
      if (!press.dragging && Math.hypot(screen.x - press.screen.x, screen.y - press.screen.y) <= DRAG_PX) return;
      const s = toolState();
      if (!s || !offsetSourceIds(s.sourceIds, activeEntities()).length) return;
      press.dragging = true;
      fromCursor(world, ctx);
    },

    onMouseUp() {
      const p = press;
      press = null;
      const s = toolState();
      if (!p || !s) return;
      if (p.dragging) { applyOffset(s.sourceIds, s.distance, s.side, s.join); return; }
      if (!p.onCurve && !shift) setOffsetState({ sourceIds: [] });
    },

    onKeyDown(e: KeyboardEvent) {
      const s = toolState();
      const has = !!s && offsetSourceIds(s.sourceIds, activeEntities()).length > 0;
      if (e.key === 'Enter' && s && has) {
        applyOffset(s.sourceIds, s.distance, s.side, s.join);
      } else if (e.key === 'Escape') {
        if (press) press = null;
        else if (has) setOffsetState({ sourceIds: [] });
        else useEditorStore.getState().setActiveTool('select');
      }
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      const palette = getThemePalette();
      const styles = getStyles(palette);
      const s = toolState();
      const entities = activeEntities();
      const lookup = lookupIn(entities);
      const ids = s ? offsetSourceIds(s.sourceIds, entities) : [];

      if (hover) for (const id of hover) {
        const e = lookup(id);
        if (e && !ids.includes(id)) renderEntity(renderer, viewport, e, { ...styles.preview, width: 2 }, false, true);
      }
      for (const id of ids) {
        const e = lookup(id);
        if (e) renderEntity(renderer, viewport, e, { ...styles.preview, color: palette.accent, width: 3 }, false, true);
      }
      if (!s || !ids.length) return;

      // the result, ghosted, with an arrow from the source to it and its distance
      const preview = offsetPreview(ids, s.distance, s.side, s.join, entities);
      if (!preview) return;
      renderEntity(renderer, viewport, preview, { ...styles.preview, width: 2, dash: [6, 4] }, false, true);
      const m = offsetMeasure(preview, lookup);
      if (!m) return;
      const a = viewport.worldToScreen(m.a), b = viewport.worldToScreen(m.b);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const style = { color: palette.accent, width: 1.5 };
      renderer.drawLine(a, b, style);
      if (len > 6) {
        const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        const head = Math.min(8, len / 2);
        renderer.fillPolygon([
          b,
          { x: b.x - ux * head - uy * head * 0.45, y: b.y - uy * head + ux * head * 0.45 },
          { x: b.x - ux * head + uy * head * 0.45, y: b.y - uy * head - ux * head * 0.45 },
        ], palette.accent);
      }
      const word = offsetSideWord(ids, s.side, entities);
      renderer.drawText(`${fmt(s.distance)}${word ? ` ${word}` : ''}`, { x: b.x + 8, y: b.y - 8 },
        { color: palette.accent, fontSize: 12, textAlign: 'left', textBaseline: 'bottom' });
    },
  };
}
