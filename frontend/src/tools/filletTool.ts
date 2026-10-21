import type { Tool, ToolContext } from './types';
import type { Entity, Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import type { FilletToolState } from '@/types/editor';
import { useEditorStore, rememberFilletRadius } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { addLog } from '@/stores/logStore';
import { getStyles } from '@/rendering/styles';
import { renderEntity } from '@/rendering/pipeline';
import { getThemePalette } from '@/theme';
import { SNAP_INDICATOR_RADIUS, SELECTED_POINT_RADIUS } from '@/config';
import { cornerAt, filletSketch, type Corner } from '@/utils/fillet';
import { rectangleCorners } from '@/utils/rectPath';
import { requestSave } from '@/api/autoSave';

/** How near (screen px) the cursor must be to pick a corner. */
const PICK_PX = 10;
/** Movement (screen px) that turns a click on a corner into a radius drag. */
const DRAG_PX = 4;

export interface CornerCandidate extends Corner {
  pos: Point;
  /** angle between the two edges at the corner (radians) */
  angle: number;
}

function angleAt(prev: Point, v: Point, next: Point): number {
  const a = Math.atan2(prev.y - v.y, prev.x - v.x);
  const b = Math.atan2(next.y - v.y, next.x - v.x);
  let d = Math.abs(a - b);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/** Every corner of the sketch that can be rounded: polyline vertices between
 *  two straight segments, and rectangle corners (not copies or reference
 *  geometry, which follow something else). */
export function cornerCandidates(entities: Entity[]): CornerCandidate[] {
  const out: CornerCandidate[] = [];
  for (const e of entities) {
    if (e.type === 'line') {
      if (e.sourceId || e.reference) continue;
      for (let i = 0; i < e.points.length; i++) {
        const c = cornerAt(e, i);
        if (c) out.push({ entityId: e.id, index: i, pos: c.v, angle: angleAt(c.prev, c.v, c.next) });
      }
    } else if (e.type === 'rectangle') {
      if (e.sourceId || e.reference) continue;
      rectangleCorners(e).forEach((p, i) => out.push({ entityId: e.id, index: i, pos: p, angle: Math.PI / 2 }));
    }
  }
  return out;
}

const sameCorner = (a: Corner, b: Corner) => a.entityId === b.entityId && a.index === b.index;

function activeEntities(): Entity[] {
  const doc = useDocumentStore.getState().document;
  return doc.sketches.find((s) => s.id === doc.activeSketchId)?.entities ?? [];
}

function toolState(): FilletToolState | null {
  const s = useEditorStore.getState().toolState;
  return s.type === 'fillet' ? s : null;
}

function setFilletState(patch: Partial<Omit<FilletToolState, 'type'>>) {
  const s = toolState();
  if (s) useEditorStore.getState().setToolState({ ...s, ...patch });
}

/** A radius rounded to a step that suits the zoom (about 4 px on screen). */
function niceRadius(r: number, scale: number): number {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
  const step = steps.find((s) => s * scale >= 4) ?? 10;
  return Math.max(step, Math.round(r / step) * step);
}

/** Round `corners` to radius `r` as one undo step, saying what happened.
 *  `expression` (a P / parameter expression) goes on the new radius
 *  dimensions so they follow it. True when anything was rounded. */
export function applyFillet(corners: Corner[], r: number, expression?: string): boolean {
  if (corners.length === 0 || !(r > 0)) return false;
  const store = useDocumentStore.getState();
  const before = new Set(activeEntities().map((e) => e.id));
  store.beginTransaction('Fillet');
  const out = store.filletCorners(corners, r);
  if (!out) {
    addLog('warn', 'Nothing to fillet: pick corners between two straight edges of a polyline or rectangle (not copies or reference geometry)');
    return false;
  }
  const newDims = activeEntities().filter((e) => e.type === 'dimension' && e.radius && !before.has(e.id));
  if (expression && out.clampedTo == null) for (const d of newDims) store.setDimensionExpression(d.id, expression);
  rememberFilletRadius(r);
  const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
  addLog('info', `Rounded ${out.rounded} corner${out.rounded === 1 ? '' : 's'}, R ${fmt(r)}${expression && out.clampedTo == null ? ` (${expression})` : ''}`);
  if (out.clampedTo != null) addLog('warn', `Radius ${fmt(r)} too large for some corners: clamped to the largest that fits, R ${fmt(out.clampedTo)}`);
  if (out.skipped) addLog('warn', `Skipped ${out.skipped} corner${out.skipped === 1 ? '' : 's'} that can't be rounded (an end, next to an arc, a copy or reference geometry)`);
  if (out.dropped) addLog('info', `Dropped ${out.dropped} constraint${out.dropped === 1 ? '' : 's'} / dimension${out.dropped === 1 ? '' : 's'} on the old corner or on edges now shorter`);
  setFilletState({ corners: [], radius: r });
  requestSave();
  return true;
}

export function createFilletTool(): Tool {
  let hover: CornerCandidate | null = null;
  // a press on a corner (maybe a radius drag) or on empty space (a box)
  let press: { screen: Point; world: Point; corner: CornerCandidate | null; dragging: boolean } | null = null;
  let box: { a: Point; b: Point } | null = null;
  let shift = false;

  const nearest = (screen: Point, ctx: ToolContext): CornerCandidate | null => {
    let best: CornerCandidate | null = null;
    let bestD = PICK_PX;
    for (const c of cornerCandidates(activeEntities())) {
      const s = ctx.worldToScreen(c.pos);
      const d = Math.hypot(s.x - screen.x, s.y - screen.y);
      if (d <= bestD) { best = c; bestD = d; }
    }
    return best;
  };

  return {
    cursor: 'crosshair',

    onMouseDown(world: Point, screen: Point, ctx: ToolContext) {
      shift = !!ctx.shiftKey;
      const c = nearest(screen, ctx);
      press = { screen, world, corner: c, dragging: false };
      const s = toolState();
      if (!s || !c) return;
      const picked = s.corners.some((x) => sameCorner(x, c));
      if (shift) {
        setFilletState({ corners: picked ? s.corners.filter((x) => !sameCorner(x, c)) : [...s.corners, { entityId: c.entityId, index: c.index }] });
      } else if (!picked) {
        setFilletState({ corners: [{ entityId: c.entityId, index: c.index }] });
      }
    },

    onMouseMove(world: Point, screen: Point, ctx: ToolContext) {
      hover = nearest(screen, ctx);
      if (!press) return;
      const moved = Math.hypot(screen.x - press.screen.x, screen.y - press.screen.y) > DRAG_PX;
      if (press.corner) {
        if (!moved && !press.dragging) return;
        press.dragging = true;
        // the cursor's distance from the corner is where the arc meets the
        // edges (the tangent length): r = t·tan(θ/2)
        const t = Math.hypot(world.x - press.corner.pos.x, world.y - press.corner.pos.y);
        setFilletState({ radius: niceRadius(t * Math.tan(press.corner.angle / 2), ctx.viewport.scale) });
      } else if (moved || box) {
        box = { a: press.world, b: world };
      }
    },

    onMouseUp(world: Point) {
      const p = press;
      press = null;
      const s = toolState();
      if (!p || !s) { box = null; return; }
      if (p.corner && p.dragging) {
        const corners = s.corners.some((x) => sameCorner(x, p.corner!)) ? s.corners : [...s.corners, p.corner];
        applyFillet(corners, s.radius);
        return;
      }
      if (p.corner) return; // a click: picked, now type the radius (or drag)
      if (!box) {
        if (!shift) setFilletState({ corners: [] });
        return;
      }
      const lo = { x: Math.min(box.a.x, world.x), y: Math.min(box.a.y, world.y) };
      const hi = { x: Math.max(box.a.x, world.x), y: Math.max(box.a.y, world.y) };
      box = null;
      const inside = cornerCandidates(activeEntities())
        .filter((c) => c.pos.x >= lo.x && c.pos.x <= hi.x && c.pos.y >= lo.y && c.pos.y <= hi.y)
        .map((c) => ({ entityId: c.entityId, index: c.index }));
      const base = shift ? s.corners : [];
      setFilletState({ corners: [...base, ...inside.filter((c) => !base.some((x) => sameCorner(x, c)))] });
    },

    onKeyDown(e: KeyboardEvent) {
      const s = toolState();
      if (e.key === 'Enter' && s && s.corners.length) {
        applyFillet(s.corners, s.radius);
      } else if (e.key === 'Escape') {
        if (s && s.corners.length) setFilletState({ corners: [] });
        else useEditorStore.getState().setActiveTool('select');
      }
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      const palette = getThemePalette();
      const styles = getStyles(palette);
      const s = toolState();
      const entities = activeEntities();

      // the result, ghosted, while corners are picked
      if (s && s.corners.length) {
        const doc = useDocumentStore.getState().document;
        const sketch = doc.sketches.find((x) => x.id === doc.activeSketchId);
        const out = sketch && filletSketch(sketch.entities, sketch.constraints, s.corners, s.radius, () => 'preview');
        if (out) {
          const ids = new Set(s.corners.map((c) => c.entityId));
          for (const e of out.entities) if (ids.has(e.id)) renderEntity(renderer, viewport, e, { ...styles.preview, width: 2 }, false, true);
        }
      }

      const all = cornerCandidates(entities);
      for (const c of all) {
        const sp = viewport.worldToScreen(c.pos);
        const picked = s?.corners.some((x) => sameCorner(x, c));
        if (picked) renderer.fillCircle(sp, SELECTED_POINT_RADIUS + 1, palette.accent);
        else renderer.drawCircle(sp, 3, { color: styles.preview.color, width: 1 });
      }
      if (hover) renderer.drawCircle(viewport.worldToScreen(hover.pos), SNAP_INDICATOR_RADIUS, styles.snap);

      if (box) {
        const a = viewport.worldToScreen(box.a);
        const b = viewport.worldToScreen(box.b);
        renderer.drawRect(
          { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
          { x: Math.abs(b.x - a.x), y: Math.abs(b.y - a.y) },
          palette.selectionRect,
          { color: palette.selectionRectBorder, width: 1 },
        );
      }
    },
  };
}
