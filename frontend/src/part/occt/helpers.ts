/**
 * OCCT WASM helpers — probe once at init, cache working overloads.
 *
 * Instead of trying 5–35 constructor overloads on every call, we discover
 * the correct bindings once and reuse them.  This eliminates ~170 runtime
 * probing attempts per evaluation and makes failures explicit.
 */
import type { OC } from './init';

// ---------------------------------------------------------------------------
// TopoDS downcast helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CastFn = (shape: any) => any;

let _castWire: CastFn | null = null;
let _castFace: CastFn | null = null;
let _castEdge: CastFn | null = null;

function discoverCast(oc: OC, kind: 'Wire' | 'Face' | 'Edge'): CastFn {
  const td = oc.TopoDS;
  if (!td) return (s) => s;

  // Static methods first (most common in opencascade.js builds)
  for (const suffix of ['', '_1', '_2']) {
    const key = `${kind}${suffix}`;
    if (typeof td[key] === 'function') {
      return (s) => td[key](s);
    }
  }
  // Prototype methods (some older builds)
  if (td.prototype) {
    for (const suffix of ['', '_1', '_2']) {
      const key = `${kind}${suffix}`;
      if (typeof td.prototype[key] === 'function') {
        return (s) => td.prototype[key](s);
      }
    }
  }
  // No cast available — return identity
  return (s) => s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function castWire(oc: OC, shape: any): any {
  if (!_castWire) _castWire = discoverCast(oc, 'Wire');
  return _castWire(shape);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function castFace(oc: OC, shape: any): any {
  if (!_castFace) _castFace = discoverCast(oc, 'Face');
  return _castFace(shape);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function castEdge(oc: OC, shape: any): any {
  if (!_castEdge) _castEdge = discoverCast(oc, 'Edge');
  return _castEdge(shape);
}

// ---------------------------------------------------------------------------
// BRep_Tool static/prototype helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BRepFn = (...args: any[]) => any;

const _brepToolCache = new Map<string, BRepFn | null>();

function discoverBRepTool(oc: OC, method: string): BRepFn | null {
  const cached = _brepToolCache.get(method);
  if (cached !== undefined) return cached;

  const bt = oc.BRep_Tool;
  let fn: BRepFn | null = null;

  if (typeof bt?.[method] === 'function') {
    fn = (...args) => bt[method](...args);
  } else if (bt?.prototype && typeof bt.prototype[method] === 'function') {
    fn = (...args) => bt.prototype[method](...args);
  }

  _brepToolCache.set(method, fn);
  return fn;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function brepTriangulation(oc: OC, face: any, location: any): any {
  const fn = discoverBRepTool(oc, 'Triangulation');
  if (!fn) throw new Error('BRep_Tool.Triangulation not available');
  return fn(face, location);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function brepPolygon3D(oc: OC, edge: any, location: any): any {
  const fn = discoverBRepTool(oc, 'Polygon3D');
  if (!fn) throw new Error('BRep_Tool.Polygon3D not available');
  return fn(edge, location);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function brepPnt(oc: OC, vertex: any): any {
  const fn = discoverBRepTool(oc, 'Pnt');
  if (!fn) throw new Error('BRep_Tool.Pnt not available');
  return fn(vertex);
}

// ---------------------------------------------------------------------------
// TopExp static/prototype helpers
// ---------------------------------------------------------------------------

const _topExpCache = new Map<string, BRepFn | null>();

function discoverTopExp(oc: OC, method: string): BRepFn | null {
  const cached = _topExpCache.get(method);
  if (cached !== undefined) return cached;

  const te = oc.TopExp;
  let fn: BRepFn | null = null;

  // Try exact name, then suffixed
  for (const suffix of ['', '_1']) {
    const key = `${method}${suffix}`;
    if (typeof te?.[key] === 'function') {
      fn = (...args) => te[key](...args);
      break;
    }
    if (te?.prototype && typeof te.prototype[key] === 'function') {
      fn = (...args) => te.prototype[key](...args);
      break;
    }
  }

  _topExpCache.set(method, fn);
  return fn;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function topExpFirstVertex(oc: OC, edge: any, cumOri: boolean): any {
  const fn = discoverTopExp(oc, 'FirstVertex');
  if (!fn) throw new Error('TopExp.FirstVertex not available');
  return fn(edge, cumOri);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function topExpLastVertex(oc: OC, edge: any, cumOri: boolean): any {
  const fn = discoverTopExp(oc, 'LastVertex');
  if (!fn) throw new Error('TopExp.LastVertex not available');
  return fn(edge, cumOri);
}

// ---------------------------------------------------------------------------
// Constructor probing — discover once, cache the working overload
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CtorFn = new (...args: any[]) => any;

const _ctorCache = new Map<string, CtorFn | null>();

/**
 * Find a working constructor for `className` by trying suffixes.
 * `testArgs` are passed to the constructor; `validate` checks the result.
 * The FIRST working overload is cached and reused on subsequent calls.
 *
 * Returns the constructor function, or null if none works.
 */
export function findConstructor(
  oc: OC,
  className: string,
  suffixes: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  testArgSets: any[][],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  validate?: (obj: any) => boolean,
): CtorFn | null {
  const cacheKey = className;
  const cached = _ctorCache.get(cacheKey);
  if (cached !== undefined) return cached;

  for (const suffix of suffixes) {
    const ctor = oc[`${className}${suffix}`];
    if (typeof ctor !== 'function') continue;

    for (const args of testArgSets) {
      try {
        const obj = new ctor(...args);
        if (validate && !validate(obj)) {
          obj.delete?.();
          continue;
        }
        // Success — cache this constructor (but delete the test object)
        obj.delete?.();
        _ctorCache.set(cacheKey, ctor);
        return ctor;
      } catch {
        // Wrong overload / args
      }
    }
  }

  _ctorCache.set(cacheKey, null);
  return null;
}

/**
 * Find and cache a constructor using numeric suffix probing (1..max).
 */
export function findConstructorNumeric(
  oc: OC,
  className: string,
  max: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  testArgSets: any[][],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  validate?: (obj: any) => boolean,
): CtorFn | null {
  const suffixes = [];
  for (let i = 1; i <= max; i++) suffixes.push(`_${i}`);
  return findConstructor(oc, className, suffixes, testArgSets, validate);
}

/**
 * Find a working method name on an object by trying alternatives.
 * Returns the method name, or null if none found.
 */
export function findMethod(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  obj: any,
  candidates: string[],
): string | null {
  for (const name of candidates) {
    if (typeof obj[name] === 'function') return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reset (for testing or re-init)
// ---------------------------------------------------------------------------

export function resetCaches() {
  _castWire = null;
  _castFace = null;
  _castEdge = null;
  _brepToolCache.clear();
  _topExpCache.clear();
  _ctorCache.clear();
}
