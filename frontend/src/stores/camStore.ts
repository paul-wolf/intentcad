import { create } from 'zustand';
import type { Entity, Point } from '@/types/document';
import type {
  CamJobConfig,
  CamIssue,
  ToolpathMove,
  CamOperation,
  CamProfileSummary,
  CamJobSummary,
  CamProfileConfig,
  OperationCuttingParams,
} from '@/types/cam';
import { createDefaultJobConfig, createDefaultCutting, migrateCamJobConfig } from '@/types/cam';
import { generateGcode } from '@/cam/generate';
import { moveLength, interpolateMove } from '@/cam/simulatorInterp';
import { downloadGcode } from '@/export/gcode';
import { camApi } from '@/api/camClient';
import { getBackendId } from '@/api/autoSave';
import { addLog } from './logStore';

interface CamStore {
  // ── Job state ──
  activeJobId: string | null;
  jobConfig: CamJobConfig;
  generatedGcode: string | null;
  toolpath: ToolpathMove[] | null;
  issues: CamIssue[];
  showToolpathPreview: boolean;
  camPanelOpen: boolean;
  focusedOperationIndex: number | null;
  pickingOrigin: boolean;

  // ── Simulator state ──
  simState: 'idle' | 'playing' | 'paused';
  simMoveIndex: number;
  simProgress: number;
  simSpeed: number;
  simPosition: Point | null;
  simZ: number | null;
  simGcodeLineMap: number[];

  // ── Cached server data ──
  profiles: CamProfileSummary[];
  jobs: CamJobSummary[];

  // ── Actions ──
  loadProfiles(): Promise<void>;
  loadJobs(documentId: string): Promise<void>;
  createJob(documentId: string, name: string): Promise<void>;
  openJob(jobId: string): Promise<void>;
  saveJob(): Promise<void>;
  deleteJob(jobId: string): Promise<void>;

  applyProfile(profileId: string): Promise<void>;
  updateJobConfig(patch: Partial<CamJobConfig>): void;
  updateOperation(index: number, patch: Partial<CamOperation>): void;
  updateOperationCutting(index: number, patch: Partial<OperationCuttingParams>): void;
  applyCuttingToAll(sourceIndex: number): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addOperation(op: any): void;
  removeOperation(index: number): void;
  moveOperation(index: number, direction: -1 | 1): void;

  assignSelectedEntities(entityIds: string[]): void;
  setOperationEntities(entityIds: string[]): void;
  setFocusedOperation(index: number | null): void;
  setPickingOrigin(picking: boolean): void;
  setOrigin(point: Point): void;

  generate(entities: Entity[]): void;
  downloadGcode(): void;

  simPlay(): void;
  simPause(): void;
  simStop(): void;
  simStep(): void;
  simSetSpeed(speed: number): void;
  simTick(dtMs: number): void;

