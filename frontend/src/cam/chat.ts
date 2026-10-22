import type { Entity } from '@/types/document';
import type { ResolvedJob } from './resolve';
import { normalizeOverrides, toolTag } from './resolve';
import {
  type CamJobSetup,
  type CamJobV2,
  type CamMachine,
  type ChatTurn,
  type LibraryTool,
  type OverrideKey,
  type PlanOperation,
  type SetupField,
  type SetupPrev,
  type StockPoint,
  MATERIALS,
  OVERRIDE_KEYS,
  isMaterial,
  newId,
  presetFor,
} from './setup';

/**
 * The CAM assistant's side of the conversation. What goes to it (the shapes,
 * the setup, the machine, the tools, the plan with its resolved values), and
 * what comes back: a reply that is checked here, field by field, before it
 * touches the job. Unknown shapes, tools and operations are dropped with a
 * note. The reply can fill in the setup and propose or edit operations, as
 * overrides with reasons; it can't change the machine, its post-processor or
 * safety settings (none of them are read from the reply), and everything it
 * sets still goes through the resolver and validate.ts like a value the user
 * typed. Its operations and edits arrive as "proposed" (an edited accepted
 * operation keeps how it was, for Reject), its setup changes wait for the
 * user to confirm them, and it can only remove its own proposals.
 */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const texts = (v: unknown, n: number, max: number) =>
  Array.isArray(v) ? v.map((x) => text(x, max)).filter((x) => x.length > 0).slice(0, n) : [];
const STOCK_POINTS = new Set<string>(['front-left', 'front-centre', 'front-right', 'centre', 'back-left', 'back-centre', 'back-right']);
const KINDS = new Set(['profile', 'pocket', 'drill', 'facing']);

export interface ChatRequestContext {
  setup: Record<string, unknown>;
  machine: Record<string, unknown>;
  materials: { id: string; name: string }[];
  tools: Record<string, unknown>[];
  presets: Record<string, unknown>[];
  plan: Record<string, unknown>[];
  issues: { severity: string; message: string; opId?: string }[];
  focus_op_id: string | null;
}

/** What the assistant is told about the job. The machine goes as facts to plan with, not settings it can change. */
export function buildChatContext(
  job: CamJobV2,
  machine: CamMachine,
  tools: LibraryTool[],
  resolved: ResolvedJob,
  issues: { severity: string; message: string; opId?: string }[],
  focusOpId: string | null,
): ChatRequestContext {
  const s = job.setup;
  return {
    setup: {
      material: s.material,
      stock: { width: resolved.stock.width, height: resolved.stock.height, thickness: s.stock.thickness, widthSet: s.stock.width !== null, heightSet: s.stock.height !== null },
      origin: s.origin,
      zZero: s.zZero,
      clamps: s.clamps.map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height, zHeight: c.zHeight })),
      spoilboardAllowance: machine.spoilboardAllowance,
    },
    machine: {
      name: machine.name,
      travel: machine.travel,
      maxRpm: machine.maxRpm,
      spindle: machine.spindle.kind === 'dial' ? { kind: 'dial', dial: machine.spindle.dial } : { kind: 'gcode' },
      rapidRate: machine.rapidRate,
      toolChange: machine.toolChange,
      safeZ: machine.safeZ,
      clearanceZ: machine.clearanceZ,
    },
    materials: MATERIALS.map((m) => ({ id: m.id, name: m.name })),
    tools: tools.map((t) => ({ id: t.id, tag: toolTag(t), number: t.number, name: t.name, type: t.type, diameter: t.diameter, flutes: t.flutes, fluteLength: t.fluteLength })),
    presets: tools.map((t) => {
      const p = presetFor(t, s.material, machine.presets);
      return { toolId: t.id, material: s.material, rpm: p.rpm, chipLoad: p.chipLoad, depthPerPass: p.depthPerPass, stepover: p.stepover, plungePercent: p.plungePercent, rampAngle: p.rampAngle };
    }),
    plan: resolved.ops.map((r, i) => ({
      id: r.op.id,
      number: i + 1,
      kind: r.op.kind,
      entityIds: r.op.entityIds,
      cutSide: r.op.cutSide,
      status: r.op.status,
      overrides: r.op.overrides,
      resolved: Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, f.value])),
      feed: Math.round(r.feed),
      problem: r.problem,
    })),
    issues: issues.slice(0, 30),
    focus_op_id: focusOpId,
  };
}

