import type { CopyPattern, CopyPatternParams, Entity } from '@/types/document';
import { gridCopies } from './gridCopy';
import { circularCopies } from './circularCopy';

/** The copies a grid or circular copy of `sourceIds` makes. */
export function patternCopies(
  entities: Entity[],
  sourceIds: string[],
  params: CopyPatternParams,
  newId?: () => string,
): Entity[] {
  return params.kind === 'grid'
    ? gridCopies(entities, sourceIds, params.countX, params.countY, params.spacingX, params.spacingY, newId)
    : circularCopies(entities, sourceIds, params.center, params.count, newId);
}

/** The patterns left once `removed` are gone: a pattern goes with its last
 *  source or its last copy. */
export function prunePatterns(patterns: CopyPattern[] | undefined, removed: Set<string>): CopyPattern[] | undefined {
  if (!patterns) return patterns;
  const out: CopyPattern[] = [];
  for (const p of patterns) {
    const sourceIds = p.sourceIds.filter((id) => !removed.has(id));
    const copyIds = p.copyIds.filter((id) => !removed.has(id));
    if (sourceIds.length && copyIds.length) out.push({ ...p, sourceIds, copyIds });
  }
  return out;
}

/** The patterns that any of `ids` belongs to, as source or copy. */
export function patternsOf(patterns: CopyPattern[] | undefined, ids: Iterable<string>): CopyPattern[] {
  const set = new Set(ids);
  return (patterns ?? []).filter((p) => p.sourceIds.some((id) => set.has(id)) || p.copyIds.some((id) => set.has(id)));
}

const fmt = (n: number) => String(Number(n.toFixed(3)));

/** A pattern in a few words, e.g. "4 × 3 grid, 20 × 15 apart". */
export function describePattern(p: CopyPatternParams): string {
  return p.kind === 'grid'
    ? `${p.countX} × ${p.countY} grid, ${fmt(p.spacingX)} × ${fmt(p.spacingY)} apart`
    : `${p.count} round (${fmt(p.center.x)}, ${fmt(p.center.y)})`;
}

/** The grid or circular copy to reopen when `ids` are copied again: the last
 *  one of that kind holding every selected shape, as source or copy. */
export function patternToEdit(
  patterns: CopyPattern[] | undefined,
  entities: Entity[],
  ids: Iterable<string>,
  kind: CopyPattern['kind'],
): CopyPattern | undefined {
  const shapes = new Set(entities.filter((e) => e.type !== 'dimension').map((e) => e.id));
  const picked = [...ids].filter((id) => shapes.has(id));
  if (picked.length === 0) return undefined;
  return (patterns ?? []).filter((p) => p.kind === kind).reverse()
    .find((p) => picked.every((id) => p.sourceIds.includes(id) || p.copyIds.includes(id)));
}
