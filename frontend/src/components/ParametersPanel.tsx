/**
 * The sketch editor's Parameters. In a project sketch document they are the
 * project's parameters (the same list as the project page's: editing one here
 * changes it for the whole project), followed by "This sketch only", the
 * document's own, each with Move to project. Elsewhere, only its own.
 * Dimensions use any of them by name (`brace_t + 2`); text values are listed
 * but can't size a dimension.
 *
 * A number's value has the shared ParamControl (field + slider). Moving it
 * tries the value: the sketch re-solves live, but nothing is saved and no
 * undo step is made until Apply in the bar above (Reset puts it back).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useDocumentStore } from '@/stores/documentStore';
import { useProjectParamsStore } from '@/stores/projectParamsStore';
import { useThemeStore } from '@/theme';
import { flushSaveAsync, getBackendId, getProjectId, getProjectName, holdSavesForTrial, persistParamRanges, requestSave,
         subscribeProjectContext } from '@/api/autoSave';
import { projectApi } from '@/api/projectClient';
import { errorText } from '@/api/client';
import { addLog } from '@/stores/logStore';
import { ParamControl, TrialBar } from './ParamControl';
import { affectsWords } from './ProjectParameters';
import type { SavedRange } from '@/utils/paramRange';
import { isValidParamName } from '@/utils/expression';
import { isSketchDocument } from '@/utils/document';
import { saveProjectParameters, solvedWords, unitWarnings } from '@/build/projectSketchSolve';
import type { ParameterUses, ProjectParameter } from '@/types/project';

type Palette = ReturnType<typeof useThemeStore.getState>['palette'];

const headerText = (palette: Palette): React.CSSProperties => ({
  fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: palette.textMuted,
});
const plusButton = (palette: Palette): React.CSSProperties => ({
  background: 'none', border: `1px solid ${palette.inputBorder}`, borderRadius: '3px', color: palette.textMuted,
  cursor: 'pointer', fontSize: '14px', width: '22px', height: '22px', display: 'flex', alignItems: 'center',
  justifyContent: 'center',
});
const nameInput = (palette: Palette): React.CSSProperties => ({
  width: '70px', flexShrink: 0, background: palette.inputBg, border: `1px solid ${palette.inputBorder}`,
  borderRadius: '2px', color: palette.text, fontSize: '11px', fontFamily: 'monospace', padding: '1px 4px', outline: 'none',
});
const nameLabel = (palette: Palette): React.CSSProperties => ({
  fontFamily: 'monospace', fontSize: '11px', color: palette.text, cursor: 'default', flexShrink: 0, maxWidth: '70px',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
});
const smallButton = (palette: Palette): React.CSSProperties => ({
  background: 'none', border: `1px solid ${palette.inputBorder}`, borderRadius: '3px', color: palette.text,
  cursor: 'pointer', fontSize: '11px', padding: '1px 6px',
});
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 10px', fontSize: '12px' };

/** A name not used by either list: param1, param2, … */
function freeName(taken: Iterable<string>): string {
  const set = new Set(taken);
  let i = 1;
  while (set.has(`param${i}`)) i++;
  return `param${i}`;
}

type TrialEntry = { kind: 'own' | 'project'; saved: number; value: number };
type Trial = ReturnType<typeof useSketchTrial>;

/** Values being tried in a drawn sketch: shown in the stores (the sketch
 *  re-solves, at most once a frame) with saves held; Apply makes them real
 *  (an undo step for its own, a project save for the project's). */
