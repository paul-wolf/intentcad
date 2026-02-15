import type { Entity } from '@/types/document';
import type { CamJobConfig, CamIssue, ToolpathMove } from '@/types/cam';
import { entityToSegments } from './entityToSegments';
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

        // Generate single-depth profile toolpath
        const singlePass = toolpathProfile(
          segments,
          config.tool.diameter,
          op.cutSide,
          config.machine.feedRate,
          op.tabs,
          op.tabWidth,
          op.tabHeight,
        );

        // Apply depth passes
        const withDepth = depthPasses(singlePass, config.depth, config.machine.safeZ);
        allToolpathMoves.push(...withDepth);
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

  if (!hasErrors && allToolpathMoves.length > 0) {
    const lines = gcodeEmitter(allToolpathMoves, config.postProcessor, config.origin);
    gcode = lines.join('\n');
  }

  return { gcode, issues, toolpath: allToolpathMoves };
}
