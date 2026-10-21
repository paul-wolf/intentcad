import { describe, it, expect } from 'vitest';
import workspaceSrc from '../components/SketchWorkspace.tsx?raw';
import selectToolSrc from '../tools/selectTool.ts?raw';
import { OPERATIONS, OPS_KEY, RESERVED_KEYS, SKETCH_KEYS } from './operations';
import { VIEW_KEYS } from './viewOrient';

/** Every key the sketcher's handlers test for (e.key === '…'), as SKETCH_KEYS
 *  writes it (letters in capitals). */
function handledKeys(): Set<string> {
  const keys = new Set<string>();
  for (const src of [workspaceSrc, selectToolSrc]) {
    for (const m of src.matchAll(/e\.key === '([^']+)'/g)) keys.add(m[1]!.length === 1 ? m[1]!.toUpperCase() : m[1]!);
  }
  return keys;
}

describe("the sketcher's keys", () => {
  it('lists every key the sketcher handles, once', () => {
    expect(new Set(SKETCH_KEYS).size).toBe(SKETCH_KEYS.length);
    expect([...handledKeys()].filter((k) => !SKETCH_KEYS.includes(k))).toEqual([]);
  });

  it('shares with the part editor only the keys it always has (it owns the keyboard while open)', () => {
    const editor = new Set([
      ...Object.keys(RESERVED_KEYS), OPS_KEY, ...Object.keys(VIEW_KEYS),
      ...OPERATIONS.flatMap((o) => (o.shortcut ? [o.shortcut.split(' ')[0]!] : [])),
    ]);
    expect(SKETCH_KEYS.filter((k) => editor.has(k)).sort())
      .toEqual(['?', 'E', 'Escape', 'F', 'K', 'L', 'N', 'P', 'R', 'T']);
  });

  it('gives point on curve and symmetric keys of their own', () => {
    for (const k of ['@', '/']) {
      expect(SKETCH_KEYS.filter((x) => x === k)).toHaveLength(1);
      expect(handledKeys().has(k)).toBe(true);
    }
  });
});