export interface ChatApplied {
  job: CamJobV2;
  /** The AI's turn for the thread. */
  turn: ChatTurn;
  /** What was dropped or changed on the way in. */
  notes: string[];
  /** Operations it added or edited (proposed). */
  touched: string[];
}

/**
 * Apply an assistant reply to the job. Anything malformed is left out, never
 * thrown: a garbage reply gives the job back unchanged with a note.
 */
/**
 * The AI's summary and answer as one message, without saying a thing twice:
 * an answer sentence the summary already has is left out.
 */
export function replyText(summary: string, answer: string): string {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
  const sentences = (s: string) => s.match(/[^.!?]+[.!?]*\s*/g) ?? [];
  const said = new Set(sentences(summary).map(key));
  if (key(answer).includes(key(summary))) return answer;
  const rest = sentences(answer).filter((x) => !said.has(key(x))).join('').trim();
  return [summary, rest].filter(Boolean).join('\n\n');
}

export function applyCamChat(
  job: CamJobV2,
  raw: unknown,
  ctx: { entities: Entity[]; sketchOf: Map<string, string>; tools: LibraryTool[] },
): ChatApplied {
  const notes: string[] = [];
  const reply = isObj(raw) ? raw : {};
  if (!isObj(raw)) notes.push("The assistant's reply couldn't be read");

  const turn: ChatTurn = {
    role: 'ai',
    text: replyText(text(reply.summary, 1500), text(reply.answer, 4000)) || 'No answer.',
    ...(texts(reply.choices, 10, 300).length ? { choices: texts(reply.choices, 10, 300) } : {}),
    ...(texts(reply.assumptions, 10, 300).length ? { assumptions: texts(reply.assumptions, 10, 300) } : {}),
  };

  const known = new Set(ctx.entities.map((e) => e.id));
  const toolIds = new Set(ctx.tools.map((t) => t.id));
  const next: CamJobV2 = { ...job, setup: { ...job.setup, stock: { ...job.setup.stock } }, operations: job.operations.map((o) => ({ ...o, overrides: { ...o.overrides }, ai: [...o.ai] })) };
  const touched: string[] = [];

  /** Overrides from the reply, without unknown tools. */
  const overridesFrom = (rawOv: unknown, label: string) => {
    const dropped: string[] = [];
    const ov = normalizeOverrides(rawOv, dropped);
    if (dropped.length) notes.push(`${label}: left out ${dropped.join(', ')} (not a setting, or out of range)`);
    if (ov.toolId !== undefined && !toolIds.has(ov.toolId)) {
      notes.push(`${label}: the tool "${ov.toolId}" isn't in the library; left to the default`);
      delete ov.toolId;
    }
    return ov;
  };

  // ── Setup: applied, but pending until the user confirms (Undo puts back what was there) ──
  if (isObj(reply.setup)) {
    const s = reply.setup;
    const ai = new Set<SetupField>(next.setup.aiFields);
    const pending: SetupPrev = { ...next.setup.aiPending };
    const change = <K extends keyof SetupPrev>(field: K, was: SetupPrev[K], now: SetupPrev[K], apply: () => void) => {
      ai.add(field);
      if (JSON.stringify(was) === JSON.stringify(now)) return;
      if (!(field in pending)) pending[field] = was;
      apply();
    };
    const num = (v: unknown, lo: number, hi: number, field: SetupField) => {
      if (v === undefined || v === null) return null;
      if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) return v;
      notes.push(`Setup: left out ${field} ${JSON.stringify(v)} (out of range)`);
      return null;
    };
    const st = next.setup.stock;
    if (s.material !== undefined) {
      if (isMaterial(s.material)) { const m = s.material; change('material', next.setup.material, m, () => { next.setup.material = m; }); } else notes.push(`Setup: "${String(s.material)}" isn't a known material`);
    }
    const th = num(s.thickness, 0.5, 200, 'thickness');
    if (th !== null) change('thickness', st.thickness, th, () => { st.thickness = th; });
    // Width and height: a number, or null for "fit the shapes".
    for (const k of ['width', 'height'] as const) {
      if (s[k] === null) change(k, st[k], null, () => { st[k] = null; });
      else { const v = num(s[k], 1, 5000, k); if (v !== null) change(k, st[k], v, () => { st[k] = v; }); }
    }
    if (s.origin !== undefined) {
      if (typeof s.origin === 'string' && STOCK_POINTS.has(s.origin)) {
        const o = { kind: 'stock' as const, point: s.origin as StockPoint };
        change('origin', next.setup.origin, o, () => { next.setup.origin = o; });
      } else notes.push('Setup: left out the origin (not a stock corner, edge or the centre)');
    }
    if (s.zZero !== undefined) {
      if (s.zZero === 'stock-top' || s.zZero === 'spoilboard') { const z = s.zZero; change('zZero', next.setup.zZero, z, () => { next.setup.zZero = z; }); } else notes.push('Setup: left out Z zero');
    }
    next.setup = { ...next.setup, stock: { ...st }, aiFields: [...ai] };
    if (Object.keys(pending).length) next.setup.aiPending = pending;
  }

  // ── New operations ──
  if (Array.isArray(reply.operations)) {
    for (const [i, o] of reply.operations.slice(0, 30).entries()) {
      const label = `Proposed operation ${i + 1}`;
      if (!isObj(o) || !KINDS.has(o.kind as string)) { notes.push(`${label}: not an operation; left out`); continue; }
      const ids = Array.isArray(o.entityIds) ? o.entityIds.filter((x): x is string => typeof x === 'string') : [];
      const good = [...new Set(ids.filter((id) => known.has(id)))];
      if (good.length < ids.length) notes.push(`${label}: ${ids.length - good.length} shape(s) aren't in the job's sketches; left out`);
      if (good.length === 0 && o.kind !== 'facing') { notes.push(`${label}: no known shapes; left out`); continue; }
      const overrides = overridesFrom(o.overrides, label);
      const op: PlanOperation = {
        id: newId('op'),
        kind: o.kind as PlanOperation['kind'],
        sketchId: ctx.sketchOf.get(good[0] ?? '') ?? next.setup.selectedSketchIds[0] ?? '',
        entityIds: good,
        cutSide: o.cutSide === 'inside' || o.cutSide === 'on' ? o.cutSide : 'outside',
        status: 'proposed',
        ...(text(o.reason, 500) ? { reason: text(o.reason, 500) } : {}),
        overrides,
        ai: Object.keys(overrides) as OverrideKey[],
      };
      next.operations.push(op);
      touched.push(op.id);
    }
  }

  const wasAccepted = new Set(job.operations.filter((o) => o.status === 'accepted' || o.aiPrev).map((o) => o.id));

  // ── Edits ──
  if (Array.isArray(reply.edits)) {
    for (const e of reply.edits.slice(0, 30)) {
      if (!isObj(e)) continue;
      const op = next.operations.find((x) => x.id === e.opId);
      if (!op) { notes.push(`An edit for an operation that doesn't exist ("${String(e.opId).slice(0, 40)}") was left out`); continue; }
      const n = next.operations.indexOf(op) + 1;
      const ov = overridesFrom(e.overrides, `Edit to operation ${n}`);
      const reset = Array.isArray(e.reset) ? e.reset.filter((k): k is OverrideKey => (OVERRIDE_KEYS as unknown[]).includes(k)) : [];
      // New shapes for it: all of them, replacing the ones it has.
      let shapes: string[] | null = null;
      if (Array.isArray(e.entityIds)) {
        const ids = e.entityIds.filter((x): x is string => typeof x === 'string');
        const good = [...new Set(ids.filter((id) => known.has(id)))];
        const unknown = new Set(ids.filter((id) => !known.has(id))).size;
        if (unknown) notes.push(`Edit to operation ${n}: ${unknown} shape(s) aren't in the job's sketches; left out`);
        if (good.length) shapes = good;
        else notes.push(`Edit to operation ${n}: none of the new shapes exist; kept its shapes`);
      }
      if (Object.keys(ov).length === 0 && reset.length === 0 && !shapes) continue;
      // An accepted operation keeps how it was, so Reject can put it back.
      if (op.status === 'accepted' && !op.aiPrev) {
        op.aiPrev = { overrides: { ...op.overrides }, ai: [...op.ai], ...(op.reason ? { reason: op.reason } : {}), entityIds: [...op.entityIds], sketchId: op.sketchId };
      }
      if (shapes) {
        op.entityIds = shapes;
        op.sketchId = ctx.sketchOf.get(shapes[0]!) ?? op.sketchId;
      }
      for (const k of reset) { delete op.overrides[k]; op.ai = op.ai.filter((x) => x !== k); }
      Object.assign(op.overrides, ov);
      op.ai = [...new Set([...op.ai, ...(Object.keys(ov) as OverrideKey[])])];
      op.status = 'proposed';
      if (text(e.reason, 500)) op.reason = text(e.reason, 500);
      if (!touched.includes(op.id)) touched.push(op.id);
    }
  }

  // ── Removals: only of its own proposals; the user removes accepted work ──
  if (Array.isArray(reply.remove)) {
    for (const id of reply.remove.slice(0, 30)) {
      const op = next.operations.find((x) => x.id === id);
      if (!op) continue;
      const n = next.operations.indexOf(op) + 1;
      // Judged by how it was before this reply: an accepted operation it just edited is still the user's.
      if (!wasAccepted.has(op.id) && !op.aiPrev) {
        next.operations = next.operations.filter((x) => x !== op);
        notes.push(`Removed proposed operation ${n}`);
      } else {
        notes.push(`The assistant suggests removing operation ${n}; remove it yourself if you agree`);
      }
    }
  }

  return { job: next, turn, notes, touched };
}

