import type { Entity } from '@/types/document';
import type { CamJobConfig, CamIssue, CamTool, ToolpathMove } from '@/types/cam';
import { entityToSegments } from './entityToSegments';
import { toolpathProfile } from './toolpathProfile';
import { toolpathDrill } from './toolpathDrill';
import { toolpathPocket } from './toolpathPocket';
import { toolpathFacing } from './toolpathFacing';
import { depthPasses } from './depthPasses';
import { groupContours, isClosed, nestingDepths, orientCounterClockwise } from './contours';
import { pathLength, splitAtTabs } from './tabs';
import { gcodeEmitter } from './gcodeEmitter';
import { validateCamJob } from './validate';

export { signedArea, orientCounterClockwise } from './contours';

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
        // A loop inside another is a hole in the part (or, inside a hole, a
        // part again), so it's cut on the other side; inner loops go first,
        // so the part isn't cut free before its holes are.
        const grouped = groupContours(segments).map(orientCounterClockwise);
        const depths = nestingDepths(grouped);
        const contours = grouped
          .map((contour, i) => ({
            contour,
            depth: depths[i]!,
            side: op.cutSide === 'on' || depths[i]! % 2 === 0 ? op.cutSide : op.cutSide === 'outside' ? 'inside' as const : 'outside' as const,
          }))
          .sort((a, b) => b.depth - a.depth);

        const tabProblem = op.tabs ? checkTabs(op.tabCount, op.tabWidth, op.tabHeight, c.depth.totalDepth) : null;
        if (tabProblem) {
          buildIssues.push({ severity: 'error', message: `Operation ${opIndex + 1}: ${tabProblem}`, operationIndex: opIndex });
          break;
        }

        for (const { contour, side } of contours) {
          const { moves, startPosition, problem } = toolpathProfile(
            contour,
            c.tool.diameter,
            side,
            op.cutDirection,
            c.feedRate,
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

          let tabs: { moves: ToolpathMove[]; overTab: boolean[] } | null = null;
          if (op.tabs && isClosed(contour)) {
            const tabLength = op.tabWidth + c.tool.diameter;
            const length = pathLength(moves, startPosition);
            if (op.tabCount * tabLength >= length) {
              buildIssues.push({
                severity: 'error',
                message: `Operation ${opIndex + 1}: ${op.tabCount} tabs of ${op.tabWidth}mm don't fit round a ${length.toFixed(1)}mm path (each takes the tab width plus the tool diameter)`,
                operationIndex: opIndex,
                position: startPosition,
              });
              continue;
            }
            tabs = splitAtTabs(moves, startPosition, op.tabCount, tabLength);
          }

          const withDepth = tabs
            ? depthPasses(tabs.moves, c.depth, c.safeZ, c.plungeRate, startPosition, { overTab: tabs.overTab, height: op.tabHeight })
            : depthPasses(moves, c.depth, c.safeZ, c.plungeRate, startPosition);
          for (const m of withDepth) allToolpathMoves.push(m);
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
        for (const m of drillMoves) allToolpathMoves.push(m);
        break;
      }
      case 'pocket': {
        const segments = entityToSegments(opEntities, op.entityIds);
        if (segments.length === 0) break;

        const pocket = toolpathPocket(segments, c.tool.diameter, op.stepover, op.cutDirection, c.feedRate);
        if (pocket.problem) {
          buildIssues.push({
            severity: 'error',
            message: `Operation ${opIndex + 1}: ${pocket.problem}`,
            operationIndex: opIndex,
            position: pocket.startPosition,
          });
          break;
        }

        if (pocket.warning) {
          buildIssues.push({
            severity: 'warning',
            message: `Operation ${opIndex + 1}: ${pocket.warning}`,
            operationIndex: opIndex,
          });
        }
        const withDepth = depthPasses(pocket.moves, c.depth, c.safeZ, c.plungeRate, pocket.startPosition);
        for (const m of withDepth) allToolpathMoves.push(m);
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
          for (const m of withDepth) allToolpathMoves.push(m);
        }
        break;
      }
    }

    // Record operation boundary for spindle speed changes in G-code
    if (allToolpathMoves.length > moveStart) {
      operationBoundaries.push({ moveStart, spindleSpeed: c.spindleSpeed, tool: c.tool });
    }
  }

  // Toolpaths are built with Z 0 at the stock top; move them to where it is.
  const zTop = config.stock.zTop;
  if (zTop !== 0) {
    for (const [i, m] of allToolpathMoves.entries()) allToolpathMoves[i] = { ...m, z: m.z + zTop };
  }

  // Validate
  const issues = [...buildIssues, ...validateCamJob(config, allEntities, allToolpathMoves)];

  // Generate G-code only if no errors (warnings are OK)
  const hasErrors = issues.some((i) => i.severity === 'error');
  let gcode = '';
  let moveToLine: number[] = [];

  if (!hasErrors && allToolpathMoves.length > 0) {
    const safeZ = zTop + Math.max(...config.operations.map((op) => op.cutting.safeZ));
    const result = gcodeEmitter(allToolpathMoves, config.postProcessor, config.origin, operationBoundaries, {
      safeZ,
      floodCoolant: config.useFloodCoolant,
      stockTop: zTop,
    });
    gcode = result.lines.join('\n');
    moveToLine = result.moveStartLines;
  }

  return { gcode, issues, toolpath: allToolpathMoves, moveToLine };
}

/** Why these tab settings can't work, or null. */
function checkTabs(count: number, width: number, height: number, totalDepth: number): string | null {
  if (!Number.isInteger(count) || count < 1) return 'the number of tabs must be a whole number, at least 1';
  if (!(width > 0)) return 'the tab width must be more than 0';
  if (!(height > 0)) return 'the tab height must be more than 0';
  if (height >= totalDepth) return `tabs ${height}mm tall would stop a ${totalDepth}mm deep cut from cutting at all`;
  return null;
}
