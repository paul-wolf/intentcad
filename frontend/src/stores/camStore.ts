import { create } from 'zustand';
import type { Entity, Point } from '@/types/document';
import type {
  CamJobConfig,
  CamIssue,
  ClampZone,
  ToolpathMove,
  CamProfileSummary,
  CamJobSummary,
} from '@/types/cam';
import { createDefaultJobConfig } from '@/types/cam';
import { generateGcode } from '@/cam/generate';
import { moveLength, interpolateMove } from '@/cam/simulatorInterp';
import {
  type ResolvedJob,
  allTools,
  cuttingOrder,
  loadJob,
  newPlanOperation,
  resolveJob,
} from '@/cam/resolve';
import {
  type CamJobSetup,
  type CamJobV2,
  type CamMachine,
  type OpOverrides,
  type OverrideKey,
  type PlanOperation,
  type SetupField,
  createDefaultJob,
  createDefaultMachine,
  newId,
} from '@/cam/setup';
import { normalizeMachine, machineProfileConfig } from '@/cam/machine';
import { applyCamChat, buildChatContext, rejectAiEdit, undoAiSetup } from '@/cam/chat';
import { estimateSeconds, type OpRange } from '@/cam/estimate';
import { downloadGcode } from '@/export/gcode';
import { camApi } from '@/api/camClient';
import { getBackendId } from '@/api/autoSave';
import { useDocumentStore } from './documentStore';
import { addLog } from './logStore';

export type CamStep = 'setup' | 'plan' | 'run';
export type CamIssueWithOp = CamIssue & { opId?: string };

interface CamStore {
  // ── Job state ──
  activeJobId: string | null;
  /** The saved job: setup, the plan's operations (overrides only), the AI thread. */
  job: CamJobV2;
  /** The machine the job runs on (from its CAM profile, or the built-in default). */
  machine: CamMachine;
  /** The job worked out against the machine: every operation's values and where they came from. */
  resolved: ResolvedJob;
  /** What the toolpath code, the canvas and the simulator read: built from `resolved`. */
  jobConfig: CamJobConfig;
  generatedGcode: string | null;
  toolpath: ToolpathMove[] | null;
  /** Problems from the plan and the toolpaths, with the operation they belong to. */
  issues: CamIssueWithOp[];
  /** Where each operation's moves are in the toolpath. */
  opRanges: OpRange[];
  estimatedSeconds: number;
  showToolpathPreview: boolean;
  camPanelOpen: boolean;
  step: CamStep;
  /** The operation whose shapes and toolpath are highlighted (and that canvas clicks assign to). */
  focusedOpId: string | null;
  /** The operation open in the editor. */
  openedOpId: string | null;
  pickingOrigin: boolean;
  drawingClamp: boolean;
  /** The box being dragged out for a new clamp. */
  drawingClampRect: { x: number; y: number; width: number; height: number } | null;
  aiBusy: boolean;
  aiError: string | null;

  // ── Simulator state ──
  simState: 'idle' | 'playing' | 'paused';
  simMoveIndex: number;
  simProgress: number;
  simSpeed: number;
  simPosition: Point | null;
  simZ: number | null;
  simGcodeLineMap: number[];

  // ── Cached server data ──
  /** CAM profiles: each holds one machine. */
  profiles: CamProfileSummary[];
  jobs: CamJobSummary[];
  jobName: string;

  // ── Jobs ──
  loadProfiles(): Promise<void>;
  loadJobs(documentId: string): Promise<void>;
  createJob(documentId: string, name: string): Promise<void>;
  openJob(jobId: string): Promise<void>;
  saveJob(): Promise<void>;
  deleteJob(jobId: string): Promise<void>;
  renameJob(name: string): Promise<void>;

  // ── Machine ──
  selectMachine(profileId: string | null): Promise<void>;
  /** Save the machine: to its profile, or as a new one (then the job uses it). */
  saveMachine(machine: CamMachine, asNew?: boolean): Promise<boolean>;

