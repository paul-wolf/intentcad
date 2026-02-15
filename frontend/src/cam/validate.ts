import type { Entity } from '@/types/document';
import type { CamJobConfig, CamIssue, ToolpathMove } from '@/types/cam';
import { entityToSegments } from './entityToSegments';

/**
 * Validate a CAM job config and toolpath for issues before G-code generation.
 * Returns a list of CamIssue items (errors, warnings, info).
 */
export function validateCamJob(
  config: CamJobConfig,
  entities: Entity[],
  _toolpath: ToolpathMove[],
): CamIssue[] {
  const issues: CamIssue[] = [];

  // Check each operation
  for (let i = 0; i < config.operations.length; i++) {
    const op = config.operations[i]!;

    // Empty operation (no entities selected)
    if (op.entityIds.length === 0) {
      issues.push({
        severity: 'warning',
        message: `Operation ${i + 1} (${op.kind}): no entities selected`,
        operationIndex: i,
      });
      continue;
    }

    const opEntities = entities.filter((e) => op.entityIds.includes(e.id));

    if (op.kind === 'profile') {
      // Check for unclosed profile used for inside/outside cut
      if (op.cutSide !== 'on') {
        for (const e of opEntities) {
          if (e.type === 'line' && !e.closed) {
            issues.push({
              severity: 'error',
              message: `Operation ${i + 1}: inside/outside cut requires a closed profile, but entity is open`,
              operationIndex: i,
              entityId: e.id,
              position: e.points[0],
            });
          }
        }
      }
    }

    if (op.kind === 'drill') {
      // Verify drill targets are circles
      for (const e of opEntities) {
        if (e.type !== 'circle') {
          issues.push({
            severity: 'error',
            message: `Operation ${i + 1}: drill operation requires circle entities, got ${e.type}`,
            operationIndex: i,
            entityId: e.id,
          });
        }
      }

      // Check tool diameter vs hole size
      for (const e of opEntities) {
        if (e.type === 'circle' && e.radius * 2 < config.tool.diameter) {
          issues.push({
            severity: 'error',
            message: `Operation ${i + 1}: tool diameter (${config.tool.diameter}mm) is larger than hole diameter (${(e.radius * 2).toFixed(1)}mm)`,
            operationIndex: i,
            entityId: e.id,
            position: e.center,
          });
        }
      }
    }

    if (op.kind === 'pocket') {
      // Check tool diameter vs pocket size
      const segments = entityToSegments(entities, op.entityIds);
      if (segments.length > 0) {
        const allPoints = segments.flatMap((s) => [s.from, s.to]);
        const width = Math.max(...allPoints.map((p) => p.x)) - Math.min(...allPoints.map((p) => p.x));
        const height = Math.max(...allPoints.map((p) => p.y)) - Math.min(...allPoints.map((p) => p.y));
        const minDim = Math.min(width, height);

        if (config.tool.diameter > minDim) {
          issues.push({
            severity: 'error',
            message: `Operation ${i + 1}: tool diameter (${config.tool.diameter}mm) is larger than pocket minimum dimension (${minDim.toFixed(1)}mm)`,
            operationIndex: i,
          });
        }
      }
    }
  }

  // Check depth per pass vs flute length
  if (config.depth.depthPerPass > config.tool.fluteLength) {
    issues.push({
      severity: 'warning',
      message: `Depth per pass (${config.depth.depthPerPass}mm) exceeds flute length (${config.tool.fluteLength}mm)`,
    });
  }

  // Feed rate reasonableness check
  const chipLoad = config.machine.feedRate / (config.machine.spindleSpeed * config.tool.fluteCount);
  if (chipLoad > 0.2) {
    issues.push({
      severity: 'info',
      message: `Chip load (${chipLoad.toFixed(3)}mm) seems high — verify feed rate`,
    });
  }
  if (chipLoad < 0.01 && config.machine.feedRate > 0) {
    issues.push({
      severity: 'info',
      message: `Chip load (${chipLoad.toFixed(4)}mm) seems very low — consider increasing feed rate`,
    });
  }

  return issues;
}
