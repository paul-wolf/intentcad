import type { Renderer, Viewport, LineStyle } from '@/types/renderer';
import type { Document, Entity } from '@/types/document';
import type { Tool } from '@/tools/types';
import type { ThemePalette } from '@/theme';
import { GRID_SPACING_MM, GRID_MAJOR_EVERY, GHOSTED_OPACITY, ENDPOINT_RADIUS, ORIGIN_RADIUS, AXIS_OPACITY } from '@/config';
import { getStyles } from './styles';
import { drawDimension, drawDiameterDimension, drawSegmentLabel, drawDiameterLabel } from './dimensionRenderer';

export interface RenderContext {
  renderer: Renderer;
  viewport: Viewport;
  document: Document;
  selectedEntityIds: Set<string>;
  activeTool: Tool | null;
  altKeyHeld: boolean;
  palette: ThemePalette;
}

/** Step 1: Clear background */
function renderBackground(ctx: RenderContext) {
  ctx.renderer.clear(ctx.palette.background);
}

/** Step 2: Draw grid */
function renderGrid(ctx: RenderContext) {
  const { renderer, viewport } = ctx;
  const styles = getStyles(ctx.palette);
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
      styles.gridMinor,
    );
  }
  for (let y = startY; y <= endY; y += spacing) {
    const isMajor = Math.abs(y % majorSpacing) < 0.001;
    if (isMajor) continue;
    const sy = viewport.worldToScreen({ x: 0, y }).y;
    renderer.drawLine(
      { x: 0, y: sy },
      { x: viewport.width, y: sy },
      styles.gridMinor,
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
      styles.gridMajor,
    );
  }
  for (let y = startY; y <= endY; y += spacing) {
    const isMajor = Math.abs(y % majorSpacing) < 0.001;
    if (!isMajor) continue;
    const sy = viewport.worldToScreen({ x: 0, y }).y;
    renderer.drawLine(
      { x: 0, y: sy },
      { x: viewport.width, y: sy },
      styles.gridMajor,
    );
  }
}

/** Step 2b: Draw origin axes and point */
function renderOrigin(ctx: RenderContext) {
  const { renderer, viewport, palette } = ctx;
  const origin = viewport.worldToScreen({ x: 0, y: 0 });

  renderer.setGlobalAlpha(AXIS_OPACITY);

  // X axis (horizontal line at y=0)
  renderer.drawLine(
    { x: 0, y: origin.y },
    { x: viewport.width, y: origin.y },
    { color: palette.axisX, width: 1 },
  );

  // Y axis (vertical line at x=0)
  renderer.drawLine(
    { x: origin.x, y: 0 },
    { x: origin.x, y: viewport.height },
    { color: palette.axisY, width: 1 },
  );

  renderer.resetGlobalAlpha();

  // Origin dot
  renderer.fillCircle(origin, ORIGIN_RADIUS, palette.origin);
}

/** Step 3: Draw ghosted (non-active, visible) sketches */
function renderGhostedSketches(ctx: RenderContext) {
  const { renderer, viewport, document: doc } = ctx;
  const styles = getStyles(ctx.palette);

  for (const sketch of doc.sketches) {
    if (sketch.id === doc.activeSketchId || !sketch.visible) continue;
    renderer.setGlobalAlpha(GHOSTED_OPACITY);
    for (const entity of sketch.entities) {
      const ghostStyle: LineStyle = 'construction' in entity && entity.construction
        ? { ...styles.ghosted, dash: [6, 4] }
        : styles.ghosted;
      renderEntity(renderer, viewport, entity, ghostStyle);
    }
    renderer.resetGlobalAlpha();
  }
}

