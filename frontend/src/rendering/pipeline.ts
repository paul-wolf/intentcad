import type { Renderer, Viewport, LineStyle } from '@/types/renderer';
import type { Document, Entity, LineEntity, Point } from '@/types/document';
import type { Tool } from '@/tools/types';
import type { ThemePalette } from '@/theme';
import type { SelectedPoint } from '@/stores/editorStore';
import type { SegmentHit } from '@/hittest/hitTest';
import { GRID_SPACING_MM, GRID_MAJOR_EVERY, GHOSTED_OPACITY, ENDPOINT_RADIUS, SELECTED_POINT_RADIUS, ORIGIN_RADIUS, AXIS_OPACITY } from '@/config';
import { getStyles } from './styles';
import type { ThemeStyles } from './styles';
import { drawDimension, drawDiameterDimension, drawSegmentLabel, drawDiameterLabel, computeAngleDimensionGeom, drawAngleDimension } from './dimensionRenderer';
import { computeSketchDoF, computeDerivedDimensionIds } from '@/utils/dof';
import { getEntityPoint } from '@/utils/entityPoints';
import { getConstraintPartners, getEntityRepresentativePoint, CONSTRAINT_SYMBOLS } from '@/utils/constraints';
import { getSegmentCount, getSegmentPointIndices, getSegmentBulge } from '@/utils/lineSegments';
import { arcFromBulge, arcMidpoint } from '@/utils/arcGeometry';

