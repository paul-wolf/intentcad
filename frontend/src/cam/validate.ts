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

  for (let i = 0; i < config.operations.length; i++) {
    const op = config.operations[i]!;
    const c = op.cutting;

    // Empty operation (no entities selected) — facing doesn't require entities
    if (op.entityIds.length === 0 && op.kind !== 'facing') {
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
          const toolRadius = c.tool.diameter / 2;
          for (let si = 0; si < segments.length; si++) {
            const seg = segments[si]!;
            const nextSeg = segments[(si + 1) % segments.length]!;
            if (seg.bulge !== 0 || nextSeg.bulge !== 0) continue;
            const dx1 = seg.from.x - seg.to.x;
            const dy1 = seg.from.y - seg.to.y;
            const dx2 = nextSeg.to.x - nextSeg.from.x;
            const dy2 = nextSeg.to.y - nextSeg.from.y;
            const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
            const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
            if (len1 === 0 || len2 === 0) continue;
            const dot = (dx1 / len1) * (dx2 / len2) + (dy1 / len1) * (dy2 / len2);
            const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
            const angleDeg = angle * (180 / Math.PI);
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

      // Check tool diameter vs hole size (for drilling, equal is fine)
      for (const e of opEntities) {
        if (e.type === 'circle' && e.radius * 2 < c.tool.diameter - 0.01) {
          issues.push({
            severity: 'error',
            message: `Operation ${i + 1}: tool diameter (${c.tool.diameter}mm) is larger than hole diameter (${(e.radius * 2).toFixed(1)}mm)`,
            operationIndex: i,
            entityId: e.id,
            position: e.center,
          });
        }
      }
    }

    if (op.kind === 'pocket') {
      // Compute bounding box from entities directly (not segments, which lose arc extent)
      const bounds = entityBounds(opEntities);
      if (bounds) {
        const minDim = Math.min(bounds.width, bounds.height);
        if (c.tool.diameter > minDim) {
          issues.push({
            severity: 'error',
            message: `Operation ${i + 1}: tool diameter (${c.tool.diameter}mm) is larger than pocket minimum dimension (${minDim.toFixed(1)}mm)`,
            operationIndex: i,
          });
        }
      }
    }

    // Per-operation: depth per pass vs flute length
    if (c.depth.depthPerPass > c.tool.fluteLength) {
      issues.push({
        severity: 'warning',
        message: `Operation ${i + 1}: depth per pass (${c.depth.depthPerPass}mm) exceeds flute length (${c.tool.fluteLength}mm)`,
        operationIndex: i,
      });
    }

    // Per-operation: feed rate reasonableness
    const chipLoad = c.feedRate / (c.spindleSpeed * c.tool.fluteCount);
    if (chipLoad > 0.2) {
      issues.push({
        severity: 'info',
        message: `Operation ${i + 1}: chip load (${chipLoad.toFixed(3)}mm) seems high — verify feed rate`,
        operationIndex: i,
      });
    }
    if (chipLoad < 0.01 && c.feedRate > 0) {
      issues.push({
        severity: 'info',
        message: `Operation ${i + 1}: chip load (${chipLoad.toFixed(4)}mm) seems very low — consider increasing feed rate`,
        operationIndex: i,
      });
    }
  }

  return issues;
}

/** Compute axis-aligned bounding box from entities, accounting for circles and arcs. */
function entityBounds(entities: Entity[]): { width: number; height: number } | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let found = false;

  for (const e of entities) {
    if (e.type === 'circle') {
      minX = Math.min(minX, e.center.x - e.radius);
      maxX = Math.max(maxX, e.center.x + e.radius);
      minY = Math.min(minY, e.center.y - e.radius);
      maxY = Math.max(maxY, e.center.y + e.radius);
      found = true;
    } else if (e.type === 'line') {
      for (const p of e.points) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      found = true;
    } else if (e.type === 'rectangle') {
      const hw = e.width / 2, hh = e.height / 2;
      minX = Math.min(minX, e.center.x - hw); maxX = Math.max(maxX, e.center.x + hw);
      minY = Math.min(minY, e.center.y - hh); maxY = Math.max(maxY, e.center.y + hh);
      found = true;
    } else if (e.type === 'bezier') {
      for (const p of e.controlPoints) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      found = true;
    }
  }

  if (!found) return null;
  return { width: maxX - minX, height: maxY - minY };
}
