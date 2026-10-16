import { describe, it, expect } from 'vitest';
import { importScript, importLabel, partNameFor } from './importStep';

const sha = 'ab12'.repeat(16);

describe('importScript', () => {
  it('imports the file by hash and places it on the plate', () => {
    const s = importScript({ sha256: sha, filename: 'bracket.step' });
    expect(s.split('\n')[0]).toBe(`# imported: bracket.step  (${sha.slice(0, 12)})`);
    expect(s).toContain('P = dict()');
    expect(s).toContain(`part = import_step(ASSETS["${sha}"])`);
    expect(s).toContain('part = Pos(-(bb.min.X + bb.max.X) / 2, -(bb.min.Y + bb.max.Y) / 2, -bb.min.Z) * part');
  });
});

describe('names', () => {
  it('labels the version and names a new part after the file', () => {
    expect(importLabel('bracket.step')).toBe('imported bracket.step');
    expect(partNameFor('bracket v2.STP')).toBe('bracket v2');
    expect(partNameFor('.step')).toBe('Imported part');
  });
});
