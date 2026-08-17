import type { BuildResponse } from '@/api/client';

type Edge = BuildResponse['edges'][number];

/**
 * Resolve an edge selector to edge indices, client-side — a mirror of
 * backend/modeling/selectors.py:resolve_edges. Used only for highlighting (the
 * build itself still resolves server-side), so it can be instant and forgiving:
 * an unknown selector just highlights nothing.
 */
export function resolveEdgesLocal(selector: string, edges: Edge[]): number[] {
  const q = (selector || '').trim().toLowerCase();
  if (!q || edges.length === 0) return [];

  if (q === 'all' || q === '*') return edges.map((e) => e.index);

  if (q === 'longest' || q === 'shortest') {
    const pick = q === 'longest'
      ? (a: Edge, b: Edge) => (a.length >= b.length ? a : b)
      : (a: Edge, b: Edge) => (a.length <= b.length ? a : b);
    return [edges.reduce(pick).index];
  }

  const colon = q.indexOf(':');
  if (colon === -1) return [];
  const field = q.slice(0, colon).trim();
  const value = q.slice(colon + 1).trim();

  if (field === 'kind') return edges.filter((e) => e.kind === value).map((e) => e.index);

  if (field === 'between') {
    const [a, b] = value.split(',').map((s) => s.trim());
    if (!a || !b) return [];
    const match = (e: Edge) => {
      const fs = e.faces.map((t) => new Set(t));
      for (let i = 0; i < fs.length; i++)
        for (let j = 0; j < fs.length; j++)
          if (i !== j && fs[i]!.has(a) && fs[j]!.has(b)) return true;
      return false;
    };
    return edges.filter(match).map((e) => e.index);
  }

  if (field === 'faces') {
    const parts = value.split(',').map((s) => Number(s.trim()));
    if (parts.length !== 2 || parts.some(Number.isNaN)) return [];
    const want = new Set(parts);
    return edges
      .filter((e) => e.faceIndices.length === 2 && e.faceIndices.every((i) => want.has(i)))
      .map((e) => e.index);
  }

  return [];
}

/** Flat GL_LINES vertices for the given edge indices (from their polylines). */
export function edgeSegments(indices: number[], edges: Edge[]): number[] {
  const byIndex = new Map(edges.map((e) => [e.index, e]));
  const out: number[] = [];
  for (const idx of indices) {
    const poly = byIndex.get(idx)?.polyline;
    if (!poly || poly.length < 2) continue;
    for (let i = 0; i < poly.length - 1; i++) {
      out.push(poly[i]![0], poly[i]![1], poly[i]![2]);
      out.push(poly[i + 1]![0], poly[i + 1]![1], poly[i + 1]![2]);
    }
  }
  return out;
}
