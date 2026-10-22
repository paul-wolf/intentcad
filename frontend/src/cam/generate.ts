import type { Entity } from '@/types/document';
import type { CamJobConfig, CamIssue, CamTool, ToolpathMove } from '@/types/cam';
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
  /** Problems found while building toolpaths (reported with the validation issues). */
  const buildIssues: CamIssue[] = [];
  /** Per-operation spindle speed and tool, for spindle changes and tool-change pauses. */
  const operationBoundaries: { moveStart: number; spindleSpeed: number; tool: CamTool }[] = [];

  for (const [opIndex, op] of config.operations.entries()) {
    const opEntities = allEntities.filter((e) => op.entityIds.includes(e.id));
    const c = op.cutting;
    const moveStart = allToolpathMoves.length;

    switch (op.kind) {
      case 'profile': {
        const segments = entityToSegments(opEntities, op.entityIds);
        if (segments.length === 0) break;

        // Every closed loop runs counter-clockwise (in sketch coordinates), so
        // "outside" is always to the right of travel, however it was drawn.
        const contours = groupContours(segments).map(orientCounterClockwise);

        for (const contour of contours) {
          const { moves, startPosition, problem } = toolpathProfile(
            contour,
            c.tool.diameter,
            op.cutSide,
            c.feedRate,
            op.tabs,
            op.tabWidth,
            op.tabHeight,
          );
          if (problem) {
            buildIssues.push({
              severity: 'error',
              message: `Operation ${opIndex + 1}: ${problem}`,
              operationIndex: opIndex,
              position: startPosition,
            });
            continue;
          }
          if (moves.length === 0) continue;

          const withDepth = depthPasses(moves, c.depth, c.safeZ, c.plungeRate, startPosition);
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

        const withDepth = depthPasses(singlePass, c.depth, c.safeZ, c.plungeRate);
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
        let areaCenter = { x: 0, y: 0 };
        if (allPts.length > 0) {
          const xs = allPts.map((p) => p.x);
          const ys = allPts.map((p) => p.y);
          const minX = Math.min(...xs), maxX = Math.max(...xs);
          const minY = Math.min(...ys), maxY = Math.max(...ys);
          stockW = maxX - minX + c.tool.diameter * 2;
          stockH = maxY - minY + c.tool.diameter * 2;
          areaCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        }

        const facingMoves = toolpathFacing(
          areaCenter,
          c.tool.diameter,
          op.stepover,
          op.cutDirection,
          c.feedRate,
          stockW,
          stockH,
        );

        if (facingMoves.length > 0) {
          const withDepth = depthPasses(facingMoves, c.depth, c.safeZ, c.plungeRate);
          allToolpathMoves.push(...withDepth);
        }
        break;
      }
    }

    // Record operation boundary for spindle speed changes in G-code
    if (allToolpathMoves.length > moveStart) {
      operationBoundaries.push({ moveStart, spindleSpeed: c.spindleSpeed, tool: c.tool });
    }
  }

  // Validate
  const issues = [...buildIssues, ...validateCamJob(config, allEntities, allToolpathMoves)];

  // Generate G-code only if no errors (warnings are OK)
  const hasErrors = issues.some((i) => i.severity === 'error');
  let gcode = '';
  let moveToLine: number[] = [];

  if (!hasErrors && allToolpathMoves.length > 0) {
    const safeZ = Math.max(...config.operations.map((op) => op.cutting.safeZ));
    const result = gcodeEmitter(allToolpathMoves, config.postProcessor, config.origin, operationBoundaries, {
      safeZ,
      floodCoolant: config.useFloodCoolant,
    });
    gcode = result.lines.join('\n');
    moveToLine = result.moveStartLines;
  }

  return { gcode, issues, toolpath: allToolpathMoves, moveToLine };
}

const CHAIN_TOL = 0.5; // endpoint matching tolerance when chaining segments

/**
 * Signed area of a contour in sketch coordinates, arcs included (shoelace over
 * the chords plus each arc's circular segment). Positive = counter-clockwise in
 * the sketch's own (x, y) coordinates.
 */
export function signedArea(contour: CncSegment[]): number {
  let area = 0;
  for (const s of contour) {
    area += (s.from.x * s.to.y - s.to.x * s.from.y) / 2;
    if (s.bulge !== 0) {
      const theta = 4 * Math.atan(Math.abs(s.bulge)); // the arc's sweep
      const chord = Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);
      const r = chord / (2 * Math.sin(theta / 2));
      // A positive bulge turns counter-clockwise, so its arc lies to the right
      // of the chord and adds area on a counter-clockwise loop.
      area += Math.sign(s.bulge) * (r * r / 2) * (theta - Math.sin(theta));
    }
  }
  return area;
}

/** Reverse a closed contour that runs clockwise; open contours are left as drawn. */
export function orientCounterClockwise(contour: CncSegment[]): CncSegment[] {
  if (contour.length === 0) return contour;
  const head = contour[0]!.from;
  const tail = contour[contour.length - 1]!.to;
  const closed = Math.hypot(head.x - tail.x, head.y - tail.y) < CHAIN_TOL;
  if (!closed || signedArea(contour) >= 0) return contour;
  return [...contour].reverse().map((s) => ({ from: s.to, to: s.from, bulge: -s.bulge }));
}

/**
 * Group segments into connected contours by tracing endpoint connectivity.
 * Segments are chained so that seg[i].to ≈ seg[i+1].from within each group.
 * Segments may be reversed if needed to maintain chain continuity.
 */
function groupContours(segments: CncSegment[]): CncSegment[][] {
  if (segments.length === 0) return [];

  const TOL = CHAIN_TOL;
  const used = new Array(segments.length).fill(false);
  const groups: CncSegment[][] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const chain: CncSegment[] = [segments[start]!];

    // Extend forward: find a segment whose start matches chain tail
    let changed = true;
    while (changed) {
      changed = false;
      const tail = chain[chain.length - 1]!.to;
      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        const s = segments[i]!;
        const dxF = s.from.x - tail.x;
        const dyF = s.from.y - tail.y;
        if (dxF * dxF + dyF * dyF < TOL * TOL) {
          chain.push(s);
          used[i] = true;
          changed = true;
          break;
        }
        // Try reversed
        const dxR = s.to.x - tail.x;
        const dyR = s.to.y - tail.y;
        if (dxR * dxR + dyR * dyR < TOL * TOL) {
          chain.push({ from: s.to, to: s.from, bulge: -s.bulge });
          used[i] = true;
          changed = true;
          break;
        }
      }
    }

    // Extend backward: find a segment whose end matches chain head
    changed = true;
    while (changed) {
      changed = false;
      const head = chain[0]!.from;
      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        const s = segments[i]!;
        const dxT = s.to.x - head.x;
        const dyT = s.to.y - head.y;
        if (dxT * dxT + dyT * dyT < TOL * TOL) {
          chain.unshift(s);
          used[i] = true;
          changed = true;
          break;
        }
        // Try reversed
        const dxR = s.from.x - head.x;
        const dyR = s.from.y - head.y;
        if (dxR * dxR + dyR * dyR < TOL * TOL) {
          chain.unshift({ from: s.to, to: s.from, bulge: -s.bulge });
          used[i] = true;
          changed = true;
          break;
        }
      }
    }

    groups.push(chain);
  }

  return groups;
}
