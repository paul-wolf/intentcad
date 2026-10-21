import type { Renderer, Viewport, LineStyle } from '@/types/renderer';
import type { Document, Entity, LineEntity, Point } from '@/types/document';
import type { Canvas2DRenderer } from './canvas2d';
import type { Tool } from '@/tools/types';
import type { ThemePalette } from '@/theme';
import type { SelectedPoint } from '@/stores/editorStore';
import type { SegmentHit } from '@/hittest/hitTest';
import { GRID_SPACING_MM, GRID_MAJOR_EVERY, GHOSTED_OPACITY, ENDPOINT_RADIUS, SELECTED_POINT_RADIUS, ORIGIN_RADIUS, AXIS_OPACITY } from '@/config';
import { getStyles } from './styles';
import type { ThemeStyles } from './styles';
import { drawDimension, drawDiameterDimension, drawSegmentLabel, drawDiameterLabel, computeAngleDimensionGeom, drawAngleDimension, drawRadiusDimension } from './dimensionRenderer';
import { computeSketchDoF, computeDerivedDimensionIds } from '@/utils/dof';
import { getEntityPoint } from '@/utils/entityPoints';
import { resolveDimensionEndpoints, resolveRadiusDimension } from '@/utils/dimensionGeom';
import { brokenIds, onBroken } from '@/utils/brokenRefs';
import { getConstraintPartners, getEntityRepresentativePoint, pointRelationMarks, CONSTRAINT_SYMBOLS } from '@/utils/constraints';
import { targetsOf } from '@/utils/brokenRefs';
import { getSegmentCount, getSegmentPointIndices, getSegmentBulge, getEntitySegmentEndpoints } from '@/utils/lineSegments';
import { arcFromBulge, arcMidpoint } from '@/utils/arcGeometry';
import { rectanglePath, rectangleOutline, rectangleCorners } from '@/utils/rectPath';
import { renderToolpathOverlay, renderSimulatorOverlay } from '@/components/ToolpathOverlay';
import { useCamStore } from '@/stores/camStore';

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
  camMode: boolean;
  lineWidthScale?: number;
  fontSizeScale?: number;
  /** Printable output: no grid, no origin axes, no editing handles. */
  exportMode?: boolean;
  /** Leave the canvas see-through instead of filling it with the theme background. */
  transparent?: boolean;
  /** Draw the grid (default true). */
  showGrid?: boolean;
  /** Draw only the active sketch: other visible sketches are not ghosted in. */
  soloActiveSketch?: boolean;
  /** Shapes a copy dialog would add (not in the document yet). */
  copyPreview?: Entity[] | null;
  /** The centre a circular copy preview turns about. */
  copyPreviewCenter?: Point | null;
  /** Shapes left out while a copy dialog previews their replacements. */
  copyPreviewHides?: Set<string> | null;
  /** Label an expression dimension "floor + 2 = 5", not just "floor + 2"
   *  (sketching on a part, where the expression's names live in the script). */
  expressionValues?: boolean;
}

/** Step 1: Clear background */
function renderBackground(ctx: RenderContext) {
  ctx.renderer.clear(ctx.transparent ? 'transparent' : ctx.palette.background);
}