/** Step 4: Draw active sketch entities */
function renderActiveSketch(ctx: RenderContext) {
  const { renderer, viewport, document: doc, selectedEntityIds } = ctx;
  const styles = getStyles(ctx.palette);
  const activeSketch = doc.sketches.find((s) => s.id === doc.activeSketchId);
  if (!activeSketch) return;

  for (const entity of activeSketch.entities) {
    const isSelected = selectedEntityIds.has(entity.id);
    switch (entity.type) {
      case 'line': {
        const style = entity.construction
          ? (isSelected ? styles.constructionSelected : styles.construction)
          : (isSelected ? styles.lineSelected : styles.line);
        renderEntity(renderer, viewport, entity, style);
        break;
      }
      case 'circle': {
        const style = entity.construction
          ? (isSelected ? styles.constructionSelected : styles.construction)
          : (isSelected ? styles.lineSelected : styles.line);
        const screenCenter = viewport.worldToScreen(entity.center);
        const screenRadius = entity.radius * viewport.scale;
        renderer.drawCircle(screenCenter, screenRadius, style);
        renderer.fillCircle(screenCenter, ENDPOINT_RADIUS, style.color);
        break;
      }
      case 'rectangle': {
        const style = entity.construction
          ? (isSelected ? styles.constructionSelected : styles.construction)
          : (isSelected ? styles.lineSelected : styles.line);
        renderEntity(renderer, viewport, entity, style);
        break;
      }
      case 'dimension': {
        const target = activeSketch.entities.find(
          (e) => e.id === entity.targetEntityId,
        );
        if (!target) break;
        const lineStyle = isSelected ? styles.dimensionSelected : styles.dimensionLine;
        const textStyle = styles.dimensionText;
        if (target.type === 'circle') {
          drawDiameterDimension(renderer, viewport, target.center, target.radius, entity.offset, lineStyle, textStyle, ctx.palette.background);
          break;
        }
        if (target.type === 'rectangle') {
          const hw = target.width / 2;
          const hh = target.height / 2;
          const c = target.center;
          let a, b;
          if (entity.segmentIndex === 0) {
            a = { x: c.x - hw, y: c.y + hh };
            b = { x: c.x + hw, y: c.y + hh };
          } else {
            a = { x: c.x + hw, y: c.y + hh };
            b = { x: c.x + hw, y: c.y - hh };
          }
          drawDimension(renderer, viewport, { a, b, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background);
          break;
        }
        if (target.type !== 'line') break;
        const idx = entity.segmentIndex;
        if (idx < 0 || idx >= target.points.length - 1) break;
        const a = target.points[idx]!;
        const b = target.points[idx + 1]!;
        drawDimension(renderer, viewport, { a, b, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background);
        break;
      }
    }
  }
}

/** Step 4b: Draw dimension overlay when Alt is held */
function renderDimensionOverlay(ctx: RenderContext) {
  if (!ctx.altKeyHeld) return;
  const { renderer, viewport, document: doc } = ctx;
  const styles = getStyles(ctx.palette);
  const activeSketch = doc.sketches.find((s) => s.id === doc.activeSketchId);
  if (!activeSketch) return;

  for (const entity of activeSketch.entities) {
    if (entity.type === 'line') {
      for (let i = 0; i < entity.points.length - 1; i++) {
        drawSegmentLabel(renderer, viewport, entity.points[i]!, entity.points[i + 1]!, styles.dimensionOverlayText, ctx.palette.background);
      }
    }
    if (entity.type === 'circle') {
      drawDiameterLabel(renderer, viewport, entity.center, entity.radius, styles.dimensionOverlayText, ctx.palette.background);
    }
    if (entity.type === 'rectangle') {
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const c = entity.center;
      // Width label along top edge
      drawSegmentLabel(renderer, viewport, { x: c.x - hw, y: c.y + hh }, { x: c.x + hw, y: c.y + hh }, styles.dimensionOverlayText, ctx.palette.background);
      // Height label along right edge
      drawSegmentLabel(renderer, viewport, { x: c.x + hw, y: c.y + hh }, { x: c.x + hw, y: c.y - hh }, styles.dimensionOverlayText, ctx.palette.background);
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
  style: LineStyle,
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
    case 'circle': {
      const screenCenter = viewport.worldToScreen(entity.center);
      const screenRadius = entity.radius * viewport.scale;
      renderer.drawCircle(screenCenter, screenRadius, style);
      break;
    }
    case 'rectangle': {
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const c = entity.center;
      const corners = [
        viewport.worldToScreen({ x: c.x - hw, y: c.y + hh }),
        viewport.worldToScreen({ x: c.x + hw, y: c.y + hh }),
        viewport.worldToScreen({ x: c.x + hw, y: c.y - hh }),
        viewport.worldToScreen({ x: c.x - hw, y: c.y - hh }),
      ];
      for (let i = 0; i < 4; i++) {
        renderer.drawLine(corners[i]!, corners[(i + 1) % 4]!, style);
      }
      const screenCenter = viewport.worldToScreen(c);
      renderer.fillCircle(screenCenter, ENDPOINT_RADIUS, style.color);
      break;
    }
  }
}

/** Render pipeline */
export function renderFrame(ctx: RenderContext): void {
  renderBackground(ctx);
  renderGrid(ctx);
  renderOrigin(ctx);
  renderGhostedSketches(ctx);
  renderActiveSketch(ctx);
  renderDimensionOverlay(ctx);
  renderToolOverlay(ctx);
}
