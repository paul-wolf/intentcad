import type { Entity } from '@/types/document';
import type { CamJobConfig, CamIssue, ToolpathMove } from '@/types/cam';
import { entityToSegments, type CncSegment } from './entityToSegments';
import { toolpathProfile } from './toolpathProfile';
import { toolpathDrill } from './toolpathDrill';
import { toolpathPocket } from './toolpathPocket';
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
 */
export function generateGcode(
  config: CamJobConfig,
  allEntities: Entity[],
): GenerateResult {
  // Filter entities to only those in selected sketches
  // (In this context, allEntities should already be from the right sketches,
  // but we filter by operation entityIds below)

  const allToolpathMoves: ToolpathMove[] = [];

  // Process each operation
  for (const op of config.operations) {
    const opEntities = allEntities.filter((e) => op.entityIds.includes(e.id));

    switch (op.kind) {
      case 'profile': {
        const segments = entityToSegments(opEntities, op.entityIds);
        if (segments.length === 0) break;

        // Group segments into separate connected contours so each gets
        // its own rapid/plunge/retract cycle (e.g. 6 separate circles)
        const contours = groupContours(segments);

        for (const contour of contours) {
          const { moves, startPosition } = toolpathProfile(
            contour,
            config.tool.diameter,
            op.cutSide,
            config.machine.feedRate,
            op.tabs,
            op.tabWidth,
            op.tabHeight,
          );
          if (moves.length === 0) continue;

          const withDepth = depthPasses(moves, config.depth, config.machine.safeZ, startPosition);
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
          config.depth.totalDepth,
          op.dwell,
          config.machine.feedRate,
          config.machine.plungeRate,
          config.machine.safeZ,
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
          config.tool.diameter,
          op.stepover,
          op.cutDirection,
          config.machine.feedRate,
        );

        const withDepth = depthPasses(singlePass, config.depth, config.machine.safeZ);
        allToolpathMoves.push(...withDepth);
        break;
      }
    }
  }

  // Validate
  const issues = validateCamJob(config, allEntities, allToolpathMoves);

  // Generate G-code only if no errors (warnings are OK)
  const hasErrors = issues.some((i) => i.severity === 'error');
  let gcode = '';
  let moveToLine: number[] = [];

  if (!hasErrors && allToolpathMoves.length > 0) {
    const result = gcodeEmitter(allToolpathMoves, config.postProcessor, config.origin);
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
      // Connected — same contour
      current.push(seg);
    } else {
      // Disconnected — start new contour
      groups.push(current);
      current = [seg];
    }
  }

  groups.push(current);
  return groups;
}