function useSketchTrial(projectId: string | null) {
  const [entries, setEntries] = useState<Record<string, TrialEntry>>({});
  const ref = useRef(entries);
  const base = useRef<ProjectParameter[] | null>(null);   // the project's values before the trial
  const frame = useRef<number | null>(null);

  const show = (e: Record<string, TrialEntry>, restoreAll = false) => {
    const doc = useDocumentStore.getState().document;
    const own = { ...(doc.parameters ?? {}) };
    for (const [n, t] of Object.entries(e)) if (t.kind === 'own') own[n] = restoreAll ? t.saved : t.value;
    useDocumentStore.setState({ document: { ...doc, parameters: own } });
    if (projectId && base.current) {
      useProjectParamsStore.getState().set(projectId, base.current.map((p) => {
        const t = e[p.name];
        return t?.kind === 'project' && !restoreAll ? { ...p, value: t.value } : p;
      }));
    }
    useDocumentStore.getState().reapplyExpressionDimensions();
  };
  const set = (next: Record<string, TrialEntry>) => {
    ref.current = next;
    setEntries(next);
    if (frame.current == null) {
      frame.current = requestAnimationFrame(() => { frame.current = null; show(ref.current); });
    }
  };
  const tryValue = (name: string, kind: TrialEntry['kind'], saved: number, value: number) => {
    holdSavesForTrial(true);
    if (kind === 'project' && !base.current) base.current = useProjectParamsStore.getState().params;
    const prev = ref.current[name];
    const { [name]: _drop, ...rest } = ref.current;
    const s0 = prev?.saved ?? saved;
    set(value === s0 ? rest : { ...rest, [name]: { kind, saved: s0, value } });
  };
  const end = () => {
    if (frame.current != null) { cancelAnimationFrame(frame.current); frame.current = null; }
    const was = ref.current;
    show(was, true);
    ref.current = {};
    setEntries({});
    base.current = null;
    holdSavesForTrial(false);
    return was;
  };
  const reset = () => { if (Object.keys(ref.current).length || base.current) end(); };
  /** the project's values as saved (not the ones being tried) */
  const projectSaved = () => base.current ?? useProjectParamsStore.getState().params;
  const apply = async (saveProject: (next: ProjectParameter[], renames?: Record<string, string>, what?: string) => Promise<boolean>) => {
    const savedProject = projectSaved();
    const was = end();
    const own = Object.entries(was).filter(([, t]) => t.kind === 'own');
    const proj = Object.entries(was).filter(([, t]) => t.kind === 'project');
    if (own.length) {
      const st = useDocumentStore.getState();
      st.beginTransaction('Edit parameter');
      for (const [n, t] of own) st.setParameter(n, t.value);
      requestSave();
    }
    if (proj.length) {
      await saveProject(savedProject.map((p) => (was[p.name]?.kind === 'project' ? { ...p, value: was[p.name]!.value } : p)), {},
                        `${proj.map(([n, t]) => `${n} = ${t.value}`).join(', ')} for the whole project`);
    }
  };
  useEffect(() => () => { if (Object.keys(ref.current).length) end(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return { entries, tryValue, reset, apply, projectSaved };
}

export function ParametersPanel() {
  const isSketchDoc = useDocumentStore((s) => isSketchDocument(s.document));
  const projectId = useSyncExternalStore(subscribeProjectContext, getProjectId);
  const paramsProject = useProjectParamsStore((s) => s.projectId);
  const inProject = isSketchDoc && !!projectId && paramsProject === projectId;
  const trial = useSketchTrial(inProject ? projectId : null);
  return inProject ? <ProjectSketchParameters projectId={projectId!} trial={trial} />
    : (
      <>
        <TrialBar style={{ margin: 6, flexWrap: 'wrap' }} onReset={trial.reset} onApply={() => void trial.apply(async () => true)}
          items={Object.entries(trial.entries).map(([n, t]) => ({ name: n, value: t.value, saved: t.saved }))} />
        <OwnParameters title="Parameters" trial={trial} />
      </>
    );
}

function ProjectSketchParameters({ projectId, trial }: { projectId: string; trial: Trial }) {
  const palette = useThemeStore((s) => s.palette);
  const projectName = useSyncExternalStore(subscribeProjectContext, getProjectName);
  const params = useProjectParamsStore((s) => s.params);
  const own = useDocumentStore((s) => s.document.parameters ?? {});
  const sketch = useDocumentStore((s) => s.getActiveSketch());
  const [editing, setEditing] = useState<string | null>(null);
  const [nameText, setNameText] = useState('');
  const [renaming, setRenaming] = useState<{ from: string; to: string; affects: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uses, setUses] = useState<ParameterUses>({});
  const tryingProject = Object.values(trial.entries).some((t) => t.kind === 'project');
  useEffect(() => {
    if (tryingProject) projectApi.parameterUses(projectId).then(setUses).catch(() => {});
  }, [tryingProject, projectId]);

  const save = async (next: ProjectParameter[], renames: Record<string, string> = {}, what = 'Project parameters saved') => {
    setBusy(true);
    try {
      const r = await saveProjectParameters(projectId, next, renames, getBackendId());
      useProjectParamsStore.getState().set(projectId, r.params);
      for (const [o, n] of Object.entries(renames)) useDocumentStore.getState().renameProjectParameter(o, n);
      if (Object.keys(renames).length) requestSave();
      const words = solvedWords(r);
      addLog(words ? 'warn' : 'info', words ? `${what}; ${words}` : what);
      return true;
    } catch (e) {
      addLog('error', `Couldn't save the project's parameters: ${errorText(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setRange = (name: string, r: SavedRange | null) =>
    void save(trial.projectSaved().map((p) => (p.name === name ? { ...p, min: r?.min ?? null, max: r?.max ?? null, step: r?.step ?? null } : p)),
              {}, `Slider range of ${name} saved`);
  const trialItems = Object.entries(trial.entries).map(([n, t]) => ({ name: n, value: t.value, saved: t.saved }));
  const projectTried = Object.entries(trial.entries).filter(([, t]) => t.kind === 'project').map(([n]) => n);

  const add = () => {
    const name = freeName([...params.map((p) => p.name), ...Object.keys(own)]);
    void save([...params, { name, value: 10, unit: 'mm', description: '' }], {}, `Added ${name} to the project`);
  };

  // a rename rewrites the project's sketches and parts: say which first
  const askRename = async () => {
    const from = editing!, to = nameText.trim();
    setEditing(null);
    if (!to || to === from) return;
    if (!isValidParamName(to)) { addLog('warn', `${to} isn't a usable name: letters, digits and _, not starting with a digit`); return; }
    if (params.some((p) => p.name === to) || to in own) { addLog('warn', `There is already a parameter called ${to}`); return; }
    let affects = '';
    try {
      const u = (await projectApi.parameterUses(projectId))[from];
      const sk = u?.sketches.map((s) => s.name) ?? [];
      const parts = u?.parts.map((p) => p.name) ?? [];
      affects = [sk.length ? `sketches ${[...new Set(sk)].join(', ')}` : '', parts.length ? `parts ${parts.join(', ')}` : '']
        .filter(Boolean).join('; ') || 'nothing uses it yet';
    } catch { affects = "couldn't check what uses it"; }
    setRenaming({ from, to, affects });
  };

  const failing = sketch?.solveError;
  const failingNames = new Set(failing ? Object.keys(failing.with) : []);
  const units = sketch ? unitWarnings(sketch, params, own) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderBottom: `1px solid ${palette.border}` }}>
      <TrialBar style={{ margin: 6, flexWrap: 'wrap' }} items={trialItems} onReset={trial.reset}
        onApply={() => void trial.apply(save)} applyLabel={projectTried.length ? 'Apply to project' : 'Apply'}
        note={projectTried.length ? affectsWords(projectTried, uses) : undefined} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px',
                    borderBottom: `1px solid ${palette.border}` }}>
        <span style={headerText(palette)} title={`The parameters of the project${projectName ? ` ${projectName}` : ''}: changing one here changes it for every sketch and part that uses it`}>
          Project parameters
        </span>
        <button style={plusButton(palette)} onClick={add} disabled={busy} title="Add a project parameter">+</button>
      </div>

      {failing && (
        <div role="alert" style={{ padding: '6px 10px', fontSize: '11px', color: palette.danger,
                                   borderBottom: `1px solid ${palette.border}` }}>
          <b>This sketch can't be solved with {Object.entries(failing.with).map(([n, v]) => `${n} = ${v ?? '(deleted)'}`).join(', ')}.</b>{' '}
          {failing.message}. It keeps its last good shape, and parts using it stay as built.
        </div>
      )}
      {units.map((w) => (
        <div key={`${w.dimensionId}:${w.name}`} style={{ padding: '4px 10px', fontSize: '11px', color: palette.warning }}>
          ⚠ {w.message}
        </div>
      ))}

      <div style={{ overflowY: 'auto', maxHeight: '180px' }}>
        {params.length === 0 && (
          <div style={{ padding: '8px 10px', fontSize: '11px', color: palette.textMuted, fontStyle: 'italic' }}>
            The project has no parameters yet
          </div>
        )}
        {params.map((p) => (
          <div key={p.name} style={row} title={p.description || undefined}>
            {editing === p.name ? (
              <input style={nameInput(palette)} value={nameText} autoFocus aria-label={`New name for ${p.name}`}
                     onChange={(e) => setNameText(e.target.value)} onBlur={() => void askRename()}
                     onKeyDown={(e) => {
                       e.stopPropagation();
                       if (e.key === 'Enter') void askRename();
                       if (e.key === 'Escape') setEditing(null);
                     }} />
            ) : (
              <span style={{ ...nameLabel(palette), color: failingNames.has(p.name) ? palette.danger : palette.text }}
                    title={`${p.name}${failingNames.has(p.name) ? ": this sketch can't be solved with its value" : ''} (double-click to rename it everywhere in the project)`}
                    onDoubleClick={() => { setEditing(p.name); setNameText(p.name); }}>
                {failingNames.has(p.name) ? '⚠ ' : ''}{p.name}
              </span>
            )}
            <span style={{ color: palette.textMuted, flexShrink: 0 }}>=</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {typeof p.value === 'number' ? (
                <ParamControl value={trial.entries[p.name]?.value ?? p.value} saved={trial.entries[p.name]?.saved ?? p.value}
                  unit={p.unit} range={p} disabled={busy} savedWord="project"
                  onChange={(v) => trial.tryValue(p.name, 'project', trial.entries[p.name]?.saved ?? (p.value as number), v)}
                  onRange={(r) => setRange(p.name, r)} />
              ) : (
                <span style={{ fontSize: '11px', color: palette.textMuted }} title="Text: parts' scripts can read it as PP[…], but it can't size a dimension">
                  “{p.value}” (text)
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {renaming && (
        <div role="dialog" aria-label="Rename project parameter"
             style={{ margin: '4px 10px 8px', padding: '6px 8px', fontSize: '11px', border: `1px solid ${palette.border}`, borderRadius: '4px' }}>
          Rename <b>{renaming.from}</b> to <b>{renaming.to}</b> everywhere in the project? It rewrites {renaming.affects}.
          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '6px' }}>
            <button style={smallButton(palette)} onClick={() => setRenaming(null)}>Cancel</button>
            <button style={{ ...smallButton(palette), borderColor: palette.accent, color: palette.accent }} disabled={busy}
                    onClick={() => {
                      const r = renaming;
                      setRenaming(null);
                      void save(params.map((p) => (p.name === r.from ? { ...p, name: r.to } : p)), { [r.from]: r.to },
                                `Renamed ${r.from} to ${r.to} in the project`);
                    }}>
              Rename
            </button>
          </div>
        </div>
      )}

      <OwnParameters title="This sketch only" project={trial.projectSaved()} projectId={projectId} onMove={save} busy={busy}
        trial={trial} />
    </div>
  );
}

/** The document's own parameters; in a project sketch, "This sketch only",
 *  each with Move to project. */
function OwnParameters({ title, project, projectId, onMove, busy, trial }: {
  title: string;
  trial: Trial;
  project?: ProjectParameter[];
  projectId?: string;
  onMove?: (next: ProjectParameter[], renames?: Record<string, string>, what?: string) => Promise<boolean>;
  busy?: boolean;
}) {
  const palette = useThemeStore((s) => s.palette);
  const parameters = useDocumentStore((s) => s.document.parameters) ?? {};
  const ranges = useDocumentStore((s) => s.document.paramRanges) ?? {};
  const beginTransaction = useDocumentStore((s) => s.beginTransaction);
  const setParameter = useDocumentStore((s) => s.setParameter);
  const removeParameter = useDocumentStore((s) => s.removeParameter);
  const renameParameter = useDocumentStore((s) => s.renameParameter);

  const [editingParamName, setEditingParamName] = useState<string | null>(null);
  const [editParamNameValue, setEditParamNameValue] = useState('');
  const [hoveredParam, setHoveredParam] = useState<string | null>(null);
  // Move to project with a name the project has: use its value, or rename this one
  const [taken, setTaken] = useState<{ name: string; renameTo: string | null } | null>(null);
  const projectNames = new Set((project ?? []).map((p) => p.name));
  const inProject = !!project;

  const addParameter = () => {
    beginTransaction('Add parameter');
    setParameter(freeName([...Object.keys(parameters), ...projectNames]), 10);
    requestSave();
  };

  const commitParamRename = () => {
    if (editingParamName && editParamNameValue.trim()) {
      const newName = editParamNameValue.trim();
      if (projectNames.has(newName)) {
        addLog('warn', `${newName} is a project parameter: a name can't be both (use the project's, or pick another name)`);
      } else if (isValidParamName(newName) && newName !== editingParamName && !(newName in parameters)) {
        beginTransaction('Rename parameter');
        renameParameter(editingParamName, newName);
        requestSave();
      }
    }
    setEditingParamName(null);
  };

  // the sketch drops its own first (the server refuses a name a sketch has),
  // then the project gets it; if the project refuses, the sketch has it back
  const move = async (name: string, as = name) => {
    if (!onMove || !project || !projectId) return;
    const value = parameters[name]!;
    const sketch = useDocumentStore.getState().getActiveSketch();
    const dims = (sketch?.entities ?? []).filter((e) => e.type === 'dimension' && e.expression
      && new RegExp(`(?<![\\w.])${name}(?!\\w)`).test(e.expression));
    const unit = dims.length && dims.every((d) => d.type === 'dimension' && d.angleMode) ? 'deg' : 'mm';
    const next = [...project, { name: as, value, unit, description: '' } as ProjectParameter];
    beginTransaction('Move parameter to project');
    useProjectParamsStore.getState().set(projectId, next);   // so its dimensions keep their value meanwhile
    if (as !== name) renameParameter(name, as);
    removeParameter(as);
    requestSave();
    try { await flushSaveAsync(); } catch { /* the save reports it */ }
    if (!(await onMove(next, {}, `Moved ${as} to the project`))) {
      useProjectParamsStore.getState().set(projectId, project);
      setParameter(as, value);
      if (as !== name) renameParameter(as, name);
      requestSave();
    }
  };

  const useProjectValue = (name: string) => {
    beginTransaction('Use the project parameter');
    removeParameter(name);   // its dimensions now use the project's value
    useDocumentStore.getState().reapplyExpressionDimensions();
    requestSave();
    setTaken(null);
    const v = useProjectParamsStore.getState().params.find((p) => p.name === name)?.value;
    addLog('info', `${name} now uses the project's value (${v})`);
  };

  const paramEntries = Object.entries(parameters);
  if (inProject && !paramEntries.length) {
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px',
                    borderTop: `1px solid ${palette.border}` }}>
        <span style={{ ...headerText(palette), fontSize: '11px' }}>This sketch only</span>
        <button style={plusButton(palette)} onClick={addParameter} title="Add a parameter only this sketch uses">+</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', ...(inProject ? { borderTop: `1px solid ${palette.border}` } : { borderBottom: `1px solid ${palette.border}` }) }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: inProject ? '6px 10px' : '8px 10px',
                    borderBottom: `1px solid ${palette.border}` }}>
        <span style={{ ...headerText(palette), ...(inProject ? { fontSize: '11px' } : {}) }}>{title}</span>
        <button style={plusButton(palette)} onClick={addParameter}
                title={inProject ? 'Add a parameter only this sketch uses' : 'Add parameter'}>+</button>
      </div>

      <div style={{ overflowY: 'auto', maxHeight: '150px' }}>
        {paramEntries.length === 0 && (
          <div style={{ padding: '8px 10px', fontSize: '11px', color: palette.textMuted, fontStyle: 'italic' }}>
            No parameters
          </div>
        )}
        {paramEntries.map(([name, value]) => (
          <div key={name}>
            <div style={row} onMouseEnter={() => setHoveredParam(name)} onMouseLeave={() => setHoveredParam(null)}>
              {editingParamName === name ? (
                <input style={nameInput(palette)} value={editParamNameValue} autoFocus
                       onChange={(e) => setEditParamNameValue(e.target.value)} onBlur={commitParamRename}
                       onKeyDown={(e) => {
                         e.stopPropagation();
                         if (e.key === 'Enter') commitParamRename();
                         if (e.key === 'Escape') setEditingParamName(null);
                       }} />
              ) : (
                <span style={nameLabel(palette)} title={projectNames.has(name)
                        ? `${name} is a project parameter as well: this sketch uses its own value (Move to project to settle it)` : name}
                      onDoubleClick={() => { setEditingParamName(name); setEditParamNameValue(name); }}>
                  {projectNames.has(name) ? '⚠ ' : ''}{name}
                </span>
              )}
              <span style={{ color: palette.textMuted, flexShrink: 0 }}>=</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ParamControl value={value} saved={trial.entries[name]?.saved ?? value} range={ranges[name]}
                  onChange={(v) => trial.tryValue(name, 'own', trial.entries[name]?.saved ?? value, v)}
                  onRange={(r) => {
                    const { [name]: _old, ...rest } = ranges;
                    persistParamRanges(r ? { ...rest, [name]: r } : rest);
                  }} />
              </div>
              {inProject && (
                <button style={{ ...smallButton(palette), padding: '0 4px', fontSize: '10px', flexShrink: 0 }} disabled={busy}
                        title="Make this a project parameter, for every sketch and part of the project"
                        onClick={() => (projectNames.has(name) ? setTaken({ name, renameTo: null }) : void move(name))}>
                  Move to project
                </button>
              )}
              {hoveredParam === name && (
                <button style={{ background: 'none', border: 'none', color: palette.textMuted, cursor: 'pointer', fontSize: '12px',
                                 padding: 0, lineHeight: 1, flexShrink: 0 }}
                        onClick={() => {
                          beginTransaction('Delete parameter');
                          removeParameter(name);
                          requestSave();
                        }}
                        title="Delete parameter">
                  x
                </button>
              )}
            </div>
            {taken?.name === name && (
              <div role="dialog" aria-label="The project has this name"
                   style={{ margin: '0 10px 6px', padding: '6px 8px', fontSize: '11px', border: `1px solid ${palette.border}`, borderRadius: '4px' }}>
                The project already has <b>{name}</b> = {String(project?.find((p) => p.name === name)?.value)}.
                {taken.renameTo === null ? (
                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '6px', flexWrap: 'wrap' }}>
                    <button style={smallButton(palette)} onClick={() => setTaken(null)}>Cancel</button>
                    <button style={smallButton(palette)} onClick={() => setTaken({ name, renameTo: freeName([...Object.keys(parameters), ...projectNames]) })}>
                      Rename…
                    </button>
                    <button style={{ ...smallButton(palette), borderColor: palette.accent, color: palette.accent }}
                            onClick={() => useProjectValue(name)}>
                      Use the project's value
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px' }}>
                    <input style={{ ...nameInput(palette), flex: 1 }} value={taken.renameTo} autoFocus aria-label="New name"
                           onChange={(e) => setTaken({ name, renameTo: e.target.value })}
                           onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setTaken(null); }} />
                    <button style={{ ...smallButton(palette), borderColor: palette.accent, color: palette.accent }}
                            disabled={!isValidParamName(taken.renameTo.trim()) || projectNames.has(taken.renameTo.trim())
                                      || taken.renameTo.trim() in parameters}
                            onClick={() => { const to = taken.renameTo!.trim(); setTaken(null); void move(name, to); }}>
                      Rename and move
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
