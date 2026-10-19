/**
 * Client-side (IndexedDB) cache of build123d build results, keyed by a hash of
 * the model code. A build123d script is deterministic — same code, same mesh —
 * so an unchanged part can re-open instantly without hitting the engine.
 *
 * Bump CACHE_VERSION whenever the engine's output shape changes so stale meshes
 * are never served.
 */
import { db, type CachedBuild } from '@/api/db';
import type { RunResponse, DimInfo } from '@/api/client';

const CACHE_VERSION = 'v3';   // v3: face sketches' face outlines (RunResponse.sketches[name].outline)
const MAX_ENTRIES = 40;

/** cyrb53 — a fast, well-distributed string hash (returns a hex-ish string). */
function hash(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

export function buildKey(code: string): string {
  return `${CACHE_VERSION}:${hash(code)}`;
}

export async function getCachedBuild(key: string): Promise<{ run: RunResponse; sens?: Record<string, DimInfo> } | null> {
  try {
    const row = await db.buildCache.get(key);
    if (!row) return null;
    db.buildCache.update(key, { at: Date.now() }).catch(() => {});   // touch (LRU)
    return { run: row.run as RunResponse, sens: row.sens as Record<string, DimInfo> | undefined };
  } catch {
    return null;
  }
}

export async function putCachedBuild(key: string, run: RunResponse): Promise<void> {
  try {
    await db.buildCache.put({ key, run, at: Date.now() } as CachedBuild);
    void evict();
  } catch { /* cache is best-effort */ }
}

/** Attach the sensitivity map to an existing cache entry (same code). */
export async function putCachedSens(key: string, sens: Record<string, DimInfo>): Promise<void> {
  try { await db.buildCache.update(key, { sens }); } catch { /* ignore */ }
}

/** Keep the cache bounded: drop the least-recently-used entries. */
async function evict(): Promise<void> {
  try {
    const count = await db.buildCache.count();
    if (count <= MAX_ENTRIES) return;
    const oldest = await db.buildCache.orderBy('at').limit(count - MAX_ENTRIES).primaryKeys();
    await db.buildCache.bulkDelete(oldest);
  } catch { /* ignore */ }
}
