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
import { downloadGcode } from '@/export/gcode';
import { camApi } from '@/api/camClient';
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

  assignSelectedEntities(entityIds: string[]): void;
  setFocusedOperation(index: number | null): void;
  setPickingOrigin(picking: boolean): void;
  setOrigin(point: Point): void;

  generate(entities: Entity[]): void;
  downloadGcode(): void;

  requestAiSuggestion(documentData: Record<string, unknown>, profileId?: string): Promise<void>;

  toggleToolpathPreview(): void;
  toggleCamPanel(): void;
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
    if (!activeJobId) {
      addLog('warn', 'No active job to save — create a job first');
      return;
    }
    try {
      await camApi.updateJob(activeJobId, {
        config: jobConfig as unknown as Record<string, unknown>,
      });
      addLog('info', 'CAM job saved');
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

  toggleCamPanel() {
    const opening = !get().camPanelOpen;
    set({ camPanelOpen: opening });
    addLog('info', opening ? 'Entered CAM mode' : 'Exited CAM mode');
  },

  clearJob() {
    set({
      activeJobId: null,
      jobConfig: createDefaultJobConfig(),
      generatedGcode: null,
      toolpath: null,
      issues: [],
    });
  },
}));
