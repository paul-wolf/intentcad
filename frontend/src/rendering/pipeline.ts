import type { Renderer, Viewport } from '@/types/renderer';
import type { Document, Entity } from '@/types/document';
import type { Tool } from '@/tools/types';
import { COLORS, GRID_SPACING_MM, GRID_MAJOR_EVERY, GHOSTED_OPACITY, ENDPOINT_RADIUS } from '@/config';
import {
  LINE_STYLE,
  LINE_SELECTED_STYLE,
  GHOSTED_STYLE,
  GRID_MINOR_STYLE,
  GRID_MAJOR_STYLE,
  DIMENSION_LINE_STYLE,
  DIMENSION_SELECTED_STYLE,
  DIMENSION_TEXT_STYLE,
  DIMENSION_OVERLAY_TEXT_STYLE,
} from './styles';
import { drawDimension, drawSegmentLabel } from './dimensionRenderer';

export interface RenderContext {
  renderer: Renderer;
  viewport: Viewport;
  document: Document;
  selectedEntityIds: Set<string>;
  activeTool: Tool | null;
  altKeyHeld: boolean;
}

/** Step 1: Clear background */
function renderBackground(ctx: RenderContext) {
  ctx.renderer.clear(COLORS.background);
}

/** Step 2: Draw grid */
function renderGrid(ctx: RenderContext) {
  const { renderer, viewport } = ctx;
  const spacing = GRID_SPACING_MM;
  const majorSpacing = spacing * GRID_MAJOR_EVERY;

  // Compute world-space bounds visible in the viewport
  const topLeft = viewport.screenToWorld({ x: 0, y: 0 });
  const bottomRight = viewport.screenToWorld({
    x: viewport.width,
    y: viewport.height,
  });

  const startX = Math.floor(topLeft.x / spacing) * spacing;
  const endX = Math.ceil(bottomRight.x / spacing) * spacing;
  const startY = Math.floor(topLeft.y / spacing) * spacing;
  const endY = Math.ceil(bottomRight.y / spacing) * spacing;

  // Minor grid lines
  for (let x = startX; x <= endX; x += spacing) {
    const isMajor = Math.abs(x % majorSpacing) < 0.001;
    if (isMajor) continue;
    const sx = viewport.worldToScreen({ x, y: 0 }).x;
    renderer.drawLine(
      { x: sx, y: 0 },
      { x: sx, y: viewport.height },
      GRID_MINOR_STYLE,
    );
  }
  for (let y = startY; y <= endY; y += spacing) {
    const isMajor = Math.abs(y % majorSpacing) < 0.001;
    if (isMajor) continue;
    const sy = viewport.worldToScreen({ x: 0, y }).y;
    renderer.drawLine(
      { x: 0, y: sy },
      { x: viewport.width, y: sy },
      GRID_MINOR_STYLE,
    );
  }

  // Major grid lines
  for (let x = startX; x <= endX; x += spacing) {
    const isMajor = Math.abs(x % majorSpacing) < 0.001;
    if (!isMajor) continue;
    const sx = viewport.worldToScreen({ x, y: 0 }).x;
    renderer.drawLine(
      { x: sx, y: 0 },
      { x: sx, y: viewport.height },
      GRID_MAJOR_STYLE,
    );
  }
  for (let y = startY; y <= endY; y += spacing) {
    const isMajor = Math.abs(y % majorSpacing) < 0.001;
    if (!isMajor) continue;
    const sy = viewport.worldToScreen({ x: 0, y }).y;
    renderer.drawLine(
      { x: 0, y: sy },
      { x: viewport.width, y: sy },
      GRID_MAJOR_STYLE,
    );
  }
}

/** Step 3: Draw ghosted (non-active, visible) sketches */
function renderGhostedSketches(ctx: RenderContext) {
  const { renderer, viewport, document: doc } = ctx;

  for (const sketch of doc.sketches) {
    if (sketch.id === doc.activeSketchId || !sketch.visible) continue;
    renderer.setGlobalAlpha(GHOSTED_OPACITY);
    for (const entity of sketch.entities) {
      renderEntity(renderer, viewport, entity, GHOSTED_STYLE);
    }
    renderer.resetGlobalAlpha();
  }
}

/** Step 4: Draw active sketch entities */
function renderActiveSketch(ctx: RenderContext) {
  const { renderer, viewport, document: doc, selectedEntityIds } = ctx;
  const activeSketch = doc.sketches.find((s) => s.id === doc.activeSketchId);
  if (!activeSketch) return;

  for (const entity of activeSketch.entities) {
    const isSelected = selectedEntityIds.has(entity.id);
    switch (entity.type) {
      case 'line': {
        const style = isSelected ? LINE_SELECTED_STYLE : LINE_STYLE;
        renderEntity(renderer, viewport, entity, style);
        break;
      }
      case 'dimension': {
        const target = activeSketch.entities.find(
          (e) => e.id === entity.targetEntityId && e.type === 'line',
        );
        if (!target || target.type !== 'line') break;
        const idx = entity.segmentIndex;
        if (idx < 0 || idx >= target.points.length - 1) break;
        const a = target.points[idx]!;
        const b = target.points[idx + 1]!;
        const lineStyle = isSelected ? DIMENSION_SELECTED_STYLE : DIMENSION_LINE_STYLE;
        const textStyle = DIMENSION_TEXT_STYLE;
        drawDimension(renderer, viewport, { a, b, offset: entity.offset }, lineStyle, textStyle);
        break;
      }
    }
  }
}

/** Step 4b: Draw dimension overlay when Alt is held */
function renderDimensionOverlay(ctx: RenderContext) {
  if (!ctx.altKeyHeld) return;
  const { renderer, viewport, document: doc } = ctx;
  const activeSketch = doc.sketches.find((s) => s.id === doc.activeSketchId);
  if (!activeSketch) return;

  for (const entity of activeSketch.entities) {
    if (entity.type === 'line') {
      for (let i = 0; i < entity.points.length - 1; i++) {
        drawSegmentLabel(renderer, viewport, entity.points[i]!, entity.points[i + 1]!, DIMENSION_OVERLAY_TEXT_STYLE);
      }
    }
  }
}

/** Step 5: Draw tool overlay (preview line, snap indicator, selection rect) */
function renderToolOverlay(ctx: RenderContext) {
  if (ctx.activeTool?.renderOverlay) {
    ctx.activeTool.renderOverlay(ctx.renderer, ctx.viewport);
  }
}

function renderEntity(
  renderer: Renderer,
  viewport: Viewport,
  entity: Entity,
  style: { color: string; width: number },
) {
  switch (entity.type) {
    case 'line': {
      for (let i = 0; i < entity.points.length - 1; i++) {
        const a = viewport.worldToScreen(entity.points[i]!);
        const b = viewport.worldToScreen(entity.points[i + 1]!);
        renderer.drawLine(a, b, style);
      }
      for (const pt of entity.points) {
        renderer.fillCircle(viewport.worldToScreen(pt), ENDPOINT_RADIUS, style.color);
      }
      break;
    }
  }
}

/** Render pipeline */
export function renderFrame(ctx: RenderContext): void {
  renderBackground(ctx);
  renderGrid(ctx);
  renderGhostedSketches(ctx);
  renderActiveSketch(ctx);
  renderDimensionOverlay(ctx);
  renderToolOverlay(ctx);
}
