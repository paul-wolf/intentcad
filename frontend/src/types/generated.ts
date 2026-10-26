/**
 * A generated sketch: a sketch document whose one sketch is made by code
 * (backend modeling/generated_sketch.py). The server runs the code and keeps
 * the result in the sketch (`profile`, `entities`, `groups`) and the run
 * record in `sketch.generated`.
 */
import type { Sketch } from './document';

export interface GenOutput {
  name: string;
  description: string;
  kind: 'holes' | 'points' | 'shapes' | 'lines';
  count: number;
  /** in words: "36 holes Ø3.4", "239 × 248 mm", "4 points" */
  size: string;
}

export interface GenCheck {
  name: string;
  ok: boolean;
  message: string;
  /** the output it is about (clicking the check shows it) */
  output?: string;
}

/** Points are sketch (x, y): y points down the screen. */
export interface GenAnnotations {
  labels: { text: string; at: [number, number] }[];
  dims: { p1: [number, number]; p2: [number, number]; text: string }[];
}

export interface GenError {
  message: string;
  line: number | null;
}

/** sketch.generated: the last run. On an error the outputs, checks and
 *  annotations are the last good run's. */
export interface GenRecord {
  outputs: GenOutput[];
  checks: GenCheck[];
  annotations: GenAnnotations;
  /** the project parameters the code read, at the values it read */
  reads: Record<string, number | string>;
  error: GenError | null;
  ran_at: number;
}

/** A run that saves nothing (POST /api/sketches/{id}/run). */
export type GenRunResult =
  | { ok: true; profile: Record<string, unknown>; entities: Sketch['entities']; outputs: GenOutput[];
      checks: GenCheck[]; annotations: GenAnnotations; reads: Record<string, number | string> }
  | { ok: false; error: string; line: number | null; reads: Record<string, number | string> };

/** An output parts use that a change would no longer make. */
export interface BrokenOutput {
  name: string;
  parts: string[];
}

export interface CodeVersion {
  code: string;
  at: number;
  label: string;
}

/** A generated sketch document as the server sends it. */
export interface GenDoc {
  id: string;
  name: string;
  updated_at: string;
  project_id?: string | null;
  data: {
    name: string;
    source: 'generated';
    code: string;
    codeHistory?: CodeVersion[];
    sketches: (Sketch & { generated?: GenRecord })[];
    activeSketchId: string;
    chat?: unknown[];
    [key: string]: unknown;
  };
}
