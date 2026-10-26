/**
 * A number parameter's slider range: the one saved with it, or worked out
 * from its saved value (about 0.5× to 2×, rounded to round numbers), so it
 * stays put while the slider moves. See components/ParamControl.tsx.
 */

export interface ParamRange {
  min: number;
  max: number;
  step: number;
}

/** A saved range, where any of min, max, step may be blank (automatic). */
export interface SavedRange {
  min?: number | null;
  max?: number | null;
  step?: number | null;
}

/** The nearest of 1, 2, 5 × 10ⁿ at or above x. */
function niceUp(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 5, 10]) if (m * p >= x - 1e-12) return m * p;
  return 10 * p;
}

/** Round off floating-point noise from multiplying by a step. */
function clean(x: number, step: number): number {
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(x.toFixed(Math.min(digits, 10)));
}

/** A count: a whole number with no unit (arms, holes). */
export function isCount(value: number, unit: string): boolean {
  return !unit && Number.isInteger(value);
}

/** The automatic range for `value`: 42 gives 20 to 85 in steps of 0.5, 3.4
 *  gives 1.5 to 7 in 0.05, 406.4 gives 200 to 850 in 5; a count steps by 1
 *  and never goes below 1. */
export function autoRange(value: number, unit = ''): ParamRange {
  if (isCount(value, unit)) {
    const v = Math.max(1, value);
    return { min: Math.max(1, Math.floor(v / 2)), max: Math.max(Math.ceil(2 * v), v + 4), step: 1 };
  }
  const a = Math.abs(value);
  if (a < 1e-9) return { min: 0, max: 10, step: 0.1 };
  const step = niceUp(a / 100);
  const unitStep = 10 * step;
  let lo = Math.floor((a / 2) / unitStep) * unitStep;
  let hi = Math.ceil((2 * a) / unitStep) * unitStep;
  if (value < 0) [lo, hi] = [-hi, -lo];
  return { min: clean(lo, step), max: clean(hi, step), step };
}

/** The range a slider uses: the saved one, with automatic values for any blank part. */
export function sliderRange(saved: number, unit: string, range?: SavedRange | null): ParamRange {
  const auto = autoRange(saved, unit);
  const pick = (v: number | null | undefined, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
  const r = { min: pick(range?.min, auto.min), max: pick(range?.max, auto.max), step: pick(range?.step, auto.step) };
  if (r.max <= r.min) return auto;
  if (r.step <= 0) r.step = auto.step;
  return r;
}

/** `v` snapped to the slider's step (from its min), without float noise. */
export function snap(v: number, r: ParamRange): number {
  return clean(r.min + Math.round((v - r.min) / r.step) * r.step, r.step);
}
