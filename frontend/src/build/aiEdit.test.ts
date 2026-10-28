import { describe, expect, it } from 'vitest';
import { holdAiEdit, ppReads } from './aiEdit';

const BASE = 'P = dict(t=5)\npart = Box(60, 60, P["t"])';
const EDIT = 'P = dict(t=5)\npart = Box(60, 60, P["t"]) - Cylinder(2, 10)';

describe('an AI edit when its reply comes', () => {
  it('goes in when the part is as it was and it reads no new parameter', () => {
    expect(holdAiEdit(BASE, BASE, EDIT, null)).toBeNull();
    expect(holdAiEdit(BASE, BASE, 'x = PP["thick"]', [{ name: 'boss_h' }])).toBeNull();
  });

  it('waits when the part changed meanwhile', () => {
    const mine = BASE.replace('t=5', 't=10');
    expect(holdAiEdit(BASE, mine, EDIT, null)).toEqual({ changed: true, waits: [] });
  });

  it('waits for the project parameters it proposed and reads', () => {
    const code = 'part = Box(60, 60, PP["plate_t"]) + Box(1, 1, PP.get(\'boss_h\', 2))';
    expect(holdAiEdit(BASE, BASE, code, [{ name: 'plate_t' }, { name: 'boss_h' }, { name: 'unused' }]))
      .toEqual({ changed: false, waits: ['plate_t', 'boss_h'] });
    expect(ppReads(code + '\nx = PP["plate_t"]')).toEqual(['plate_t', 'boss_h']);
  });
});
