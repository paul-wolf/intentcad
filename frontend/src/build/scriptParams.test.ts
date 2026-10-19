import { describe, it, expect } from 'vitest';
import { partParams, scriptParams } from './scriptParams';

// the scripts of backend/modeling/test_paramedit.py, read the way paramedit finds them
describe('scriptParams: the paramedit fixtures', () => {
  it('dict(...) with comments around it', () => {
    expect(scriptParams("# top\nP = dict(a=1, b=2)  # keep\npart = Box(P['a'], P['b'], 1)\n"))
      .toEqual({ found: true, values: { a: 1, b: 2 }, others: [] });
  });

  it('a {...} literal', () => {
    expect(scriptParams("P = {'a': 1, 'b': 2}\npart = Box(1,1,1)").values).toEqual({ a: 1, b: 2 });
    expect(scriptParams("P = {'a': 1}\n").values).toEqual({ a: 1 });
  });

  it('ints and floats', () => {
    expect(scriptParams('P = dict(x=6)\npart = Box(1,1,1)').values).toEqual({ x: 6 });
    expect(scriptParams('P = dict(a=1, b=2, c=3)\npart = Box(1,1,1)').values).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('one entry per line, with comments', () => {
    expect(scriptParams('P = dict(\n    a=1,   # first\n    b=2.5\n)\npart = Box(1,1,1)').values)
      .toEqual({ a: 1, b: 2.5 });
  });

  it('no dict, or an empty one', () => {
    expect(scriptParams('part = Box(1,1,1)')).toEqual({ found: false, values: {}, others: [] });
    expect(scriptParams('import math\npart = Box(1,1,1)\n').found).toBe(false);
    expect(scriptParams('P = dict()\n')).toEqual({ found: true, values: {}, others: [] });
  });

  it('what add_extrude writes', () => {
    const code = 'P = dict(w=10, cut1_depth=3)\npart = Box(P[\'w\'], 10, 2)\n'
      + 'part -= extrude(sketch("Sketch 1"), amount=-P["cut1_depth"])\n';
    expect(scriptParams(code).values).toEqual({ w: 10, cut1_depth: 3 });
    expect(scriptParams('P = dict(body1_height=12)\n\npart = extrude(sketch("S"), amount=P["body1_height"])\n').values)
      .toEqual({ body1_height: 12 });
  });
});

describe('scriptParams: numbers and the rest', () => {
  it('reads negatives, exponents, underscores and a leading dot', () => {
    expect(scriptParams('P = dict(a=-3, b=+2, c=1e3, d=1_000, e=.5, f=- 4.25)').values)
      .toEqual({ a: -3, b: 2, c: 1000, d: 1000, e: 0.5, f: -4.25 });
  });

  it('skips keys that are not plain numbers', () => {
    const p = scriptParams('P = dict(a=1, b=2 * 3, name="lid, top", c=(1), d=[1, 2], e=True, f=4)');
    expect(p.values).toEqual({ a: 1, f: 4 });
    expect(p.others).toEqual(['b', 'name', 'c', 'd', 'e']);
  });

  it('takes `params` too, but only the first top-level assignment', () => {
    expect(scriptParams('params = {"floor": 3}\n').values).toEqual({ floor: 3 });
    const code = 'def f():\n    P = dict(a=99)\n\nP = dict(a=1)\nP = dict(a=2)\n';
    expect(scriptParams(code).values).toEqual({ a: 1 });
  });

  it('ignores P in strings, comparisons and later lines', () => {
    expect(scriptParams('s = """\nP = dict(a=9)\n"""\nP = dict(a=1)\n').values).toEqual({ a: 1 });
    expect(scriptParams('if P == dict(a=1): pass\n').found).toBe(false);
    expect(scriptParams('x = (\nP = 1)\n').found).toBe(false);
  });

  it('gives up when the first P isn’t a dict, as paramedit does', () => {
    expect(scriptParams('P = make_params()\nparams = dict(a=1)\n').found).toBe(false);
  });

  it('a comment with a comma or bracket inside the dict', () => {
    expect(scriptParams('P = dict(\n  a=1,  # (mm, outside)\n  b=2,\n)\n').values).toEqual({ a: 1, b: 2 });
  });
});

describe('partParams', () => {
  it('fills keys that aren’t plain numbers from the last build', () => {
    expect(partParams('P = dict(a=1, b=2 * 3)\n', { a: 7, b: 6, gone: 5 })).toEqual({ a: 1, b: 6 });
  });

  it('uses the last build’s params when there is no dict to read', () => {
    expect(partParams('P = make()\n', { a: 7 })).toEqual({ a: 7 });
    expect(partParams('part = Box(1, 1, 1)\n', null)).toEqual({});
  });
});