  requestAiSuggestion(documentData: Record<string, unknown>, profileId?: string): Promise<void>;

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

export const useCamStore = create<CamStore>((set, get) => ({
  activeJobId: null,
  jobConfig: createDefaultJobConfig(),
  generatedGcode: null,
  toolpath: null,
  issues: [],
  showToolpathPreview: true,
  camPanelOpen: false,
  focusedOperationIndex: null,
  pickingOrigin: false,
  simState: 'idle',
  simMoveIndex: 0,
  simProgress: 0,
  simSpeed: 1,
  simPosition: null,
  simZ: null,
  simGcodeLineMap: [],

  profiles: [],
  jobs: [],

  async loadProfiles() {
    try {
      const profiles = await camApi.listProfiles();
      set({ profiles });
    } catch (err) {
      addLog('error', `Failed to load CAM profiles: ${err}`);
    }
  },

  async loadJobs(documentId: string) {
    try {
      const jobs = await camApi.listJobs(documentId);
      set({ jobs });
    } catch (err) {
      addLog('error', `Failed to load CAM jobs: ${err}`);
    }
  },

  async createJob(documentId: string, name: string) {
    try {
      const config = createDefaultJobConfig();
      const result = await camApi.createJob({
        document_id: documentId,
        name,
        config: config as unknown as Record<string, unknown>,
      });
      const jobId = result.id as string;
      set({
        activeJobId: jobId,
        jobConfig: config,
        generatedGcode: null,
        toolpath: null,
        issues: [],
      });
      await get().loadJobs(documentId);
      addLog('info', `Created CAM job: ${name}`);
    } catch (err) {
      addLog('error', `Failed to create CAM job: ${err}`);
    }
  },

  async openJob(jobId: string) {
    try {
      const result = await camApi.getJob(jobId);
      const config = migrateCamJobConfig(result.config ?? createDefaultJobConfig());
      set({
        activeJobId: jobId,
        jobConfig: config,
        generatedGcode: (result.gcode as string) || null,
        issues: (result.errors as CamIssue[]) || [],
        toolpath: null,
      });
      addLog('info', `Opened CAM job: ${result.name}`);
    } catch (err) {
      addLog('error', `Failed to open CAM job: ${err}`);
    }
  },

  async saveJob() {
    const { activeJobId, jobConfig } = get();
    if (!activeJobId) return;
    try {
      await camApi.updateJob(activeJobId, {
        config: jobConfig as unknown as Record<string, unknown>,
      });
    } catch (err) {
      addLog('error', `Failed to save CAM job: ${err}`);
    }
  },

  async deleteJob(jobId: string) {
    try {
      await camApi.deleteJob(jobId);
      if (get().activeJobId === jobId) {
        set({
          activeJobId: null,
          jobConfig: createDefaultJobConfig(),
          generatedGcode: null,
          toolpath: null,
          issues: [],
        });
      }
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== jobId) }));
      addLog('info', 'CAM job deleted');
    } catch (err) {
      addLog('error', `Failed to delete CAM job: ${err}`);
    }
  },

  async applyProfile(profileId: string) {
    try {
      const result = await camApi.getProfile(profileId);
      const profileConfig = result.config as unknown as CamProfileConfig;

      // Apply profile cutting params to the focused operation, or all operations if none focused
      const { focusedOperationIndex, jobConfig } = get();
      const cutting = profileConfig.cutting ?? createDefaultCutting();
      const postProcessor = profileConfig.postProcessor ?? jobConfig.postProcessor;

      if (focusedOperationIndex !== null && jobConfig.operations[focusedOperationIndex]) {
        // Apply to focused operation only
        const operations = [...jobConfig.operations];
        operations[focusedOperationIndex] = {
          ...operations[focusedOperationIndex]!,
          cutting: { ...cutting, tool: { ...cutting.tool }, depth: { ...cutting.depth } },
        };
        set({ jobConfig: { ...jobConfig, profileId, postProcessor, operations } });
        addLog('info', `Applied profile "${result.name}" to operation ${focusedOperationIndex + 1}`);
      } else {
        // Apply to all operations
        const operations = jobConfig.operations.map((op) => ({
          ...op,
          cutting: { ...cutting, tool: { ...cutting.tool }, depth: { ...cutting.depth } },
        }));
        set({ jobConfig: { ...jobConfig, profileId, postProcessor, operations } });
        addLog('info', `Applied profile "${result.name}" to all operations`);
      }
    } catch (err) {
      addLog('error', `Failed to apply CAM profile: ${err}`);
    }
  },

  updateJobConfig(patch: Partial<CamJobConfig>) {
    set((s) => ({ jobConfig: { ...s.jobConfig, ...patch } }));
  },

  updateOperation(index: number, patch: Partial<CamOperation>) {
    set((s) => {
      const operations = [...s.jobConfig.operations];
      operations[index] = { ...operations[index]!, ...patch } as CamOperation;
      return { jobConfig: { ...s.jobConfig, operations } };
    });
  },

  updateOperationCutting(index: number, patch: Partial<OperationCuttingParams>) {
    set((s) => {
      const operations = [...s.jobConfig.operations];
      const op = operations[index];
      if (!op) return s;
      const cutting = { ...op.cutting, ...patch };
      if (patch.tool) cutting.tool = { ...op.cutting.tool, ...patch.tool };
      if (patch.depth) cutting.depth = { ...op.cutting.depth, ...patch.depth };
      operations[index] = { ...op, cutting } as CamOperation;
      return { jobConfig: { ...s.jobConfig, operations } };
    });
  },

  applyCuttingToAll(sourceIndex: number) {
    set((s) => {
      const source = s.jobConfig.operations[sourceIndex];
      if (!source) return s;
      const cutting = source.cutting;
      const operations = s.jobConfig.operations.map((op) => ({
        ...op,
        cutting: { ...cutting, tool: { ...cutting.tool }, depth: { ...cutting.depth } },
      }));
      return { jobConfig: { ...s.jobConfig, operations } };
    });
    addLog('info', 'Applied cutting settings to all operations');
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addOperation(op: any) {
    const { jobConfig } = get();
    const lastOp = jobConfig.operations[jobConfig.operations.length - 1];
    const cutting = lastOp
      ? { ...lastOp.cutting, tool: { ...lastOp.cutting.tool }, depth: { ...lastOp.cutting.depth } }
      : createDefaultCutting();
    const fullOp = { ...op, cutting } as CamOperation;

    set((s) => ({
      jobConfig: {
        ...s.jobConfig,
        operations: [...s.jobConfig.operations, fullOp],
      },
    }));
    const kindLabel = op.kind === 'profile' ? '2D Contour' : op.kind === 'drill' ? 'Drill' : 'Pocket';
    addLog('info', `Added ${kindLabel} operation`);
  },

  removeOperation(index: number) {
    const op = get().jobConfig.operations[index];
    set((s) => ({
      jobConfig: {
        ...s.jobConfig,
        operations: s.jobConfig.operations.filter((_, i) => i !== index),
      },
      focusedOperationIndex: s.focusedOperationIndex === index ? null : s.focusedOperationIndex,
      toolpath: null,
      generatedGcode: null,
      issues: [],
    }));
    if (op) {
      const kindLabel = op.kind === 'profile' ? '2D Contour' : op.kind === 'drill' ? 'Drill' : 'Pocket';
      addLog('info', `Removed ${kindLabel} operation`);
    }
  },

  moveOperation(index: number, direction: -1 | 1) {
    const { jobConfig, focusedOperationIndex } = get();
    const ops = jobConfig.operations;
    const target = index + direction;
    if (target < 0 || target >= ops.length) return;
    const updated = [...ops];
    [updated[index], updated[target]] = [updated[target]!, updated[index]!];
    let newFocus = focusedOperationIndex;
    if (focusedOperationIndex === index) newFocus = target;
    else if (focusedOperationIndex === target) newFocus = index;
    set({ jobConfig: { ...jobConfig, operations: updated }, focusedOperationIndex: newFocus });
  },

  setFocusedOperation(index: number | null) {
    set({ focusedOperationIndex: index });
  },

  setPickingOrigin(picking: boolean) {
    set({ pickingOrigin: picking, focusedOperationIndex: null });
  },

  setOrigin(point: Point) {
    set((s) => ({
      jobConfig: { ...s.jobConfig, origin: point },
      pickingOrigin: false,
    }));
    addLog('info', `CAM origin set to (${point.x.toFixed(2)}, ${point.y.toFixed(2)})`);
  },

  assignSelectedEntities(entityIds: string[]) {
    const { focusedOperationIndex, jobConfig } = get();
    if (focusedOperationIndex === null) return;
    const op = jobConfig.operations[focusedOperationIndex];
    if (!op) return;
    const existing = new Set(op.entityIds);
    const updated = [...op.entityIds];
    for (const id of entityIds) {
      if (existing.has(id)) {
        const idx = updated.indexOf(id);
        if (idx >= 0) updated.splice(idx, 1);
      } else {
        updated.push(id);
      }
    }
    const operations = [...jobConfig.operations];
    operations[focusedOperationIndex] = { ...op, entityIds: updated } as CamOperation;
    set({ jobConfig: { ...jobConfig, operations } });
  },

  setOperationEntities(entityIds: string[]) {
    const { focusedOperationIndex, jobConfig } = get();
    if (focusedOperationIndex === null) return;
    const op = jobConfig.operations[focusedOperationIndex];
    if (!op) return;
    const operations = [...jobConfig.operations];
    operations[focusedOperationIndex] = { ...op, entityIds: [...entityIds] } as CamOperation;
    set({ jobConfig: { ...jobConfig, operations } });
  },

  generate(entities: Entity[]) {
    const { jobConfig, activeJobId } = get();

    if (jobConfig.operations.length === 0) {
      addLog('warn', 'Cannot generate: no operations defined');
      return;
    }

    const hasEntities = jobConfig.operations.some((op) => op.entityIds.length > 0);
    if (!hasEntities) {
      addLog('warn', 'Cannot generate: no entities assigned to any operation');
      return;
    }

    if (jobConfig.selectedSketchIds.length === 0) {
      addLog('warn', 'Cannot generate: no sketches selected');
      return;
    }

    addLog('info', `Generating G-code for ${jobConfig.operations.length} operation(s)...`);

    const result = generateGcode(jobConfig, entities);
    set({
      generatedGcode: result.gcode || null,
      toolpath: result.toolpath.length > 0 ? result.toolpath : null,
      issues: result.issues,
      simGcodeLineMap: result.moveToLine,
      simState: 'idle',
      simMoveIndex: 0,
      simProgress: 0,
      simPosition: null,
      simZ: null,
    });

    if (activeJobId && result.gcode) {
      camApi.generateJob(activeJobId, result.gcode, result.issues as unknown as unknown[]).catch((err) => {
        addLog('error', `Failed to save generated G-code: ${err}`);
      });
    }

    if (result.issues.length > 0) {
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      const warnings = result.issues.filter((i) => i.severity === 'warning').length;
      addLog(errors > 0 ? 'warn' : 'info',
        `G-code generation: ${errors} error(s), ${warnings} warning(s)`);
    }
    if (result.gcode) {
      const lineCount = result.gcode.split('\n').length;
      addLog('info', `Generated ${lineCount} lines of G-code`);
    } else if (!result.issues.some((i) => i.severity === 'error')) {
      addLog('warn', 'G-code generation produced no output');
    }
  },

  downloadGcode() {
    const { generatedGcode, activeJobId } = get();
    if (!generatedGcode) {
      addLog('warn', 'Nothing to download — generate G-code first');
      return;
    }
    const filename = activeJobId ? `job_${activeJobId.slice(0, 8)}` : 'output';
    downloadGcode(generatedGcode, filename);
    addLog('info', `Downloaded ${filename}.nc`);
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
    if (get().simState === 'playing') {
      set({ simState: 'paused' });
    }
  },

  simStop() {
    set({ simState: 'idle', simMoveIndex: 0, simProgress: 0, simPosition: null, simZ: null });
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
      set({ simState: 'idle', simMoveIndex: 0, simProgress: 0, simPosition: null, simZ: null });
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
      set({ simState: 'idle', simMoveIndex: 0, simProgress: 0, simPosition: null, simZ: null });
      return;
    }

    const move = toolpath[moveIdx]!;
    const pos = interpolateMove(from, move, progress);
    let z = move.z;
    if (moveIdx > 0 && progress < 1) {
      const prevZ = toolpath[moveIdx - 1]!.z;
      if (prevZ !== move.z) {
        z = prevZ + progress * (move.z - prevZ);
      }
    }
    set({ simMoveIndex: moveIdx, simProgress: progress, simPosition: pos, simZ: z });
  },

  async requestAiSuggestion(documentData: Record<string, unknown>, profileId?: string) {
    try {
      addLog('info', 'Requesting AI cutting plan suggestion...');
      let profileConfig: Record<string, unknown> | undefined;
      if (profileId) {
        const profile = await camApi.getProfile(profileId);
        profileConfig = profile.config as Record<string, unknown>;
      }
      const result = await camApi.suggestPlan({
        document_data: documentData,
        profile_config: profileConfig,
      });
      if (result.config && Object.keys(result.config).length > 0) {
        const suggestedConfig = result.config as unknown as Partial<CamJobConfig>;
        set((s) => ({
          jobConfig: { ...s.jobConfig, ...suggestedConfig },
        }));
        addLog('info', 'AI suggestion applied to job config');
      }
      for (const note of result.notes) {
        addLog('info', `AI: ${note}`);
      }
    } catch (err) {
      addLog('error', `AI advisor failed: ${err}`);
    }
  },

  toggleToolpathPreview() {
    set((s) => ({ showToolpathPreview: !s.showToolpathPreview }));
  },

  async toggleCamPanel() {
    const opening = !get().camPanelOpen;
    if (!opening) {
      set({ simState: 'idle', simMoveIndex: 0, simProgress: 0, simPosition: null, simZ: null });
    }
    set({ camPanelOpen: opening });
    addLog('info', opening ? 'Entered CAM mode' : 'Exited CAM mode');
    if (opening && !get().activeJobId) {
      const docId = getBackendId();
      if (docId) {
        // Try to reuse the most recent job for this document
        await get().loadJobs(docId);
        const existing = get().jobs;
        if (existing.length > 0) {
          // Open the most recent job
          await get().openJob(existing[0]!.id);
        } else {
          await get().createJob(docId, `Job ${new Date().toLocaleString()}`);
        }
      }
    }
  },

  async restoreSession(documentId: string) {
    try {
      const raw = localStorage.getItem(`cam:${documentId}`);
      if (!raw) return;
      const { activeJobId, camPanelOpen } = JSON.parse(raw) as {
        activeJobId?: string;
        camPanelOpen?: boolean;
      };
      if (!camPanelOpen) return;
      set({ camPanelOpen: true });
      if (activeJobId) {
        await get().openJob(activeJobId);
      }
    } catch {
      // corrupted localStorage — ignore
    }
  },

  clearJob() {
    set({
      activeJobId: null,
      jobConfig: createDefaultJobConfig(),
      generatedGcode: null,
      toolpath: null,
      issues: [],
      simState: 'idle',
      simMoveIndex: 0,
      simProgress: 0,
      simPosition: null,
      simZ: null,
      simGcodeLineMap: [],
    });
  },
}));

// ── Auto-save: debounce jobConfig changes to server ──
let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

useCamStore.subscribe(
  (state, prev) => {
    if (!state.activeJobId) return;
    if (state.jobConfig === prev.jobConfig) return;
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => {
      useCamStore.getState().saveJob();
    }, 1000);
  },
);

// ── Persist CAM session to localStorage ──
let _lastDocId: string | null = null;
export function setCamDocumentId(docId: string) { _lastDocId = docId; }

useCamStore.subscribe(
  (state, prev) => {
    if (!_lastDocId) return;
    if (state.camPanelOpen === prev.camPanelOpen && state.activeJobId === prev.activeJobId) return;
    localStorage.setItem(`cam:${_lastDocId}`, JSON.stringify({
      activeJobId: state.activeJobId,
      camPanelOpen: state.camPanelOpen,
    }));
  },
);