  // ── Setup ──
  updateSetup(patch: Partial<CamJobSetup>, fields?: SetupField[]): void;
  setStep(step: CamStep): void;
  setPickingOrigin(picking: boolean): void;
  setOrigin(point: Point): void;
  setDrawingClamp(drawing: boolean): void;
  setDrawingClampRect(rect: { x: number; y: number; width: number; height: number } | null): void;
  addClamp(rect: { x: number; y: number; width: number; height: number }): void;
  updateClamp(id: string, patch: Partial<ClampZone>): void;
  removeClamp(id: string): void;

  // ── Plan ──
  addOperation(kind: PlanOperation['kind'], entityIds?: string[]): void;
  updateOperation(id: string, patch: Partial<Pick<PlanOperation, 'kind' | 'cutSide' | 'entityIds'>>): void;
  setOverride<K extends OverrideKey>(id: string, key: K, value: OpOverrides[K]): void;
  resetOverride(id: string, key: OverrideKey): void;
  acceptOperation(id: string): void;
  acceptAll(): void;
  /** Put an accepted operation the AI edited back as it was. */
  rejectOperation(id: string): void;
  /** Keep the AI's setup changes. */
  confirmSetupChanges(): void;
  /** Put back the setup values from before the AI's changes. */
  undoSetupChanges(): void;
  removeOperation(id: string): void;
  moveOperation(id: string, direction: -1 | 1): void;
  autoOrder(): void;
  focusOperation(id: string | null): void;
  openOperation(id: string | null): void;
  assignSelectedEntities(entityIds: string[]): void;
  setOperationEntities(entityIds: string[]): void;

  /** Resolve the job and rebuild the toolpath (after any change to the job, the machine or the shapes). */
  recompute(): void;
  downloadGcode(): void;

  // ── AI ──
  sendChat(message: string, focusOpId?: string | null): Promise<void>;

  simPlay(): void;
  simPause(): void;
  simStop(): void;
  simStep(): void;
  simSetSpeed(speed: number): void;
  simTick(dtMs: number): void;

  restoreSession(documentId: string): Promise<void>;
  toggleToolpathPreview(): void;
  toggleCamPanel(): Promise<void>;
  clearJob(): void;
}

/**
 * Where the program starts: the highest safe Z of any operation, above the
 * stock top (as in the G-code).
 */
function getMaxSafeZ(config: CamJobConfig): number {
  if (config.operations.length === 0) return config.stock.zTop + 5;
  return config.stock.zTop + Math.max(...config.operations.map((op) => op.cutting.safeZ));
}

/** The shapes of the job's sketches. */
export function jobEntities(job: CamJobV2): Entity[] {
  const ids = new Set(job.setup.selectedSketchIds);
  return useDocumentStore.getState().document.sketches
    .filter((s) => ids.has(s.id) && !s.suppressed)
    .flatMap((s) => s.entities);
}

const emptyResolved = (job: CamJobV2, machine: CamMachine) => resolveJob(job, machine, []);
const SIM_RESET = { simState: 'idle' as const, simMoveIndex: 0, simProgress: 0, simPosition: null, simZ: null };

/** A machine per profile, once loaded. */
const machineCache = new Map<string, CamMachine>();

async function fetchMachine(profileId: string): Promise<CamMachine> {
  const hit = machineCache.get(profileId);
  if (hit) return hit;
  const p = await camApi.getProfile(profileId);
  const machine = normalizeMachine(p.config, typeof p.name === 'string' ? p.name : undefined);
  machineCache.set(profileId, machine);
  return machine;
}

const initialJob = createDefaultJob();
const initialMachine = createDefaultMachine();
const initialResolved = emptyResolved(initialJob, initialMachine);