/** Step 2: Draw grid */
function renderGrid(ctx: RenderContext) {
  const { renderer, viewport } = ctx;
  const styles = getStyles(ctx.palette, ctx.lineWidthScale, ctx.fontSizeScale);
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
  const styles = getStyles(ctx.palette, ctx.lineWidthScale, ctx.fontSizeScale);

  // In CAM mode, get selected sketch IDs and operation map for differentiated rendering
  let camSelectedSketchIds: Set<string> | null = null;
  let camEntityOpMap: Map<string, number> | null = null;
  let camFocusedOpIndex: number | null = null;
  if (ctx.camMode) {
    const camState = useCamStore.getState();
    camSelectedSketchIds = new Set(camState.jobConfig.selectedSketchIds);
    camEntityOpMap = new Map();
    camFocusedOpIndex = camState.focusedOperationIndex;
    for (let i = 0; i < camState.jobConfig.operations.length; i++) {
      for (const eid of camState.jobConfig.operations[i]!.entityIds) {
        camEntityOpMap.set(eid, i);
      }
    }
  }

  for (const sketch of doc.sketches) {
    if (sketch.id === doc.activeSketchId || !sketch.visible || sketch.suppressed) continue;
    if (ctx.soloActiveSketch) continue;

    if (ctx.camMode) {
      const isSelected = camSelectedSketchIds!.has(sketch.id);
      if (isSelected) {
        // CAM-selected non-active sketches: render at full opacity with operation colors
        for (const entity of sketch.entities) {
          if (entity.type === 'dimension') continue;
          if ('construction' in entity && entity.construction) continue;
          let style: LineStyle = styles.line;
          const opIdx = camEntityOpMap!.get(entity.id);
          if (opIdx !== undefined) {
            const color = CAM_OP_COLORS[opIdx % CAM_OP_COLORS.length]!;
            style = { color, width: opIdx === camFocusedOpIndex ? 2.5 : 1.5 };
          }
          renderEntity(renderer, viewport, entity, style, false, ctx.exportMode);
        }
      } else {
        // Non-selected sketches in CAM: very faint disabled look
        renderer.setGlobalAlpha(0.15);
        for (const entity of sketch.entities) {
          if (entity.type === 'dimension') continue;
          renderEntity(renderer, viewport, entity, styles.ghosted, false, ctx.exportMode);
        }
        renderer.resetGlobalAlpha();
      }
    } else {
      renderer.setGlobalAlpha(GHOSTED_OPACITY);
      for (const entity of sketch.entities) {
        const ghostStyle: LineStyle = 'construction' in entity && entity.construction
          ? { ...styles.ghosted, dash: [6, 4] }
          : styles.ghosted;
        renderEntity(renderer, viewport, entity, ghostStyle, false, ctx.exportMode);
      }
      renderer.resetGlobalAlpha();
    }
  }
}

/** Pick the right line style based on selection, construction, constraint, and related status. */
function pickStyle(
  styles: ThemeStyles,
  isSelected: boolean,
  isConstruction: boolean,
  isConstrained: boolean,
  isRelated: boolean = false,
  isReference: boolean = false,
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
  // Reference/datum geometry reads as a marker regardless of constraint state
  if (isReference) return styles.reference;
  // Constrained (green)
  if (isConstrained && isConstruction) return styles.constructionConstrained;
  if (isConstrained) return styles.lineConstrained;
  // Normal
  if (isConstruction) return styles.construction;
  return styles.line;
}

/** CAM operation colors for entity highlighting */
const CAM_OP_COLORS = ['#ff8c00', '#00bcd4', '#8bc34a', '#e91e63', '#9c27b0', '#ff5722'];

