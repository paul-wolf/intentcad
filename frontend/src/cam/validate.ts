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

      // Check for acute inside corners where tool can't reach
      if (op.cutSide === 'inside' || op.cutSide === 'outside') {
        const segments = entityToSegments(entities, op.entityIds);
        if (segments.length >= 2) {
          const toolRadius = config.tool.diameter / 2;
          for (let si = 0; si < segments.length; si++) {
            const seg = segments[si]!;
            const nextSeg = segments[(si + 1) % segments.length]!;
            // Only check straight-to-straight corners (skip arcs)
            if (seg.bulge !== 0 || nextSeg.bulge !== 0) continue;
            // Incoming direction (reversed) and outgoing direction
            const dx1 = seg.from.x - seg.to.x; // reversed incoming
            const dy1 = seg.from.y - seg.to.y;
            const dx2 = nextSeg.to.x - nextSeg.from.x; // outgoing
            const dy2 = nextSeg.to.y - nextSeg.from.y;
            const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
            const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
            if (len1 === 0 || len2 === 0) continue;
            // Interior angle at the corner
            const dot = (dx1 / len1) * (dx2 / len2) + (dy1 / len1) * (dy2 / len2);
            const angle = Math.acos(Math.max(-1, Math.min(1, dot))); // 0..PI
            const angleDeg = angle * (180 / Math.PI);
            // Warn on acute corners (< 70°) — fillet radius becomes very noticeable
            if (angleDeg < 70) {
              const filletR = toolRadius / Math.tan(angle / 2);
              issues.push({
                severity: 'warning',
                message: `Operation ${i + 1}: ${angleDeg.toFixed(0)}° corner will have ~${filletR.toFixed(1)}mm fillet from tool radius`,
                operationIndex: i,
                position: seg.to,
              });
            }
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