/** An accepted operation the AI edited, put back as it was (and accepted again). */
export function rejectAiEdit(op: PlanOperation): PlanOperation {
  const { aiPrev, reason: _, ...rest } = op;
  if (!aiPrev) return op;
  return {
    ...rest,
    overrides: { ...aiPrev.overrides },
    ai: [...aiPrev.ai],
    ...(aiPrev.reason ? { reason: aiPrev.reason } : {}),
    ...(aiPrev.entityIds ? { entityIds: [...aiPrev.entityIds] } : {}),
    ...(aiPrev.sketchId !== undefined ? { sketchId: aiPrev.sketchId } : {}),
    status: 'accepted',
  };
}

/** The setup with the AI's unconfirmed changes put back. */
export function undoAiSetup(setup: CamJobSetup): CamJobSetup {
  const prev = setup.aiPending;
  if (!prev) return setup;
  const { aiPending: _, ...rest } = setup;
  const out: CamJobSetup = { ...rest, stock: { ...setup.stock } };
  if (prev.material !== undefined) out.material = prev.material;
  if (prev.thickness !== undefined) out.stock.thickness = prev.thickness;
  if (prev.width !== undefined) out.stock.width = prev.width;
  if (prev.height !== undefined) out.stock.height = prev.height;
  if (prev.origin !== undefined) out.origin = prev.origin;
  if (prev.zZero !== undefined) out.zZero = prev.zZero;
  out.aiFields = out.aiFields.filter((f) => !(f in prev));
  return out;
}