export interface RenderContext {
  renderer: Renderer;
  viewport: Viewport;
  document: Document;
  selectedEntityIds: Set<string>;
  selectedPoints: SelectedPoint[];
  selectedSegments: SegmentHit[];
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
    if (sketch.id === doc.activeSketchId || !sketch.visible || sketch.suppressed) continue;
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

/** Pick the right line style based on selection, construction, constraint, and related status. */
function pickStyle(
  styles: ThemeStyles,
  isSelected: boolean,
  isConstruction: boolean,
  isConstrained: boolean,
  isRelated: boolean = false,
): LineStyle {
  // Selected (blue) wins
  if (isSelected) {
    if (isConstrained && isConstruction) return styles.constructionConstrainedSelected;
    if (isConstrained) return styles.lineConstrainedSelected;
    if (isConstruction) return styles.constructionSelected;
    return styles.lineSelected;
  }
  // Related (amber) — partner of a selected entity
  if (isRelated) {
    const base = isConstrained ? styles.lineRelatedConstrained : styles.lineRelated;
    return isConstruction ? { ...base, dash: [6, 4] } : base;
  }
  // Constrained (green)
  if (isConstrained && isConstruction) return styles.constructionConstrained;
  if (isConstrained) return styles.lineConstrained;
  // Normal
  if (isConstruction) return styles.construction;
  return styles.line;
}

/** Step 4: Draw active sketch entities */
function renderActiveSketch(ctx: RenderContext) {
  const { renderer, viewport, document: doc, selectedEntityIds } = ctx;
  const styles = getStyles(ctx.palette);
  const activeSketch = doc.sketches.find((s) => s.id === doc.activeSketchId);
  if (!activeSketch || activeSketch.suppressed) return;

  const dofMap = computeSketchDoF(activeSketch.entities, activeSketch.constraints);
  const derivedDimIds = computeDerivedDimensionIds(activeSketch.entities, activeSketch.constraints);
  const { relatedIds } = getConstraintPartners(selectedEntityIds, activeSketch.constraints);

  for (const entity of activeSketch.entities) {
    const isSelected = selectedEntityIds.has(entity.id) &&
      !ctx.selectedSegments.some(s => s.entityId === entity.id);
    const isRelated = !isSelected && relatedIds.has(entity.id);
    switch (entity.type) {
      case 'line': {
        const isConstrained = dofMap.get(entity.id) === 0;
        const style = pickStyle(styles, isSelected, !!entity.construction, isConstrained, isRelated);
        renderEntity(renderer, viewport, entity, style);
        break;
      }
      case 'circle': {
        const isConstrained = dofMap.get(entity.id) === 0;
        const style = pickStyle(styles, isSelected, !!entity.construction, isConstrained, isRelated);
        const screenCenter = viewport.worldToScreen(entity.center);
        const screenRadius = entity.radius * viewport.scale;
        renderer.drawCircle(screenCenter, screenRadius, style);
        renderer.fillCircle(screenCenter, ENDPOINT_RADIUS, style.color);
        break;
      }
      case 'rectangle': {
        const isConstrained = dofMap.get(entity.id) === 0;
        const style = pickStyle(styles, isSelected, !!entity.construction, isConstrained, isRelated);
        renderEntity(renderer, viewport, entity, style);
        break;
      }
      case 'point': {
        const isConstrained = dofMap.get(entity.id) === 0;
        const style = pickStyle(styles, isSelected, !!entity.construction, isConstrained, isRelated);
        const sp = viewport.worldToScreen(entity.position);
        renderer.fillCircle(sp, ENDPOINT_RADIUS + 1, style.color);
        if (isSelected) {
          renderer.drawCircle(sp, SELECTED_POINT_RADIUS + 3, { color: style.color, width: 1.5 });
        }
        break;
      }
      case 'dimension': {
        const target = activeSketch.entities.find(
          (e) => e.id === entity.targetEntityId,
        );
        if (!target) break;
        const isDerived = derivedDimIds.has(entity.id);
        const lineStyle = isSelected ? styles.dimensionSelected : styles.dimensionLine;
        const textStyle = styles.dimensionText;

        // Two-segment dimension (distance or angle)
        if (entity.targetEntityId2 != null) {
          const target2 = activeSketch.entities.find(
            (e) => e.id === entity.targetEntityId2,
          );
          if (!target2 || target.type !== 'line' || target2.type !== 'line') break;
          const idx1 = entity.segmentIndex;
          const idx2 = entity.segmentIndex2!;
          if (idx1 < 0 || idx1 >= getSegmentCount(target)) break;
          if (idx2 < 0 || idx2 >= getSegmentCount(target2)) break;
          const [pi1, pi2] = getSegmentPointIndices(target, idx1);
          const [qi1, qi2] = getSegmentPointIndices(target2, idx2);
          const p1 = target.points[pi1]!;
          const p2 = target.points[pi2]!;
          const q1 = target2.points[qi1]!;
          const q2 = target2.points[qi2]!;

          if (entity.angleMode) {
            const angleGeom = computeAngleDimensionGeom(p1, p2, q1, q2, entity.offset);
            if (angleGeom) {
              drawAngleDimension(renderer, viewport, angleGeom, lineStyle, textStyle, ctx.palette.background, isDerived);
            }
            break;
          }

          const a: Point = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          const dx = q2.x - q1.x;
          const dy = q2.y - q1.y;
          const lenSq = dx * dx + dy * dy;
          if (lenSq === 0) break;
          const t = ((a.x - q1.x) * dx + (a.y - q1.y) * dy) / lenSq;
          const b: Point = { x: q1.x + t * dx, y: q1.y + t * dy };
          drawDimension(renderer, viewport, { a, b, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background, isDerived);
          break;
        }

        if (target.type === 'circle') {
          drawDiameterDimension(renderer, viewport, target.center, target.radius, entity.offset, lineStyle, textStyle, ctx.palette.background, isDerived);
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
          drawDimension(renderer, viewport, { a, b, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background, isDerived);
          break;
        }
        if (target.type !== 'line') break;
        // Polygon apothem dimension
        if (entity.segmentIndex === -1 && (target as LineEntity).polygonCenter) {
          const center = (target as LineEntity).polygonCenter!;
          const midA: Point = {
            x: (target.points[0]!.x + target.points[1]!.x) / 2,
            y: (target.points[0]!.y + target.points[1]!.y) / 2,
          };
          drawDimension(renderer, viewport, { a: center, b: midA, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background, isDerived);
          break;
        }
        const idx = entity.segmentIndex;
        if (idx < 0 || idx >= getSegmentCount(target)) break;
        const [ai, bi] = getSegmentPointIndices(target, idx);
        const a = target.points[ai]!;
        const b = target.points[bi]!;
        drawDimension(renderer, viewport, { a, b, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background, isDerived);
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
  if (!activeSketch || activeSketch.suppressed) return;

  for (const entity of activeSketch.entities) {
    if (entity.type === 'line') {
      if ((entity as LineEntity).polygonCenter) {
        // Show apothem label for polygons
        const center = (entity as LineEntity).polygonCenter!;
        const midA: Point = {
          x: (entity.points[0]!.x + entity.points[1]!.x) / 2,
          y: (entity.points[0]!.y + entity.points[1]!.y) / 2,
        };
        drawSegmentLabel(renderer, viewport, center, midA, styles.dimensionOverlayText, ctx.palette.background);
      } else {
        const segCnt = getSegmentCount(entity);
        for (let i = 0; i < segCnt; i++) {
          const [si1, si2] = getSegmentPointIndices(entity, i);
          // For arc segments, still measure chord length but position at arc midpoint
          drawSegmentLabel(renderer, viewport, entity.points[si1]!, entity.points[si2]!, styles.dimensionOverlayText, ctx.palette.background);
        }
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

/** Step 4c: Draw highlights on selected vertices */
function renderSelectedPoints(ctx: RenderContext) {
  const { renderer, viewport, document: doc, selectedPoints, palette } = ctx;
  if (selectedPoints.length === 0) return;
  const activeSketch = doc.sketches.find((s) => s.id === doc.activeSketchId);
  if (!activeSketch) return;

  for (const sp of selectedPoints) {
    const entity = activeSketch.entities.find((e) => e.id === sp.entityId);
    if (!entity) continue;
    const pt = getEntityPoint(entity, sp.pointIndex);
    if (!pt) continue;
    const screenPt = viewport.worldToScreen(pt);
    renderer.fillCircle(screenPt, SELECTED_POINT_RADIUS, palette.accent);
  }
}

/** Step 4d: Draw highlights on selected segments */
function renderSelectedSegments(ctx: RenderContext) {
  const { renderer, viewport, document: doc, selectedSegments } = ctx;
  if (selectedSegments.length === 0) return;
  const styles = getStyles(ctx.palette);
  const activeSketch = doc.sketches.find((s) => s.id === doc.activeSketchId);
  if (!activeSketch) return;

  for (const seg of selectedSegments) {
    const entity = activeSketch.entities.find((e) => e.id === seg.entityId);
    if (!entity) continue;

    if (entity.type === 'line') {
      const idx = seg.segmentIndex;
      if (idx < 0 || idx >= getSegmentCount(entity)) continue;
      const [ssi1, ssi2] = getSegmentPointIndices(entity, idx);
      const bulge = getSegmentBulge(entity, idx);
      if (bulge !== 0) {
        const arc = arcFromBulge(entity.points[ssi1]!, entity.points[ssi2]!, bulge);
        const screenCenter = viewport.worldToScreen(arc.center);
        const screenRadius = arc.radius * viewport.scale;
        renderer.drawArc(screenCenter, screenRadius, arc.startAngle, arc.endAngle, arc.counterClockwise, styles.segmentSelected);
      } else {
        const a = viewport.worldToScreen(entity.points[ssi1]!);
        const b = viewport.worldToScreen(entity.points[ssi2]!);
        renderer.drawLine(a, b, styles.segmentSelected);
      }
    } else if (entity.type === 'rectangle') {
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const c = entity.center;
      // 0=TL→TR, 1=TR→BR, 2=BR→BL, 3=BL→TL
      const corners: Point[] = [
        { x: c.x - hw, y: c.y + hh },
        { x: c.x + hw, y: c.y + hh },
        { x: c.x + hw, y: c.y - hh },
        { x: c.x - hw, y: c.y - hh },
      ];
      const idx = seg.segmentIndex;
      if (idx < 0 || idx >= 4) continue;
      const a = viewport.worldToScreen(corners[idx]!);
      const b = viewport.worldToScreen(corners[(idx + 1) % 4]!);
      renderer.drawLine(a, b, styles.segmentSelected);
    }
  }
}

/** Step 4e: Draw arc midpoint handles for selected entities/segments */
function renderArcMidpointHandles(ctx: RenderContext) {
  const { renderer, viewport, document: doc, selectedSegments, selectedEntityIds, palette } = ctx;
  const activeSketch = doc.sketches.find((s) => s.id === doc.activeSketchId);
  if (!activeSketch) return;

  // Collect arc segments to show handles for: from explicit segment selections + entity selections
  const drawn = new Set<string>(); // "entityId:segIdx" to avoid duplicates

  // From selected segments
  for (const seg of selectedSegments) {
    const entity = activeSketch.entities.find((e) => e.id === seg.entityId);
    if (!entity || entity.type !== 'line') continue;
    const idx = seg.segmentIndex;
    if (idx < 0 || idx >= getSegmentCount(entity)) continue;
    const bulge = getSegmentBulge(entity, idx);
    if (bulge === 0) continue;
    const key = `${entity.id}:${idx}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    const [i1, i2] = getSegmentPointIndices(entity, idx);
    const mid = arcMidpoint(entity.points[i1]!, entity.points[i2]!, bulge);
    const screenMid = viewport.worldToScreen(mid);
    renderer.fillCircle(screenMid, SELECTED_POINT_RADIUS, palette.accent);
    renderer.drawCircle(screenMid, SELECTED_POINT_RADIUS + 1, { color: palette.accent, width: 1 });
  }

  // From selected entities (show handles on all their arc segments)
  for (const entityId of selectedEntityIds) {
    const entity = activeSketch.entities.find((e) => e.id === entityId);
    if (!entity || entity.type !== 'line') continue;
    const segCount = getSegmentCount(entity);
    for (let i = 0; i < segCount; i++) {
      const bulge = getSegmentBulge(entity, i);
      if (bulge === 0) continue;
      const key = `${entity.id}:${i}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const [i1, i2] = getSegmentPointIndices(entity, i);
      const mid = arcMidpoint(entity.points[i1]!, entity.points[i2]!, bulge);
      const screenMid = viewport.worldToScreen(mid);
      renderer.fillCircle(screenMid, SELECTED_POINT_RADIUS, palette.accent);
      renderer.drawCircle(screenMid, SELECTED_POINT_RADIUS + 1, { color: palette.accent, width: 1 });
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
      const segCount = getSegmentCount(entity);
      for (let i = 0; i < segCount; i++) {
        const [i1, i2] = getSegmentPointIndices(entity, i);
        const bulge = getSegmentBulge(entity, i);
        if (bulge !== 0) {
          const arc = arcFromBulge(entity.points[i1]!, entity.points[i2]!, bulge);
          const screenCenter = viewport.worldToScreen(arc.center);
          const screenRadius = arc.radius * viewport.scale;
          renderer.drawArc(screenCenter, screenRadius, arc.startAngle, arc.endAngle, arc.counterClockwise, style);
        } else {
          const a = viewport.worldToScreen(entity.points[i1]!);
          const b = viewport.worldToScreen(entity.points[i2]!);
          renderer.drawLine(a, b, style);
        }
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
      // Corner dots
      for (const corner of corners) {
        renderer.fillCircle(corner, ENDPOINT_RADIUS, style.color);
      }
      break;
    }
    case 'point': {
      const sp = viewport.worldToScreen(entity.position);
      renderer.fillCircle(sp, ENDPOINT_RADIUS, style.color);
      break;
    }
  }
}

/** Step 4a: Draw dashed connection lines between selected entities and their constraint partners */
function renderConstraintLinks(ctx: RenderContext) {
  const { renderer, viewport, document: doc, selectedEntityIds } = ctx;
  if (selectedEntityIds.size === 0) return;

  const activeSketch = doc.sketches.find((s) => s.id === doc.activeSketchId);
  if (!activeSketch || activeSketch.suppressed) return;

  const styles = getStyles(ctx.palette);
  const { links } = getConstraintPartners(selectedEntityIds, activeSketch.constraints);

  const entityMap = new Map(activeSketch.entities.map((e) => [e.id, e]));

  for (const link of links) {
    // Skip coincident — points overlap, line would be zero-length noise
    if (link.constraintType === 'coincident') continue;

    const srcEntity = entityMap.get(link.entityId);
    const tgtEntity = entityMap.get(link.targetEntityId);
    if (!srcEntity || !tgtEntity) continue;

    const srcPt = getEntityRepresentativePoint(srcEntity);
    const tgtPt = getEntityRepresentativePoint(tgtEntity);
    if (!srcPt || !tgtPt) continue;

    const screenA = viewport.worldToScreen(srcPt);
    const screenB = viewport.worldToScreen(tgtPt);

    // Draw dashed connection line
    renderer.drawLine(screenA, screenB, styles.constraintLinkLine);

    // Draw constraint symbol at midpoint
    const mid = { x: (screenA.x + screenB.x) / 2, y: (screenA.y + screenB.y) / 2 };
    const symbol = CONSTRAINT_SYMBOLS[link.constraintType] ?? '?';
    const textStyle = styles.constraintLinkText;
    const measured = renderer.measureText(symbol, textStyle);
    const padX = 4;
    const padY = 2;

    // Background pill
    renderer.drawRect(
      { x: mid.x - measured.width / 2 - padX, y: mid.y - measured.height / 2 - padY },
      { x: measured.width + padX * 2, y: measured.height + padY * 2 },
      ctx.palette.background,
    );

    // Symbol text
    renderer.drawText(symbol, mid, {
      ...textStyle,
      textAlign: 'center',
      textBaseline: 'middle',
    });
  }
}

/** Render pipeline */
export function renderFrame(ctx: RenderContext): void {
  renderBackground(ctx);
  renderGrid(ctx);
  renderOrigin(ctx);
  renderGhostedSketches(ctx);
  renderActiveSketch(ctx);
  renderConstraintLinks(ctx);
  renderDimensionOverlay(ctx);
  renderSelectedSegments(ctx);
  renderArcMidpointHandles(ctx);
  renderSelectedPoints(ctx);
  renderToolOverlay(ctx);
}
