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
} from '@/types/cam';
import { createDefaultJobConfig } from '@/types/cam';
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
  addOperation(op: CamOperation): void;
  removeOperation(index: number): void;
  moveOperation(index: number, direction: -1 | 1): void;

  assignSelectedEntities(entityIds: string[]): void;
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
      // Refresh job list
      await get().loadJobs(documentId);
      addLog('info', `Created CAM job: ${name}`);
    } catch (err) {
      addLog('error', `Failed to create CAM job: ${err}`);
    }
  },

  async openJob(jobId: string) {
    try {
      const result = await camApi.getJob(jobId);
      const config = (result.config ?? createDefaultJobConfig()) as unknown as CamJobConfig;
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
      set((s) => ({
        jobConfig: {
          ...s.jobConfig,
          profileId,
          tool: profileConfig.tool ?? s.jobConfig.tool,
          machine: profileConfig.machine ?? s.jobConfig.machine,
          postProcessor: profileConfig.postProcessor ?? s.jobConfig.postProcessor,
        },
      }));
      addLog('info', `Applied CAM profile: ${result.name}`);
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

  addOperation(op: CamOperation) {
    set((s) => ({
      jobConfig: {
        ...s.jobConfig,
        operations: [...s.jobConfig.operations, op],
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
    // Toggle: add entities not present, remove those already present
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

    // Persist to server if we have an active job
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
      // Start from beginning
      const origin = get().jobConfig.origin;
      const safeZ = get().jobConfig.machine.safeZ;
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
    const origin = get().jobConfig.origin;

    if (simState === 'idle') {
      // Start at first move, fully completed
      const move = toolpath[0]!;
      set({ simState: 'paused', simMoveIndex: 0, simProgress: 1, simPosition: { ...move.to }, simZ: move.z });
      return;
    }

    // Advance to next move
    const nextIndex = simMoveIndex + 1;
    if (nextIndex >= toolpath.length) {
      // Past last move
      set({ simState: 'idle', simMoveIndex: 0, simProgress: 0, simPosition: null, simZ: null });
      return;
    }

    // Compute start position for the next move
    let startPos = { ...origin };
    for (let i = 0; i <= nextIndex - 1; i++) {
      startPos = toolpath[i]!.to;
    }
    // Position is the end of nextIndex move
    const move = toolpath[nextIndex]!;
    void startPos; // used conceptually, position is endpoint
    set({ simState: 'paused', simMoveIndex: nextIndex, simProgress: 1, simPosition: { ...move.to }, simZ: move.z });
  },

  simSetSpeed(speed: number) {
    set({ simSpeed: speed });
  },

  simTick(dtMs: number) {
    const { simState, toolpath, simMoveIndex, simProgress, simSpeed } = get();
    if (simState !== 'playing' || !toolpath || toolpath.length === 0) return;

    const origin = get().jobConfig.origin;

    // Clamp dt to prevent huge jumps from frame spikes / tab switches
    const clampedDt = Math.min(dtMs, 50);

    // Compute start position for current move
    let startPos = { ...origin };
    for (let i = 0; i < simMoveIndex; i++) {
      startPos = toolpath[i]!.to;
    }

    // Compute a visual rapid rate: 3x the max feed rate in the toolpath (capped)
    // This keeps rapids visibly faster than feeds but slow enough to follow
    let maxFeed = 0;
    for (const m of toolpath) {
      if (m.kind !== 'rapid' && m.feed > maxFeed) maxFeed = m.feed;
    }
    const rapidRate = Math.min(Math.max(maxFeed * 3, 1500), 5000);

    // Work in time, not distance — each move has its own feed rate
    let remainingTime = clampedDt / 1000; // seconds
    let moveIdx = simMoveIndex;
    let progress = simProgress;
    let from = startPos;

    while (remainingTime > 0 && moveIdx < toolpath.length) {
      const move = toolpath[moveIdx]!;
      let feedRate = move.kind === 'rapid' ? rapidRate : move.feed;
      if (feedRate <= 0) feedRate = rapidRate;
      const speed = (feedRate / 60) * simSpeed; // mm/sec

      const len = moveLength(from, move);
      if (len <= 0) {
        // Zero-length move (e.g. z-only plunge), skip
        moveIdx++;
        progress = 0;
        from = move.to;
        continue;
      }

      const remainingDist = len * (1 - progress);
      const timeForRemaining = remainingDist / speed;

      if (remainingTime >= timeForRemaining) {
        // Complete this move, advance to next
        remainingTime -= timeForRemaining;
        moveIdx++;
        progress = 0;
        from = move.to;
      } else {
        // Partial advance within this move
        const distAdvanced = remainingTime * speed;
        progress += distAdvanced / len;
        remainingTime = 0;
      }
    }

    if (moveIdx >= toolpath.length) {
      // Finished all moves
      set({ simState: 'idle', simMoveIndex: 0, simProgress: 0, simPosition: null, simZ: null });
      return;
    }

    // Compute interpolated position and Z
    const move = toolpath[moveIdx]!;
    const pos = interpolateMove(from, move, progress);
    // For Z: interpolate between previous move's Z and current move's Z
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
      // Reset simulator when leaving CAM mode
      set({ simState: 'idle', simMoveIndex: 0, simProgress: 0, simPosition: null, simZ: null });
    }
    set({ camPanelOpen: opening });
    addLog('info', opening ? 'Entered CAM mode' : 'Exited CAM mode');
    // Auto-create a job when entering CAM if none exists
    if (opening && !get().activeJobId) {
      const docId = getBackendId();
      if (docId) {
        await get().createJob(docId, `Job ${new Date().toLocaleString()}`);
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
    if (state.camPanelOpen) {
      localStorage.setItem(`cam:${_lastDocId}`, JSON.stringify({
        activeJobId: state.activeJobId,
        camPanelOpen: true,
      }));
    } else {
      localStorage.removeItem(`cam:${_lastDocId}`);
    }
  },
);