/** Step 4: Draw active sketch entities */
function renderActiveSketch(ctx: RenderContext) {
  const { renderer, viewport, document: doc, selectedEntityIds } = ctx;
  const styles = getStyles(ctx.palette, ctx.lineWidthScale, ctx.fontSizeScale);
  const activeSketch = doc.sketches.find((s) => s.id === doc.activeSketchId);
  if (!activeSketch || activeSketch.suppressed) return;

  // In CAM mode, build a map of entity -> operation index for coloring
  let camEntityOpMap: Map<string, number> | undefined;
  let camFocusedOpIndex: number | null = null;
  let camActiveSketchSelected = true;
  if (ctx.camMode) {
    const camState = useCamStore.getState();
    camActiveSketchSelected = camState.jobConfig.selectedSketchIds.includes(activeSketch.id);
    camEntityOpMap = new Map();
    camFocusedOpIndex = camState.focusedOperationIndex;
    for (let i = 0; i < camState.jobConfig.operations.length; i++) {
      for (const eid of camState.jobConfig.operations[i]!.entityIds) {
        camEntityOpMap.set(eid, i);
      }
    }

    // If active sketch is not CAM-selected, render it faded and return
    if (!camActiveSketchSelected) {
      renderer.setGlobalAlpha(0.15);
      for (const entity of activeSketch.entities) {
        if (entity.type === 'dimension') continue;
        renderEntity(renderer, viewport, entity, styles.ghosted, false, ctx.exportMode);
      }
      renderer.resetGlobalAlpha();
      return;
    }
  }

  const dofMap = ctx.camMode ? new Map() : computeSketchDoF(activeSketch.entities, activeSketch.constraints);
  const derivedDimIds = ctx.camMode ? new Set<string>() : computeDerivedDimensionIds(activeSketch.entities, activeSketch.constraints);
  const { relatedIds } = ctx.camMode ? { relatedIds: new Set<string>() } : getConstraintPartners(selectedEntityIds, activeSketch.constraints);
  // a face sketch's reference edges whose face edge is gone, and what is
  // dimensioned to them: red, so they can be found and re-dimensioned
  const broken = ctx.camMode ? new Set<string>() : brokenIds(activeSketch.entities);
  const brokenStyle: LineStyle = { ...styles.reference, color: ctx.palette.danger };

  for (const entity of activeSketch.entities) {
    if (ctx.copyPreviewHides?.has(entity.id)) continue;   // being replaced (see renderCopyPreview)
    // In CAM mode, skip construction entities and dimensions
    if (ctx.camMode) {
      if (entity.type === 'dimension') continue;
      if ('construction' in entity && entity.construction) continue;
    }

    const isSelected = selectedEntityIds.has(entity.id) &&
      !ctx.selectedSegments.some(s => s.entityId === entity.id);
    const isRelated = !isSelected && relatedIds.has(entity.id);
    const isReference = 'reference' in entity && !!entity.reference;

    // In CAM mode, override style for entities assigned to operations
    let camStyle: LineStyle | undefined;
    if (ctx.camMode && camEntityOpMap) {
      const opIdx = camEntityOpMap.get(entity.id);
      if (opIdx !== undefined) {
        const color = CAM_OP_COLORS[opIdx % CAM_OP_COLORS.length]!;
        const isFocused = opIdx === camFocusedOpIndex;
        camStyle = { color, width: isFocused ? 2.5 : 1.5 };
      }
    }

    switch (entity.type) {
      case 'line': {
        const isConstrained = dofMap.get(entity.id) === 0;
        const style = camStyle ?? (!isSelected && broken.has(entity.id) ? brokenStyle
          : pickStyle(styles, isSelected, !!entity.construction, isConstrained, isRelated, isReference));
        renderEntity(renderer, viewport, entity, style, !!(entity.fill && entity.closed && !entity.construction), ctx.exportMode);
        break;
      }
      case 'circle': {
        const isConstrained = dofMap.get(entity.id) === 0;
        const style = camStyle ?? (!isSelected && broken.has(entity.id) ? brokenStyle
          : pickStyle(styles, isSelected, !!entity.construction, isConstrained, isRelated, isReference));
        const screenCenter = viewport.worldToScreen(entity.center);
        const screenRadius = entity.radius * viewport.scale;
        if (entity.fill && !entity.construction) {
          renderer.setGlobalAlpha(0.25);
          renderer.fillCircle(screenCenter, screenRadius, style.color);
          renderer.resetGlobalAlpha();
        }
        renderer.drawCircle(screenCenter, screenRadius, style);
        if (!ctx.exportMode) renderer.fillCircle(screenCenter, ENDPOINT_RADIUS, style.color);
        break;
      }
      case 'rectangle': {
        const isConstrained = dofMap.get(entity.id) === 0;
        const style = camStyle ?? pickStyle(styles, isSelected, !!entity.construction, isConstrained, isRelated, isReference);
        renderEntity(renderer, viewport, entity, style, !!(entity.fill && !entity.construction), ctx.exportMode);
        break;
      }
      case 'point': {
        if (ctx.camMode) break; // Skip standalone points in CAM mode
        const isConstrained = dofMap.get(entity.id) === 0;
        const style = pickStyle(styles, isSelected, !!entity.construction, isConstrained, isRelated, isReference);
        const sp = viewport.worldToScreen(entity.position);
        renderer.fillCircle(sp, ENDPOINT_RADIUS + 1, style.color);
        if (isSelected) {
          renderer.drawCircle(sp, SELECTED_POINT_RADIUS + 3, { color: style.color, width: 1.5 });
        }
        break;
      }
      case 'bezier': {
        const isConstrained = dofMap.get(entity.id) === 0;
        const style = camStyle ?? pickStyle(styles, isSelected, !!entity.construction, isConstrained, isRelated, isReference);
        renderEntity(renderer, viewport, entity, style, false, ctx.exportMode);
        // When selected, show control handle lines and all 4 control points
        if (isSelected) {
          const [cp0, cp1, cp2, cp3] = entity.controlPoints;
          const s0 = viewport.worldToScreen(cp0);
          const s1 = viewport.worldToScreen(cp1);
          const s2 = viewport.worldToScreen(cp2);
          const s3 = viewport.worldToScreen(cp3);
          // Dashed handle lines P0→P1 and P3→P2
          const handleStyle: LineStyle = { ...style, dash: [4, 3] };
          renderer.drawLine(s0, s1, handleStyle);
          renderer.drawLine(s3, s2, handleStyle);
          // All 4 control point dots
          renderer.fillCircle(s0, ENDPOINT_RADIUS, style.color);
          renderer.fillCircle(s1, ENDPOINT_RADIUS, style.color);
          renderer.fillCircle(s2, ENDPOINT_RADIUS, style.color);
          renderer.fillCircle(s3, ENDPOINT_RADIUS, style.color);
        }
        break;
      }
      case 'text': {
        const style = pickStyle(styles, isSelected, !!entity.construction, false, isRelated, isReference);
        const screenPos = viewport.worldToScreen(entity.position);
        const screenHeight = entity.height * viewport.scale;
        const fontSize = Math.max(8, Math.min(screenHeight, 200));
        const ctx2 = renderer as Canvas2DRenderer;
        if (ctx2.drawText) {
          ctx2.drawText(entity.text, screenPos, {
            fontSize,
            color: style.color,
            textAlign: 'left',
            textBaseline: 'bottom',
          });
        }
        break;
      }
      case 'dimension': {
        const target = activeSketch.entities.find(
          (e) => e.id === entity.targetEntityId,
        );
        if (!target) break;
        const isDerived = derivedDimIds.has(entity.id);
        const onGone = onBroken(entity, broken);
        const lineStyle = isSelected ? styles.dimensionSelected
          : onGone ? { ...styles.dimensionLine, color: ctx.palette.danger } : styles.dimensionLine;
        const textStyle = onGone ? { ...styles.dimensionText, color: ctx.palette.danger } : styles.dimensionText;

        const ws = ctx.lineWidthScale ?? 1;
        // {v}: the measured value, filled in by the renderer
        const dimLabel = entity.expression && ctx.expressionValues ? `${entity.expression} = {v}` : entity.expression;

        if (entity.radius) {
          const g = resolveRadiusDimension(entity, activeSketch.entities);
          if (g) drawRadiusDimension(renderer, viewport, g.center, g.arcPoint, g.end, g.radius, lineStyle, textStyle, ctx.palette.background, isDerived, dimLabel, ws);
          break;
        }

        // Point-to-point dimension (vertex-based)
        if (entity.pointIndex != null) {
          const endpoints = resolveDimensionEndpoints(entity, activeSketch.entities);
          if (endpoints) {
            drawDimension(renderer, viewport, { a: endpoints.a, b: endpoints.b, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background, isDerived, dimLabel, ws);
          }
          break;
        }

        // Two-entity dimension (distance or angle)
        if (entity.targetEntityId2 != null) {
          const target2 = activeSketch.entities.find(
            (e) => e.id === entity.targetEntityId2,
          );
          if (!target2) break;

          // Circle-to-circle center distance
          if (target.type === 'circle' && target2.type === 'circle') {
            drawDimension(renderer, viewport, { a: target.center, b: target2.center, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background, isDerived, dimLabel, ws);
            break;
          }

          // Support line and rectangle segment endpoints
          const ep1 = getEntitySegmentEndpoints(target, entity.segmentIndex);
          const ep2 = getEntitySegmentEndpoints(target2, entity.segmentIndex2 ?? 0);
          if (!ep1 || !ep2) break;
          const [p1, p2] = ep1;
          const [q1, q2] = ep2;

          if (entity.angleMode && target.type === 'line' && target2.type === 'line') {
            const angleGeom = computeAngleDimensionGeom(p1, p2, q1, q2, entity.offset);
            if (angleGeom) {
              drawAngleDimension(renderer, viewport, angleGeom, lineStyle, textStyle, ctx.palette.background, isDerived, dimLabel, ws);
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
          drawDimension(renderer, viewport, { a, b, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background, isDerived, dimLabel, ws);
          break;
        }

        if (target.type === 'circle') {
          drawDiameterDimension(renderer, viewport, target.center, target.radius, entity.offset, lineStyle, textStyle, ctx.palette.background, isDerived, dimLabel, ws);
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
          drawDimension(renderer, viewport, { a, b, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background, isDerived, dimLabel, ws);
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
          drawDimension(renderer, viewport, { a: center, b: midA, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background, isDerived, dimLabel, ws);
          break;
        }
        const idx = entity.segmentIndex;
        if (idx < 0 || idx >= getSegmentCount(target)) break;
        const [ai, bi] = getSegmentPointIndices(target, idx);
        const a = target.points[ai]!;
        const b = target.points[bi]!;
        drawDimension(renderer, viewport, { a, b, offset: entity.offset }, lineStyle, textStyle, ctx.palette.background, isDerived, dimLabel, ws);
        break;
      }
    }
  }
}

/** Step 4b: Draw dimension overlay when Alt is held */
function renderDimensionOverlay(ctx: RenderContext) {
  if (!ctx.altKeyHeld) return;
  const { renderer, viewport, document: doc } = ctx;
  const styles = getStyles(ctx.palette, ctx.lineWidthScale, ctx.fontSizeScale);
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
    if (entity.type === 'bezier') {
      // Show chord length (P0 to P3)
      drawSegmentLabel(renderer, viewport, entity.controlPoints[0], entity.controlPoints[3], styles.dimensionOverlayText, ctx.palette.background);
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
  const styles = getStyles(ctx.palette, ctx.lineWidthScale, ctx.fontSizeScale);
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

/** The shapes an open copy dialog would add, in the accent colour */
function renderCopyPreview(ctx: RenderContext) {
  const styles = getStyles(ctx.palette, ctx.lineWidthScale, ctx.fontSizeScale);
  const style: LineStyle = { color: ctx.palette.accent, width: styles.line.width, opacity: 0.75 };
  for (const entity of ctx.copyPreview ?? []) renderEntity(ctx.renderer, ctx.viewport, entity, style, false, true);
  if (ctx.copyPreviewCenter) {
    // a crosshair in a ring where the copies turn about
    const c = ctx.viewport.worldToScreen(ctx.copyPreviewCenter);
    const mark: LineStyle = { color: ctx.palette.accent, width: 1.5 };
    ctx.renderer.drawCircle(c, 6, mark);
    ctx.renderer.drawLine({ x: c.x - 10, y: c.y }, { x: c.x + 10, y: c.y }, mark);
    ctx.renderer.drawLine({ x: c.x, y: c.y - 10 }, { x: c.x, y: c.y + 10 }, mark);
  }
}

/** Step 5: Draw tool overlay (preview line, snap indicator, selection rect) */
function renderToolOverlay(ctx: RenderContext) {
  if (ctx.activeTool?.renderOverlay) {
    ctx.activeTool.renderOverlay(ctx.renderer, ctx.viewport);
  }
}

export function renderEntity(
  renderer: Renderer,
  viewport: Viewport,
  entity: Entity,
  style: LineStyle,
  fillShape = false,
  /** Suppress endpoint / centre dots — they are editing affordances, not geometry */
  hideHandles = false,
) {
  switch (entity.type) {
    case 'line': {
      if (fillShape) {
        const screenPoints = entity.points.map((p) => viewport.worldToScreen(p));
        renderer.setGlobalAlpha(0.25);
        renderer.fillPolygon(screenPoints, style.color);
        renderer.resetGlobalAlpha();
      }
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
      if (!hideHandles) {
        for (const pt of entity.points) {
          renderer.fillCircle(viewport.worldToScreen(pt), ENDPOINT_RADIUS, style.color);
        }
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
      const c = entity.center;
      const { points, bulge } = rectanglePath(entity);
      const screenPts = points.map((p) => viewport.worldToScreen(p));
      if (fillShape) {
        renderer.setGlobalAlpha(0.25);
        renderer.fillPolygon(rectangleOutline(entity).map((p) => viewport.worldToScreen(p)), style.color);
        renderer.resetGlobalAlpha();
      }
      for (let i = 0; i < screenPts.length; i++) {
        const a = screenPts[i]!;
        const b = screenPts[(i + 1) % screenPts.length]!;
        const seg = bulge[i] ?? 0;
        if (seg === 0) {
          renderer.drawLine(a, b, style);
        } else {
          const arc = arcFromBulge(points[i]!, points[(i + 1) % points.length]!, seg);
          renderer.drawArc(viewport.worldToScreen(arc.center), arc.radius * viewport.scale,
            arc.startAngle, arc.endAngle, arc.counterClockwise, style);
        }
      }
      if (!hideHandles) {
        const screenCenter = viewport.worldToScreen(c);
        renderer.fillCircle(screenCenter, ENDPOINT_RADIUS, style.color);
        // Corner dots stay on the theoretical (sharp) corners even when filleted —
        // they are the drag handles, and entityPoints indices 1-4 resolve there.
        for (const corner of rectangleCorners(entity)) {
          renderer.fillCircle(viewport.worldToScreen(corner), ENDPOINT_RADIUS, style.color);
        }
      }
      break;
    }
    case 'point': {
      const sp = viewport.worldToScreen(entity.position);
      renderer.fillCircle(sp, ENDPOINT_RADIUS, style.color);
      break;
    }
    case 'bezier': {
      const [cp0, cp1, cp2, cp3] = entity.controlPoints;
      const s0 = viewport.worldToScreen(cp0);
      const s1 = viewport.worldToScreen(cp1);
      const s2 = viewport.worldToScreen(cp2);
      const s3 = viewport.worldToScreen(cp3);
      renderer.drawBezier(s0, s1, s2, s3, style);
      if (!hideHandles) {
        // Endpoint dots (P0 and P3)
        renderer.fillCircle(s0, ENDPOINT_RADIUS, style.color);
        renderer.fillCircle(s3, ENDPOINT_RADIUS, style.color);
      }
      break;
    }
    case 'text': {
      const screenPos = viewport.worldToScreen(entity.position);
      const screenHeight = entity.height * viewport.scale;
      const fontSize = Math.max(8, Math.min(screenHeight, 200));
      const r = renderer as Canvas2DRenderer;
      if (r.drawText) {
        r.drawText(entity.text, screenPos, {
          fontSize,
          color: style.color,
          textAlign: 'left',
          textBaseline: 'bottom',
        });
      }
      break;
    }
  }
}

/** Step 4a: Draw dashed connection lines between selected entities and their constraint partners */
function renderConstraintLinks(ctx: RenderContext) {
  const { renderer, viewport, document: doc, selectedEntityIds } = ctx;
  // A selected point shows its shape's point relations too
  const involved = new Set([...selectedEntityIds, ...ctx.selectedPoints.map((p) => p.entityId)]);
  if (involved.size === 0) return;

  const activeSketch = doc.sketches.find((s) => s.id === doc.activeSketchId);
  if (!activeSketch || activeSketch.suppressed) return;

  const styles = getStyles(ctx.palette, ctx.lineWidthScale, ctx.fontSizeScale);
  const { links } = getConstraintPartners(selectedEntityIds, activeSketch.constraints);

  const entityMap = new Map(activeSketch.entities.map((e) => [e.id, e]));
  const constraintMap = new Map(activeSketch.constraints.map((c) => [c.id, c]));

  const drawLink = (screenA: Point, screenB: Point, symbol: string) => {
    // Draw dashed connection line
    renderer.drawLine(screenA, screenB, styles.constraintLinkLine);

    // Draw constraint symbol at midpoint
    const mid = { x: (screenA.x + screenB.x) / 2, y: (screenA.y + screenB.y) / 2 };
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
  };

  for (const link of links) {
    // Skip coincident — points overlap, line would be zero-length noise
    if (link.constraintType === 'coincident') continue;
    // Point relations are drawn between their points, below
    const c = constraintMap.get(link.constraintId);
    if (c && pointRelationMarks(c, entityMap)) continue;

    const srcEntity = entityMap.get(link.entityId);
    const tgtEntity = entityMap.get(link.targetEntityId);
    if (!srcEntity || !tgtEntity) continue;

    const srcPt = getEntityRepresentativePoint(srcEntity);
    const tgtPt = getEntityRepresentativePoint(tgtEntity);
    if (!srcPt || !tgtPt) continue;

    drawLink(viewport.worldToScreen(srcPt), viewport.worldToScreen(tgtPt), CONSTRAINT_SYMBOLS[link.constraintType] ?? '?');
  }

  for (const c of activeSketch.constraints) {
    if (!targetsOf(c).some((id) => involved.has(id))) continue;
    for (const m of pointRelationMarks(c, entityMap) ?? []) {
      drawLink(viewport.worldToScreen(m.a), viewport.worldToScreen(m.b), m.symbol);
    }
  }
}

/** Step 6: Draw CAM origin marker */
function renderCamOrigin(ctx: RenderContext) {
  if (!ctx.camMode) return;
  const camState = useCamStore.getState();
  const origin = camState.jobConfig.origin;
  const screenPos = ctx.viewport.worldToScreen(origin);
  const size = 10;
  const picking = camState.pickingOrigin;
  const color = picking ? '#ff4444' : '#00cc66';

  // Crosshair
  ctx.renderer.drawLine(
    { x: screenPos.x - size, y: screenPos.y },
    { x: screenPos.x + size, y: screenPos.y },
    { color, width: 2 },
  );
  ctx.renderer.drawLine(
    { x: screenPos.x, y: screenPos.y - size },
    { x: screenPos.x, y: screenPos.y + size },
    { color, width: 2 },
  );
  // Circle around crosshair
  ctx.renderer.drawCircle(screenPos, size * 0.7, { color, width: 1.5 });

  // Label
  ctx.renderer.drawText('WCS', { x: screenPos.x + size + 3, y: screenPos.y - 3 }, {
    color,
    fontSize: 10,
    textAlign: 'left',
    textBaseline: 'middle',
  });
}

/** Step 6b: Draw CAM toolpath overlay */
function renderCamToolpath(ctx: RenderContext) {
  if (!ctx.camMode) return;
  const camState = useCamStore.getState();
  if (!camState.showToolpathPreview || !camState.toolpath) return;

  if (camState.simState !== 'idle') {
    renderSimulatorOverlay(
      ctx.renderer,
      ctx.viewport,
      camState.toolpath,
      camState.issues,
      ctx.palette,
      camState.jobConfig.origin,
      {
        simMoveIndex: camState.simMoveIndex,
        simProgress: camState.simProgress,
        simPosition: camState.simPosition,
      },
      camState.jobConfig.operations[0]?.cutting.tool.diameter ?? 3,
    );
  } else {
    renderToolpathOverlay(
      ctx.renderer,
      ctx.viewport,
      camState.toolpath,
      camState.issues,
      ctx.palette,
      camState.jobConfig.origin,
    );
  }
}

/** Render pipeline */
export function renderFrame(ctx: RenderContext): void {
  renderBackground(ctx);
  if (!ctx.exportMode) {
    if (ctx.showGrid !== false) renderGrid(ctx);
    renderOrigin(ctx);
  }
  renderGhostedSketches(ctx);
  renderActiveSketch(ctx);
  if (!ctx.exportMode) renderCopyPreview(ctx);

  if (!ctx.camMode) {
    // Sketch-only rendering steps
    renderConstraintLinks(ctx);
    renderDimensionOverlay(ctx);
    renderArcMidpointHandles(ctx);
  }

  renderSelectedSegments(ctx);
  renderSelectedPoints(ctx);

  if (!ctx.camMode) {
    renderToolOverlay(ctx);
  }

  renderCamOrigin(ctx);
  renderCamToolpath(ctx);
}
