/**
 * The parameters of the project the open document belongs to: a project
 * sketch's dimensions use them by name (build/projectSketchSolve.ts). Loaded
 * with the document, and again when the tab comes back into focus (they may
 * have been changed on the project page or in another tab).
 */
import { create } from 'zustand';
import type { ProjectParameter } from '@/types/project';
import { projectApi } from '@/api/projectClient';
import { isSketchDocument } from '@/utils/document';
import { projectSketchVars } from '@/build/projectSketchSolve';

interface ProjectParamsState {
  /** the project `params` are of: set only once they have loaded, so nothing
   *  solves with an empty list meanwhile (every name would look deleted) */
  projectId: string | null;
  /** the project being loaded */
  wanted: string | null;
  params: ProjectParameter[];
  /** set the project (null: none) and load its parameters */
  load: (projectId: string | null) => Promise<void>;
  /** load them again (no-op without a project) */
  refresh: () => Promise<void>;
  /** they were just saved here */
  set: (projectId: string, params: ProjectParameter[]) => void;
}

const same = (a: ProjectParameter[], b: ProjectParameter[]) => JSON.stringify(a) === JSON.stringify(b);

export const useProjectParamsStore = create<ProjectParamsState>((set, get) => ({
  projectId: null,
  wanted: null,
  params: [],
  async load(projectId) {
    if (projectId !== get().projectId) set({ projectId: null, params: [] });
    set({ wanted: projectId });
    if (!projectId) return;
    try {
      const p = await projectApi.getProject(projectId);
      if (get().wanted !== projectId) return;
      const params = p.parameters ?? [];
      if (get().projectId !== projectId) set({ projectId, params });
      else if (!same(params, get().params)) set({ params });
    } catch { /* offline: keep what we have */ }
  },
  refresh() {
    return get().load(get().wanted);
  },
  set(projectId, params) {
    if (projectId === get().projectId && !same(params, get().params)) set({ params });
  },
}));

/** The open document's project parameters if it is a project sketch
 *  document (null for a part or a sketch outside a project). */
export function projectSketchParams(doc: { type?: string; modelCode?: string }): ProjectParameter[] | null {
  const s = useProjectParamsStore.getState();
  return s.projectId && isSketchDocument(doc) ? s.params : null;
}

/** What a sketch dimension of the open document can use by name: in a
 *  project sketch the project's numbers and the document's own parameters
 *  (its own win a clash), else its own. */
export function editorVars(doc: { type?: string; modelCode?: string; parameters?: Record<string, number> }): Record<string, number> {
  const pp = projectSketchParams(doc);
  return pp ? projectSketchVars(pp, doc.parameters) : { ...(doc.parameters ?? {}) };
}
