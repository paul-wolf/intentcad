import type { Entity } from '@/types/document';
import type { CamJobConfig, CamIssue, ToolpathMove } from '@/types/cam';
import { entityToSegments, type CncSegment } from './entityToSegments';
import { toolpathProfile } from './toolpathProfile';
import { toolpathDrill } from './toolpathDrill';
import { toolpathPocket } from './toolpathPocket';
import { toolpathFacing } from './toolpathFacing';
import { depthPasses } from './depthPasses';
import { gcodeEmitter } from './gcodeEmitter';
import { validateCamJob } from './validate';

export interface GenerateResult {
  gcode: string;
  issues: CamIssue[];
  toolpath: ToolpathMove[];
  moveToLine: number[];
}

/**
 * Top-level orchestrator: given a CamJobConfig and all entities from the document,
 * generate G-code, collect issues, and produce toolpath moves for preview.
 *
 * Each operation now carries its own cutting parameters (tool, feeds, depths).
 */
export function generateGcode(
  config: CamJobConfig,
  allEntities: Entity[],
): GenerateResult {
  const allToolpathMoves: ToolpathMove[] = [];
  /** Per-operation spindle speeds for G-code emission. */
  const operationBoundaries: { moveStart: number; spindleSpeed: number }[] = [];

  for (const op of config.operations) {
    const opEntities = allEntities.filter((e) => op.entityIds.includes(e.id));
    const c = op.cutting;
    const moveStart = allToolpathMoves.length;

    switch (op.kind) {
      case 'profile': {
        const segments = entityToSegments(opEntities, op.entityIds);
        if (segments.length === 0) break;

        const contours = groupContours(segments);

        for (const contour of contours) {
          const { moves, startPosition } = toolpathProfile(
            contour,
            c.tool.diameter,
            op.cutSide,
            c.feedRate,
            op.tabs,
            op.tabWidth,
            op.tabHeight,
          );
          if (moves.length === 0) continue;

          const withDepth = depthPasses(moves, c.depth, c.safeZ, startPosition);
          allToolpathMoves.push(...withDepth);
        }
        break;
      }
      case 'drill': {
        const circles = opEntities
          .filter((e): e is Extract<typeof e, { type: 'circle' }> => e.type === 'circle')
          .map((e) => ({ center: e.center, radius: e.radius }));

        if (circles.length === 0) break;

        const drillMoves = toolpathDrill(
          circles,
          op.peckDepth,
          c.depth.totalDepth,
          op.dwell,
          c.feedRate,
          c.plungeRate,
          c.safeZ,
          config.origin,
        );
        allToolpathMoves.push(...drillMoves);
        break;
      }
      case 'pocket': {
        const segments = entityToSegments(opEntities, op.entityIds);
        if (segments.length === 0) break;

        const singlePass = toolpathPocket(
          segments,
          c.tool.diameter,
          op.stepover,
          op.cutDirection,
          c.feedRate,
        );

        const withDepth = depthPasses(singlePass, c.depth, c.safeZ);
        allToolpathMoves.push(...withDepth);
        break;
      }
      case 'facing': {
        // Facing uses stock dimensions — compute from selected entities bounding box
        // or fall back to a default stock size
        const allPts = opEntities.flatMap((e) => {
          if (e.type === 'circle') return [{ x: e.center.x - e.radius, y: e.center.y - e.radius }, { x: e.center.x + e.radius, y: e.center.y + e.radius }];
          if (e.type === 'line') return e.points;
          if (e.type === 'rectangle') {
            const hw = e.width / 2, hh = e.height / 2;
            return [{ x: e.center.x - hw, y: e.center.y - hh }, { x: e.center.x + hw, y: e.center.y + hh }];
          }
          if (e.type === 'bezier') return [...e.controlPoints];
          return [];
        });

        // Use entity bounds if available, otherwise use a reasonable default
        let stockW = 100;
        let stockH = 100;
        if (allPts.length > 0) {
          const xs = allPts.map((p) => p.x);
          const ys = allPts.map((p) => p.y);
          stockW = Math.max(...xs) - Math.min(...xs) + c.tool.diameter * 2;
          stockH = Math.max(...ys) - Math.min(...ys) + c.tool.diameter * 2;
        }

        const facingMoves = toolpathFacing(
          config.origin,
          c.tool.diameter,
          op.stepover,
          op.cutDirection,
          c.feedRate,
          stockW,
          stockH,
        );

        if (facingMoves.length > 0) {
          const withDepth = depthPasses(
            facingMoves.filter((m) => m.kind === 'linear'),
            c.depth,
            c.safeZ,
          );
          allToolpathMoves.push(...withDepth);
        }
        break;
      }
    }

    // Record operation boundary for spindle speed changes in G-code
    if (allToolpathMoves.length > moveStart) {
      operationBoundaries.push({ moveStart, spindleSpeed: c.spindleSpeed });
    }
  }

  // Validate
  const issues = validateCamJob(config, allEntities, allToolpathMoves);

  // Generate G-code only if no errors (warnings are OK)
  const hasErrors = issues.some((i) => i.severity === 'error');
  let gcode = '';
  let moveToLine: number[] = [];

  if (!hasErrors && allToolpathMoves.length > 0) {
    const result = gcodeEmitter(allToolpathMoves, config.postProcessor, config.origin, operationBoundaries);
    gcode = result.lines.join('\n');
    moveToLine = result.moveStartLines;
  }

  return { gcode, issues, toolpath: allToolpathMoves, moveToLine };
}

/**
 * Group segments into connected contours.
 * Consecutive segments where seg[i].to ≈ seg[i+1].from are in the same contour.
 * Disconnected segments start a new contour.
 */
function groupContours(segments: CncSegment[]): CncSegment[][] {
  if (segments.length === 0) return [];

  const groups: CncSegment[][] = [];
  let current: CncSegment[] = [segments[0]!];

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    const prev = current[current.length - 1]!;
    const dx = seg.from.x - prev.to.x;
    const dy = seg.from.y - prev.to.y;

    if (dx * dx + dy * dy < 1e-4) {
      current.push(seg);
    } else {
      groups.push(current);
      current = [seg];
    }
  }

  groups.push(current);
  return groups;
}
