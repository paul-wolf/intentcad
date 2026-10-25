import { useState } from 'react';
import { useCamStore, type CamStep } from '@/stores/camStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { getBackendId, getProjectId, getProjectName } from '@/api/autoSave';
import { Logo, ThemeToggle } from '@/ui/chrome';
import { AppLink } from '@/ui/links';
import { Btn, useTokens, SANS, inputStyle } from './ui';

/** The CAM mode header: where you are, the three steps, the job, and the way out. */
export function CamHeader() {
  const t = useTokens();
  const docName = useDocumentStore((s) => s.document.name);
  const step = useCamStore((s) => s.step);
  const setStep = useCamStore((s) => s.setStep);
  const resolved = useCamStore((s) => s.resolved);
  const ops = useCamStore((s) => s.job.operations);
  const setupPending = useCamStore((s) => !!s.job.setup.aiPending);
  const toggleCamPanel = useCamStore((s) => s.toggleCamPanel);
  const projectId = getProjectId();

  const setupDone = resolved.setupMissing.length === 0 && !setupPending;
  const planDone = ops.length > 0 && ops.every((o) => o.status === 'accepted') && !resolved.ops.some((r) => r.problem);
  const steps: { id: CamStep; n: number; label: string; done: boolean }[] = [
    { id: 'setup', n: 1, label: 'Setup', done: setupDone },
    { id: 'plan', n: 2, label: 'Plan', done: planDone },
    { id: 'run', n: 3, label: 'Run', done: false },
  ];

  const crumb = { background: 'none', border: 'none', color: t.textDim, cursor: 'pointer', fontFamily: SANS, fontSize: 12.5, padding: '2px 4px' };

  return (
    <div style={{ height: 50, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', background: t.surface, borderBottom: `1px solid ${t.border}`, fontFamily: SANS, color: t.text }}>
      <Logo size={22} />
      <nav style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 12.5, minWidth: 0 }}>
        <AppLink to="/" style={crumb} title="Back to the project list">Home</AppLink>
        {projectId && (
          <>
            <span style={{ color: t.textMute }}>/</span>
            <AppLink to={`/project/${projectId}`} style={crumb} title="Back to the project">{getProjectName() ?? 'Project'}</AppLink>
          </>
        )}
        <span style={{ color: t.textMute }}>/</span>
        <span style={{ fontWeight: 600, padding: '2px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>{docName}</span>
        <span style={{ fontSize: 11.5, color: t.textMute, whiteSpace: 'nowrap' }}>sketch · <span style={{ color: t.accent, fontWeight: 600 }}>CAM</span></span>
      </nav>

      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 4 }}>
        {steps.map((s, i) => {
          const active = s.id === step;
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {i > 0 && <span style={{ width: 22, height: 1, background: t.border2 }} />}
              <button
                onClick={() => setStep(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, padding: '5px 11px', borderRadius: 999, cursor: 'pointer', fontFamily: SANS, fontSize: 12.5,
                  border: `1px solid ${active ? t.accent : 'transparent'}`, background: active ? t.accentSoft : 'transparent',
                  color: active ? t.accent : t.textDim, fontWeight: active ? 600 : 500,
                }}
              >
                <span style={{
                  width: 18, height: 18, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 700,
                  background: s.done && !active ? t.okSoft : active ? t.accent : t.surface3, color: s.done && !active ? t.ok : active ? '#fff' : t.textDim,
                }}>
                  {s.done && !active ? '✓' : s.n}
                </span>
                {s.label}
              </button>
            </div>
          );
        })}
      </div>

      <JobPicker />
      <Btn kind="ghost" small onClick={() => useEditorStore.getState().setViewportCommand('fit-entities')} title="Fit the stock in view (Shift+F)">Fit</Btn>
      <ThemeToggle size={30} />
      <Btn kind="primary" onClick={toggleCamPanel} title="Back to editing the sketch (Esc)">Exit CAM</Btn>
    </div>
  );
}

/** Pick, add, rename or delete the sketch's CAM jobs. */
function JobPicker() {
  const t = useTokens();
  const jobs = useCamStore((s) => s.jobs);
  const activeJobId = useCamStore((s) => s.activeJobId);
  const jobName = useCamStore((s) => s.jobName);
  const openJob = useCamStore((s) => s.openJob);
  const createJob = useCamStore((s) => s.createJob);
  const renameJob = useCamStore((s) => s.renameJob);
  const deleteJob = useCamStore((s) => s.deleteJob);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const onPick = (v: string) => {
    const docId = getBackendId();
    if (v === '__new') {
      if (docId) createJob(docId, `Job ${jobs.length + 1}`);
    } else if (v !== activeJobId) {
      openJob(v);
    }
  };

  if (renaming !== null) {
    return (
      <input
        autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)}
        onBlur={() => { renameJob(renaming); setRenaming(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); }
        }}
        style={{ ...inputStyle(t, 160), fontFamily: SANS }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontSize: 11.5, color: t.textMute }}>Job</span>
      <select
        value={activeJobId ?? ''} onChange={(e) => onPick(e.target.value)} title="The CAM job (saved automatically)"
        style={{ ...inputStyle(t, 150), fontFamily: SANS, padding: '4px 6px' }}
      >
        {!activeJobId && <option value="">…</option>}
        {jobs.map((j) => <option key={j.id} value={j.id}>{j.id === activeJobId ? jobName || j.name : j.name}</option>)}
        <option value="__new">+ New job</option>
      </select>
      {activeJobId && (
        <>
          <Btn kind="ghost" small onClick={() => setRenaming(jobName)} title="Rename this job">Rename</Btn>
          {confirmDelete ? (
            <>
              <Btn kind="danger" small onClick={() => { deleteJob(activeJobId); setConfirmDelete(false); }}>Delete it</Btn>
              <Btn kind="ghost" small onClick={() => setConfirmDelete(false)}>Keep</Btn>
            </>
          ) : (
            <Btn kind="ghost" small onClick={() => setConfirmDelete(true)} title="Delete this job">Delete</Btn>
          )}
        </>
      )}
    </div>
  );
}