export const useCamStore = create<CamStore>((set, get) => {
  /** Change the job (and re-resolve). */
  const setJob = (job: CamJobV2, extra: Partial<CamStore> = {}) => {
    set({ job, ...extra });
    get().recompute();
  };
  const mapOps = (fn: (op: PlanOperation) => PlanOperation) => {
    const { job } = get();
    setJob({ ...job, operations: job.operations.map(fn) });
  };
  const withOp = (id: string, fn: (op: PlanOperation) => PlanOperation) => mapOps((op) => (op.id === id ? fn(op) : op));

  return {
    activeJobId: null,
    job: initialJob,
    machine: initialMachine,
    resolved: initialResolved,
    jobConfig: createDefaultJobConfig(),
    generatedGcode: null,
    toolpath: null,
    issues: [],
    opRanges: [],
    estimatedSeconds: 0,
    showToolpathPreview: true,
    camPanelOpen: false,
    step: 'setup',
    focusedOpId: null,
    openedOpId: null,
    pickingOrigin: false,
    drawingClamp: false,
    drawingClampRect: null,
    aiBusy: false,
    aiError: null,
    simState: 'idle',
    simMoveIndex: 0,
    simProgress: 0,
    simSpeed: 1,
    simPosition: null,
    simZ: null,
    simGcodeLineMap: [],

    profiles: [],
    jobs: [],
    jobName: '',

    async loadProfiles() {
      try {
        set({ profiles: await camApi.listProfiles() });
      } catch (err) {
        addLog('error', `Failed to load machines: ${err}`);
      }
    },

    async loadJobs(documentId: string) {
      try {
        set({ jobs: await camApi.listJobs(documentId) });
      } catch (err) {
        addLog('error', `Failed to load CAM jobs: ${err}`);
      }
    },

    async createJob(documentId: string, name: string) {
      try {
        const job = createDefaultJob();
        // A new job starts on the machine and sketch the user was last using.
        const prev = get().job.setup;
        job.setup.machineId = get().activeJobId ? prev.machineId : null;
        const doc = useDocumentStore.getState().document;
        job.setup.selectedSketchIds = doc.activeSketchId ? [doc.activeSketchId] : doc.sketches.slice(0, 1).map((s) => s.id);
        const result = await camApi.createJob({ document_id: documentId, name, config: job as unknown as Record<string, unknown> });
        const machine = job.setup.machineId ? await fetchMachine(job.setup.machineId).catch(() => createDefaultMachine()) : createDefaultMachine();
        set({ activeJobId: result.id as string, jobName: name, machine, step: 'setup', focusedOpId: null, openedOpId: null, ...SIM_RESET });
        setJob(job);
        await get().loadJobs(documentId);
        addLog('info', `Created CAM job: ${name}`);
      } catch (err) {
        addLog('error', `Failed to create CAM job: ${err}`);
      }
    },

    async openJob(jobId: string) {
      try {
        const result = await camApi.getJob(jobId);
        const raw = (result.config ?? {}) as Record<string, unknown>;
        const machineId = raw.version === 2
          ? ((raw.setup as Record<string, unknown> | undefined)?.machineId as string | null | undefined) ?? null
          : (raw.profileId as string | null | undefined) ?? null;
        const machine = machineId ? await fetchMachine(machineId).catch(() => createDefaultMachine()) : createDefaultMachine();
        // An older job needs the shapes to be brought over the same.
        const sketchIds = new Set(Array.isArray(raw.selectedSketchIds) ? (raw.selectedSketchIds as string[]) : []);
        const entities = raw.version === 2 ? [] : useDocumentStore.getState().document.sketches.filter((s) => sketchIds.has(s.id)).flatMap((s) => s.entities);
        const job = loadJob(raw, machine, entities);
        if (machineId && raw.version !== 2) job.setup.machineId = machineId;
        const hasPlan = job.operations.length > 0;
        set({
          activeJobId: jobId,
          jobName: typeof result.name === 'string' ? result.name : '',
          machine,
          step: hasPlan ? 'plan' : 'setup',
          focusedOpId: null,
          openedOpId: null,
          ...SIM_RESET,
        });
        setJob(job);
        if (raw.version !== 2 && Object.keys(raw).length > 0) addLog('info', 'This job was saved by an older version: its settings were brought over (see Setup)');
        addLog('info', `Opened CAM job: ${result.name}`);
      } catch (err) {
        addLog('error', `Failed to open CAM job: ${err}`);
      }
    },

    async saveJob() {
      const { activeJobId, job } = get();
      if (!activeJobId) return;
      try {
        await camApi.updateJob(activeJobId, { config: job as unknown as Record<string, unknown> });
      } catch (err) {
        addLog('error', `Failed to save CAM job: ${err}`);
      }
    },

    async deleteJob(jobId: string) {
      try {
        await camApi.deleteJob(jobId);
        if (get().activeJobId === jobId) get().clearJob();
        set((s) => ({ jobs: s.jobs.filter((j) => j.id !== jobId) }));
        addLog('info', 'CAM job deleted');
      } catch (err) {
        addLog('error', `Failed to delete CAM job: ${err}`);
      }
    },

    async renameJob(name: string) {
      const { activeJobId } = get();
      if (!activeJobId || !name.trim()) return;
      try {
        await camApi.updateJob(activeJobId, { name: name.trim() });
        set((s) => ({ jobName: name.trim(), jobs: s.jobs.map((j) => (j.id === activeJobId ? { ...j, name: name.trim() } : j)) }));
      } catch (err) {
        addLog('error', `Failed to rename CAM job: ${err}`);
      }
    },

    async selectMachine(profileId: string | null) {
      try {
        const machine = profileId ? await fetchMachine(profileId) : createDefaultMachine();
        const { job } = get();
        set({ machine });
        setJob({ ...job, setup: { ...job.setup, machineId: profileId } });
      } catch (err) {
        addLog('error', `Failed to load the machine: ${err}`);
      }
    },

    async saveMachine(machine: CamMachine, asNew = false) {
      const { job } = get();
      const id = job.setup.machineId;
      try {
        if (id && !asNew) {
          await camApi.updateProfile(id, { name: machine.name, config: machineProfileConfig(machine) });
          machineCache.set(id, machine);
          set({ machine });
          get().recompute();
        } else {
          const docId = getBackendId();
          if (!docId) throw new Error('the sketch is not saved yet');
          const created = (await camApi.createProfile({ name: machine.name, config: machineProfileConfig(machine), document_id: docId })) as Record<string, unknown>;
          const newIdStr = created.id as string;
          machineCache.set(newIdStr, machine);
          set({ machine });
          setJob({ ...job, setup: { ...job.setup, machineId: newIdStr } });
        }
        await get().loadProfiles();
        addLog('info', `Saved machine "${machine.name}"`);
        return true;
      } catch (err) {
        addLog('error', `Failed to save the machine: ${err}`);
        return false;
      }
    },

    updateSetup(patch: Partial<CamJobSetup>, fields: SetupField[] = []) {
      const { job } = get();
      const aiFields = fields.length ? job.setup.aiFields.filter((f) => !fields.includes(f)) : job.setup.aiFields;
      // A field the user sets is theirs: no longer an AI change waiting to be confirmed.
      let aiPending = job.setup.aiPending;
      if (aiPending && fields.length) {
        aiPending = { ...aiPending };
        for (const f of fields) delete (aiPending as Record<string, unknown>)[f];
      }
      const setup: CamJobSetup = { ...job.setup, ...patch, aiFields };
      if (aiPending && Object.keys(aiPending).length) setup.aiPending = aiPending;
      else delete setup.aiPending;
      setJob({ ...job, setup });
    },

    confirmSetupChanges() {
      const { job } = get();
      if (!job.setup.aiPending) return;
      const setup = { ...job.setup };
      delete setup.aiPending;
      setJob({ ...job, setup });
    },

    undoSetupChanges() {
      const { job } = get();
      if (job.setup.aiPending) setJob({ ...job, setup: undoAiSetup(job.setup) });
    },

    setStep(step: CamStep) {
      set({ step, pickingOrigin: false, drawingClamp: false, openedOpId: step === 'plan' ? get().openedOpId : null });
      if (step !== 'run') set(SIM_RESET);
    },

    setPickingOrigin(picking: boolean) {
      set({ pickingOrigin: picking, drawingClamp: false });
    },

    setOrigin(point: Point) {
      set({ pickingOrigin: false });
      get().updateSetup({ origin: { kind: 'picked', x: point.x, y: point.y } }, ['origin']);
      addLog('info', `CAM origin set to (${point.x.toFixed(2)}, ${point.y.toFixed(2)})`);
    },

    setDrawingClamp(drawing: boolean) {
      set({ drawingClamp: drawing, drawingClampRect: null, pickingOrigin: false });
    },

    setDrawingClampRect(rect) {
      set({ drawingClampRect: rect });
    },

    addClamp(rect) {
      const { job } = get();
      const last = job.setup.clamps[job.setup.clamps.length - 1];
      const clamp: ClampZone = { id: newId('clamp'), ...rect, zHeight: last?.zHeight ?? 10 };
      set({ drawingClamp: false, drawingClampRect: null });
      get().updateSetup({ clamps: [...job.setup.clamps, clamp] }, ['clamps']);
    },

    updateClamp(id, patch) {
      const { job } = get();
      get().updateSetup({ clamps: job.setup.clamps.map((c) => (c.id === id ? { ...c, ...patch } : c)) }, ['clamps']);
    },

    removeClamp(id) {
      const { job } = get();
      get().updateSetup({ clamps: job.setup.clamps.filter((c) => c.id !== id) }, ['clamps']);
    },

    addOperation(kind, entityIds = []) {
      const { job } = get();
      const doc = useDocumentStore.getState().document;
      const sketchId = job.setup.selectedSketchIds[0] ?? doc.activeSketchId ?? '';
      const op = newPlanOperation(kind, sketchId, entityIds);
      setJob({ ...job, operations: [...job.operations, op] }, { focusedOpId: op.id });
    },

    updateOperation(id, patch) {
      withOp(id, (op) => ({ ...op, ...patch }));
    },

    setOverride(id, key, value) {
      withOp(id, (op) => ({ ...op, overrides: { ...op.overrides, [key]: value }, ai: op.ai.filter((k) => k !== key) }));
    },

    resetOverride(id, key) {
      withOp(id, (op) => {
        const overrides = { ...op.overrides };
        delete overrides[key];
        return { ...op, overrides, ai: op.ai.filter((k) => k !== key) };
      });
    },

    acceptOperation(id) {
      withOp(id, ({ aiPrev: _, ...op }) => ({ ...op, status: 'accepted' }));
    },

    acceptAll() {
      mapOps(({ aiPrev: _, ...op }) => ({ ...op, status: 'accepted' }));
    },

    rejectOperation(id) {
      withOp(id, rejectAiEdit);
    },

    removeOperation(id) {
      const { job, focusedOpId, openedOpId } = get();
      setJob(
        { ...job, operations: job.operations.filter((o) => o.id !== id) },
        { focusedOpId: focusedOpId === id ? null : focusedOpId, openedOpId: openedOpId === id ? null : openedOpId },
      );
    },

    moveOperation(id, direction) {
      const { job } = get();
      const ops = [...job.operations];
      const i = ops.findIndex((o) => o.id === id);
      const j = i + direction;
      if (i < 0 || j < 0 || j >= ops.length) return;
      [ops[i], ops[j]] = [ops[j]!, ops[i]!];
      setJob({ ...job, operations: ops });
    },

    autoOrder() {
      const { job, machine } = get();
      setJob({ ...job, operations: cuttingOrder(job, machine, jobEntities(job)) });
    },

    focusOperation(id) {
      set({ focusedOpId: id });
    },

    openOperation(id) {
      set({ openedOpId: id, focusedOpId: id ?? get().focusedOpId });
    },

    assignSelectedEntities(entityIds: string[]) {
      const { focusedOpId, job } = get();
      const op = job.operations.find((o) => o.id === focusedOpId);
      if (!op || get().step !== 'plan') return;
      const ids = [...op.entityIds];
      for (const id of entityIds) {
        const at = ids.indexOf(id);
        if (at >= 0) ids.splice(at, 1);
        else ids.push(id);
      }
      withOp(op.id, (o) => ({ ...o, entityIds: ids }));
    },

    setOperationEntities(entityIds: string[]) {
      const { focusedOpId } = get();
      if (!focusedOpId || get().step !== 'plan') return;
      withOp(focusedOpId, (o) => ({ ...o, entityIds: [...entityIds] }));
    },

    recompute() {
      const { job, machine } = get();
      const entities = jobEntities(job);
      const resolved = resolveJob(job, machine, entities);
      const config = resolved.config;
      const issues: CamIssueWithOp[] = [...resolved.issues];
      let generatedGcode: string | null = null;
      let toolpath: ToolpathMove[] | null = null;
      let opRanges: OpRange[] = [];
      let moveToLine: number[] = [];
      let estimated = 0;
      if (config.operations.length > 0 && config.selectedSketchIds.length > 0) {
        const result = generateGcode(config, entities);
        generatedGcode = result.gcode || null;
        toolpath = result.toolpath.length > 0 ? result.toolpath : null;
        moveToLine = result.moveToLine;
        for (const i of result.issues) {
          const opId = i.operationIndex !== undefined ? resolved.configOpIds[i.operationIndex] : undefined;
          // Say the operation's number in the plan, not among the cuttable ones.
          let message = i.message;
          if (opId && i.operationIndex !== undefined) {
            const n = job.operations.findIndex((o) => o.id === opId) + 1;
            message = message.replace(new RegExp(`^Operation ${i.operationIndex + 1}\\b`), `Operation ${n}`);
          }
          issues.push({ ...i, message, ...(opId ? { opId } : {}) });
        }
        opRanges = result.opStarts.map((s, k) => ({
          opId: resolved.configOpIds[s.operationIndex]!,
          start: s.moveStart,
          end: result.opStarts[k + 1]?.moveStart ?? result.toolpath.length,
        }));
        const startZ = getMaxSafeZ(config);
        estimated = estimateSeconds(result.toolpath, config.origin, startZ, machine.rapidRate);
      }
      set({ resolved, jobConfig: config, generatedGcode, toolpath, issues, opRanges, simGcodeLineMap: moveToLine, estimatedSeconds: estimated, ...SIM_RESET });
    },

    downloadGcode() {
      const { generatedGcode, jobName, job, issues } = get();
      if (job.operations.some((o) => o.status === 'proposed')) {
        addLog('warn', 'Accept or remove the proposed operations first');
        return;
      }
      if (job.setup.aiPending) {
        addLog('warn', "Confirm or undo the AI's setup changes first");
        return;
      }
      if (!generatedGcode || issues.some((i) => i.severity === 'error')) {
        addLog('warn', 'Fix the errors first: no G-code was made');
        return;
      }
      const filename = (jobName || 'job').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'job';
      downloadGcode(generatedGcode, filename);
      const { activeJobId } = get();
      if (activeJobId) {
        camApi.generateJob(activeJobId, generatedGcode, issues as unknown as unknown[]).catch((err) => addLog('error', `Failed to save generated G-code: ${err}`));
      }
      addLog('info', `Downloaded ${filename}.nc`);
    },

    async sendChat(message: string, focusOpId: string | null = null) {
      const { job, machine, resolved, issues, aiBusy } = get();
      const docId = getBackendId();
      if (aiBusy || !message.trim()) return;
      const userTurn = { role: 'user' as const, text: message.trim().slice(0, 4000) };
      const withUser: CamJobV2 = { ...job, thread: [...job.thread, userTurn].slice(-40) };
      set({ aiBusy: true, aiError: null, job: withUser });
      try {
        const doc = useDocumentStore.getState().document;
        const ids = new Set(job.setup.selectedSketchIds);
        const sketches = (ids.size > 0 ? doc.sketches.filter((s) => ids.has(s.id)) : doc.sketches).filter((s) => !s.suppressed);
        const tools = allTools(machine, job.setup);
        const result = await camApi.chat({
          document_id: docId ?? '',
          message: userTurn.text,
          document_data: { name: doc.name, sketches } as unknown as Record<string, unknown>,
          context: buildChatContext(job, machine, tools, resolved, issues, focusOpId) as unknown as Record<string, unknown>,
          history: job.thread.slice(-12).map((t) => ({ role: t.role, text: t.text })),
        });
        const entities = sketches.flatMap((s) => s.entities.filter((e) => e.type !== 'dimension' && !('construction' in e && e.construction)));
        const sketchOf = new Map<string, string>();
        for (const s of sketches) for (const e of s.entities) sketchOf.set(e.id, s.id);
        const current = get().job;
        const applied = applyCamChat(current, result.reply, { entities, sketchOf, tools });
        const notes = [...(Array.isArray(result.notes) ? result.notes.filter((n): n is string => typeof n === 'string') : []), ...applied.notes];
        const turn = notes.length ? { ...applied.turn, assumptions: [...(applied.turn.assumptions ?? []), ...notes.map((n) => `Note: ${n}`)] } : applied.turn;
        // If the AI picked the sketches, keep them; a job with none gets the one it used.
        const next: CamJobV2 = { ...applied.job, thread: [...applied.job.thread, turn].slice(-40) };
        if (next.setup.selectedSketchIds.length === 0 && sketches[0]) next.setup = { ...next.setup, selectedSketchIds: [sketches[0].id] };
        set({ aiBusy: false });
        setJob(next, applied.touched[0] ? { focusedOpId: applied.touched[0] } : {});
        for (const n of notes) addLog('warn', `AI: ${n}`);
      } catch (err) {
        let msg = err instanceof Error ? err.message : String(err);
        // "API 422: {"message": "..."}" from the server: just the message.
        const m = /^API \d+: (\{.*\})$/s.exec(msg);
        if (m) {
          try {
            const body = JSON.parse(m[1]!) as { message?: unknown; detail?: unknown };
            const said = body.message ?? body.detail;
            if (typeof said === 'string' && said) msg = said;
          } catch { /* keep it as it came */ }
        }
        set({ aiBusy: false, aiError: msg });
        addLog('error', `CAM assistant failed: ${msg}`);
      }
    },

    simPlay() {
      const { toolpath, simState } = get();
      if (!toolpath || toolpath.length === 0) return;
      if (simState === 'idle') {
        const origin = get().jobConfig.origin;
        const safeZ = getMaxSafeZ(get().jobConfig);
        set({ simState: 'playing', simMoveIndex: 0, simProgress: 0, simPosition: { ...origin }, simZ: safeZ });
      } else {
        set({ simState: 'playing' });
      }
    },

    simPause() {
      if (get().simState === 'playing') set({ simState: 'paused' });
    },

    simStop() {
      set(SIM_RESET);
    },

    simStep() {
      const { toolpath, simState, simMoveIndex } = get();
      if (!toolpath || toolpath.length === 0) return;
      if (simState === 'idle') {
        const move = toolpath[0]!;
        set({ simState: 'paused', simMoveIndex: 0, simProgress: 1, simPosition: { ...move.to }, simZ: move.z });
        return;
      }
      const nextIndex = simMoveIndex + 1;
      if (nextIndex >= toolpath.length) {
        set(SIM_RESET);
        return;
      }
      const move = toolpath[nextIndex]!;
      set({ simState: 'paused', simMoveIndex: nextIndex, simProgress: 1, simPosition: { ...move.to }, simZ: move.z });
    },

    simSetSpeed(speed: number) {
      set({ simSpeed: speed });
    },

    simTick(dtMs: number) {
      const { simState, toolpath, simMoveIndex, simProgress, simSpeed } = get();
      if (simState !== 'playing' || !toolpath || toolpath.length === 0) return;

      const origin = get().jobConfig.origin;
      const clampedDt = Math.min(dtMs, 50);

      let startPos = { ...origin };
      let startZ = getMaxSafeZ(get().jobConfig);
      for (let i = 0; i < simMoveIndex; i++) {
        startPos = toolpath[i]!.to;
        startZ = toolpath[i]!.z;
      }

      let maxFeed = 0;
      for (const m of toolpath) {
        if ((m.kind === 'linear' || m.kind === 'arc') && m.feed > maxFeed) maxFeed = m.feed;
      }
      const rapidRate = Math.min(Math.max(maxFeed * 3, 1500), 5000);

      let remainingTime = clampedDt / 1000;
      let moveIdx = simMoveIndex;
      let progress = simProgress;
      let from = startPos;
      let fromZ = startZ;

      while (remainingTime > 0 && moveIdx < toolpath.length) {
        const move = toolpath[moveIdx]!;
        if (move.kind === 'dwell') {
          // A pause: progress is the share of its time gone by.
          const duration = move.seconds / simSpeed;
          const left = duration * (1 - progress);
          if (duration <= 0 || remainingTime >= left) {
            remainingTime -= Math.max(left, 0);
            moveIdx++;
            progress = 0;
            from = move.to;
            fromZ = move.z;
          } else {
            progress += remainingTime / duration;
            remainingTime = 0;
          }
          continue;
        }
        let feedRate = move.kind === 'linear' || move.kind === 'arc' ? move.feed : rapidRate;
        if (feedRate <= 0) feedRate = rapidRate;
        const speed = (feedRate / 60) * simSpeed;

        const len = moveLength(from, move, fromZ);
        if (len <= 0) {
          moveIdx++;
          progress = 0;
          from = move.to;
          fromZ = move.z;
          continue;
        }

        const remainingDist = len * (1 - progress);
        const timeForRemaining = remainingDist / speed;

        if (remainingTime >= timeForRemaining) {
          remainingTime -= timeForRemaining;
          moveIdx++;
          progress = 0;
          from = move.to;
          fromZ = move.z;
        } else {
          const distAdvanced = remainingTime * speed;
          progress += distAdvanced / len;
          remainingTime = 0;
        }
      }

      if (moveIdx >= toolpath.length) {
        set(SIM_RESET);
        return;
      }

      const move = toolpath[moveIdx]!;
      const pos = interpolateMove(from, move, progress);
      let z = move.z;
      if (moveIdx > 0 && progress < 1) {
        const prevZ = toolpath[moveIdx - 1]!.z;
        if (prevZ !== move.z) z = prevZ + progress * (move.z - prevZ);
      }
      set({ simMoveIndex: moveIdx, simProgress: progress, simPosition: pos, simZ: z });
    },

    async restoreSession(documentId: string) {
      try {
        const raw = localStorage.getItem(`cam:${documentId}`);
        if (!raw) return;
        const { activeJobId, camPanelOpen } = JSON.parse(raw) as { activeJobId?: string; camPanelOpen?: boolean };
        if (!camPanelOpen) return;
        set({ camPanelOpen: true });
        get().loadProfiles();
        get().loadJobs(documentId);
        if (activeJobId) await get().openJob(activeJobId);
      } catch {
        // corrupted localStorage — ignore
      }
    },

    toggleToolpathPreview() {
      set((s) => ({ showToolpathPreview: !s.showToolpathPreview }));
    },

    async toggleCamPanel() {
      const opening = !get().camPanelOpen;
      set({ camPanelOpen: opening, pickingOrigin: false, drawingClamp: false, ...SIM_RESET });
      addLog('info', opening ? 'Entered CAM mode' : 'Exited CAM mode');
      if (!opening) return;
      get().loadProfiles();
      const docId = getBackendId();
      if (!docId) return;
      await get().loadJobs(docId);
      if (get().activeJobId) {
        get().recompute();
        return;
      }
      const existing = get().jobs;
      if (existing.length > 0) await get().openJob(existing[0]!.id);
      else await get().createJob(docId, 'Job 1');
    },

    clearJob() {
      const job = createDefaultJob();
      const machine = createDefaultMachine();
      set({
        activeJobId: null,
        jobName: '',
        job,
        machine,
        resolved: emptyResolved(job, machine),
        jobConfig: createDefaultJobConfig(),
        generatedGcode: null,
        toolpath: null,
        issues: [],
        opRanges: [],
        estimatedSeconds: 0,
        step: 'setup',
        focusedOpId: null,
        openedOpId: null,
        pickingOrigin: false,
        drawingClamp: false,
        aiError: null,
        simGcodeLineMap: [],
        ...SIM_RESET,
      });
    },
  };
});

// ── Auto-save: debounce job changes to the server ──
let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

useCamStore.subscribe((state, prev) => {
  if (!state.activeJobId || state.activeJobId !== prev.activeJobId) return;
  if (state.job === prev.job) return;
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    useCamStore.getState().saveJob();
  }, 1000);
});

// ── Shapes changed (undo, another tab's save): work the job out again ──
useDocumentStore.subscribe((state, prev) => {
  if (state.document === prev.document) return;
  if (useCamStore.getState().camPanelOpen) useCamStore.getState().recompute();
});

// ── Persist CAM session to localStorage ──
let _lastDocId: string | null = null;
export function setCamDocumentId(docId: string) { _lastDocId = docId; }

useCamStore.subscribe((state, prev) => {
  if (!_lastDocId) return;
  if (state.camPanelOpen === prev.camPanelOpen && state.activeJobId === prev.activeJobId) return;
  try {
    localStorage.setItem(`cam:${_lastDocId}`, JSON.stringify({ activeJobId: state.activeJobId, camPanelOpen: state.camPanelOpen }));
  } catch { /* storage off */ }
});
