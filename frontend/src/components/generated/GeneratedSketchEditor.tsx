/**
 * The editor of a generated sketch: a sketch drawn by code (the server runs
 * it; parts read what it saved). The drawing is the default view, with the
 * code one click away; on the right its outputs, the project parameters it
 * read (sliders try values without saving; Apply to project saves them), its
 * checks and the parts that use it; under the drawing the sketch chat (the AI
 * edits the code: a change that stops making outputs parts use waits for the
 * user's yes).
 *
 * Nothing here goes through the drawn sketch's document store or autosave:
 * the code is saved by Run (PUT /api/sketches/{id}/code), and trial values
 * run with POST /api/sketches/{id}/run, which saves nothing.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useThemeStore } from '@/theme';
import { api as rawApi, buildApi, errorText, sketchApi } from '@/api/client';
import { projectApi } from '@/api/projectClient';
import { getUsers, loadUsers, refreshUsers, subscribeSharedUses } from '@/api/sharedUses';
import { useProjectParamsStore } from '@/stores/projectParamsStore';
import { saveProjectParameters, solvedWords } from '@/build/projectSketchSolve';
import { affectsWords } from '@/components/ProjectParameters';
import { TargetDialog, type PickOption } from '@/components/SketchToPartMenu';
import { OP_WORDS, type HandoffOp } from '@/build/sketchToPart';
import { addLog } from '@/stores/logStore';
import { LatestRunner } from '@/utils/latestRunner';
import { fmt } from '@/components/ParamControl';
import { trialErrorWords } from '@/build/generatedSketch';
import type { SavedRange } from '@/utils/paramRange';
import type { BrokenOutput, GenDoc, GenRunResult } from '@/types/generated';
import type { ChatMessage } from '@/types/document';
import type { SketchAskResponse } from '@/api/client';
import { SketchDrawing } from './SketchDrawing';
import { CodeView } from './CodeView';
import { ChecksPanel, OutputsPanel, ParametersPanel, UsedByPanel } from './SidePanels';
import { HeldCard, SketchChat, runWords } from './SketchChat';
import { cardKey, runCardAction, withCardStatus } from '@/components/cardAction';

type Trial = { values: Record<string, number>; result: GenRunResult | null };
const NO_TRIAL: Trial = { values: {}, result: null };
const sameValues = (a: Record<string, number>, b: Record<string, number>) => JSON.stringify(a) === JSON.stringify(b);

export function GeneratedSketchEditor({ id }: { id: string }) {
  const palette = useThemeStore((s) => s.palette);
  const [doc, setDoc] = useState<GenDoc | null>(null);
  const [loadError, setLoadError] = useState('');
  const [projectName, setProjectName] = useState('');
  const [tab, setTab] = useState<'drawing' | 'code'>('drawing');
  const [code, setCode] = useState('');
  const [running, setRunning] = useState(false);
  const [broken, setBroken] = useState<BrokenOutput[] | null>(null);
  const [goTo, setGoTo] = useState<{ line: number; n: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [trial, setTrial] = useState<Trial>(NO_TRIAL);
  const [trialBusy, setTrialBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ words: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState('');
  const [rebuild, setRebuild] = useState<{ at: string; done: string[]; failed: string[] } | null>(null);
  const [op, setOp] = useState<HandoffOp | null>(null);
  const [useMenu, setUseMenu] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const askAi = useRef<((text: string) => void) | null>(null);
  // the chat's saves go in turn, so an older chat never lands after a newer one
  const chatSaving = useRef<Promise<unknown>>(Promise.resolve());
  const users = useSyncExternalStore(subscribeSharedUses, getUsers);
  const params = useProjectParamsStore((s) => s.params);
  const projectId = doc?.project_id ?? null;

  const reload = async () => {
    const full = await rawApi.getDocument(id);
    const d = full as unknown as GenDoc;
    setDoc(d);
    setCode(d.data.code);
    return d;
  };
  useEffect(() => {
    setDoc(null);
    setLoadError('');
    setChat([]);
    reload().then((d) => setChat((d.data.chat ?? []) as ChatMessage[])).catch((e) => setLoadError(errorText(e)));
    void loadUsers(id);
    return () => { void loadUsers(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // the project's parameters: with the document, and again when the tab comes back
  useEffect(() => {
    if (!projectId) return;
    void useProjectParamsStore.getState().load(projectId);
    projectApi.getProject(projectId).then((p) => setProjectName(p.name)).catch(() => {});
    const again = () => {
      if (document.visibilityState !== 'visible') return;
      void useProjectParamsStore.getState().refresh();
      void refreshUsers(id);
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [projectId, id]);

  // trial runs: one at a time, at most 8 a second, the latest values only
  const runner = useMemo(() => new LatestRunner<Record<string, number>, GenRunResult>(
    (pp) => sketchApi.run(id, { pp }).then((r) => r.result),
    (pp, result) => setTrial((t) => (sameValues(t.values, pp) ? { ...t, result } : t)),
    { minInterval: 125, onBusy: setTrialBusy },
  ), [id]);
  useEffect(() => () => runner.cancel(), [runner]);
  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  if (loadError) return <Centered>Couldn't open the sketch: {loadError}</Centered>;
  if (!doc) return <Centered>Opening…</Centered>;

  const sketch = doc.data.sketches[0]!;
  const rec = sketch.generated;
  const saved = doc.data.code;
  const dirty = code !== saved;
  const trying = Object.keys(trial.values).length > 0;
  const trialOk = trying && trial.result?.ok ? trial.result : null;
  const trialFail = trying && trial.result && !trial.result.ok ? trial.result : null;
  const entities = trialOk?.entities ?? sketch.entities;
  const outputs = trialOk?.outputs ?? rec?.outputs ?? [];
  const checks = trialOk?.checks ?? rec?.checks ?? [];
  const notes = trialOk?.annotations ?? rec?.annotations ?? null;
  const reads = { ...(rec?.reads ?? {}), ...(trial.result?.reads ?? {}) };
  const savedError = rec?.error ?? null;
  const dimmed = !!trialFail || (!trying && !!savedError);
  const lit = new Set([hover, picked].filter((x): x is string => !!x));

  const editAttempt = () => {
    setHint(true);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(false), 4000);
  };

  // ── parameters ──
  const savedValue = (name: string) => params.find((p) => p.name === name)?.value ?? rec?.reads?.[name];
  const tryValue = (name: string, v: number, final: boolean) => {
    const values = { ...trial.values };
    if (v === savedValue(name)) delete values[name];
    else values[name] = v;
    setApplied('');
    if (!Object.keys(values).length) { resetTrial(); return; }
    setTrial((t) => ({ values, result: t.result }));
    runner.submit(values, final);
  };
  const resetTrial = () => { runner.cancel(); setTrial(NO_TRIAL); };
  const triedWords = Object.entries(trial.values).map(([k, v]) => `${k} to ${fmt(v)}`).join(', ');

  const askApply = async () => {
    if (!projectId) return;
    let words = '';
    try {
      words = affectsWords(Object.keys(trial.values), await projectApi.parameterUses(projectId));
    } catch { /* the question still makes sense without it */ }
    const parts = words && !words.startsWith('No part');
    setConfirm({ words: `Set ${triedWords} for the whole project? ${words}${parts ? " They show out of date until they're rebuilt." : ''}` });
  };
  const apply = async () => {
    if (!projectId) return;
    setApplying(true);
    try {
      const next = params.map((p) => (p.name in trial.values ? { ...p, value: trial.values[p.name]! } : p));
      const r = await saveProjectParameters(projectId, next);
      useProjectParamsStore.getState().set(projectId, r.params);
      const warn = solvedWords(r);
      if (warn) addLog('warn', `Project parameters saved, but sketches ${warn}`);
      const words = Object.entries(trial.values).map(([k, v]) => `${k} = ${fmt(v)}`).join(', ');
      resetTrial();
      await reload();   // the server ran the sketch again with the new values
      await refreshUsers(id);
      setApplied(`${words} applied.`);
    } catch (e) {
      addLog('error', `Couldn't apply to the project: ${errorText(e)}`);
    } finally {
      setApplying(false);
      setConfirm(null);
    }
  };
  const setRange = async (name: string, r: SavedRange | null) => {
    if (!projectId) return;
    const next = params.map((p) => (p.name === name ? { ...p, min: r?.min ?? null, max: r?.max ?? null, step: r?.step ?? null } : p));
    try {
      const s = await saveProjectParameters(projectId, next);
      useProjectParamsStore.getState().set(projectId, s.params);
    } catch (e) {
      addLog('error', `Couldn't save the slider range: ${errorText(e)}`);
    }
  };

  // ── code ──
  const runCode = async (confirmBroken = false) => {
    setRunning(true);
    try {
      const r = await sketchApi.saveCode(id, { code, label: 'before a code edit', confirm: confirmBroken });
      if (!r.saved) { setBroken(r.broken); return; }
      setBroken(null);
      const { saved: _s, broken: _b, result: _r, ...d } = r;
      setDoc(d as GenDoc);
      resetTrial();
      await refreshUsers(id);
    } catch (e) {
      addLog('error', `Couldn't run the code: ${errorText(e)}`);
    } finally {
      setRunning(false);
    }
  };

  // ── chat ──
  /** Change the chat as it is now (not as a card last saw it) and save it. */
  const updateChat = (change: (messages: ChatMessage[]) => ChatMessage[]) => {
    const next = change(chatRef.current);
    chatRef.current = next;
    setChat(next);
    chatSaving.current = chatSaving.current.then(() => sketchApi.saveChat(id, next))
      .catch((e) => addLog('error', `Couldn't save the chat: ${errorText(e)}`));
  };
  /** Save code the chat brought; null, or the outputs parts use it would drop (then nothing is saved). */
  const saveFromChat = async (c: string, label: string, confirmBroken: boolean): Promise<BrokenOutput[] | null> => {
    const r = await sketchApi.saveCode(id, { code: c, label, confirm: confirmBroken });
    if (!r.saved) return r.broken;
    const { saved: _s, broken: _b, result: _r, ...d } = r;
    if (dirty) addLog('info', 'The code you were editing was replaced by the AI\'s change (your saved versions are in the Code tab\'s history).');
    setDoc(d as GenDoc);
    setCode(c);
    setBroken(null);
    resetTrial();
    await refreshUsers(id);
    return null;
  };
  const onReply = async (r: SketchAskResponse): Promise<Partial<ChatMessage>> => {
    const text = [r.note || 'Done.', runWords(r.result)].filter(Boolean).join(' ');
    if (r.kind !== 'edit' || !r.code) return { kind: 'answer', text: r.sentence || text };
    const label = `before AI: ${r.note || 'a change'}`.slice(0, 80);
    const held = (broken: BrokenOutput[]) => ({ kind: 'edit' as const, text, held: { code: r.code!, label, broken, status: 'pending' as const } });
    // new outputs parts would lose, or project parameters not accepted yet: the user says first
    if (r.broken?.length || r.parameter_proposals?.length) return held(r.broken ?? []);
    try {
      const lost = await saveFromChat(r.code, label, false);
      return lost ? held(lost) : { kind: 'edit', text, code: r.code };
    } catch (e) {
      return { kind: 'question', text: `${text}\n⚠ Couldn't save it: ${errorText(e)}` };
    }
  };
  /** Save the held code of the message at `at`; throws what went wrong (its card shows it). */
  const applyHeld = async (at: number) => {
    const h = chatRef.current.find((m) => m.at === at)?.held;
    if (!h || h.status !== 'pending') return;
    if (await saveFromChat(h.code, h.label, true)) throw new Error('the server didn\'t save it. Try again, or reload.');
    updateChat((ms) => withCardStatus(ms, at, 'held', 'applied', { code: h.code }));
  };
  const revertTo = async (c: string) => {
    try {
      const lost = await saveFromChat(c, 'before going back', false);
      // it would drop outputs parts use: the Code tab asks, as for a hand edit
      if (lost) { setTab('code'); setCode(c); setBroken(lost); }
    } catch (e) {
      addLog('error', `Couldn't go back: ${errorText(e)}`);
    }
  };
  const paramsAccepted = async () => {
    await useProjectParamsStore.getState().refresh();
    await reload();
    // code that waited for these parameters goes in now
    const waiting = chatRef.current.filter((m) => m.held?.status === 'pending' && !m.held.broken.length).pop();
    if (waiting) await runCardAction(cardKey(id, 'held', waiting.at), () => applyHeld(waiting.at));   // its card shows how it went
    await refreshUsers(id);
  };

  const stale = users.filter((p) => p.stale.length && !p.pinned);
  const rebuildAll = async () => {
    const state = { at: '', done: [] as string[], failed: [] as string[] };
    for (const p of stale) {
      state.at = p.name;
      setRebuild({ ...state });
      try {
        const r = await buildApi.rebuild(p.id);
        if (r.ok) state.done.push(p.name);
        else state.failed.push(`${p.name}: ${r.error || r.warning}`);
      } catch (err) {
        state.failed.push(`${p.name}: ${errorText(err)}`);
      }
    }
    setRebuild({ ...state, at: '' });
    state.failed.forEach((f) => addLog('error', `Rebuild ${f}`));
    void refreshUsers(id);
  };

  const picks: PickOption[] = [
    { key: '', label: 'The whole sketch', pick: null },
    ...outputs.map((o) => ({ key: `g:${o.name}`, label: `Output: ${o.name} (${o.size})`, pick: { kind: 'group' as const, name: o.name } })),
  ];

  const btn: CSSProperties = {
    background: 'none', border: `1px solid ${palette.inputBorder}`, borderRadius: 4, color: palette.text, cursor: 'pointer',
    fontSize: '12px', padding: '4px 10px',
  };
  const seg = (on: boolean): CSSProperties => ({
    ...btn, border: 'none', borderRadius: 0, padding: '4px 12px',
    background: on ? palette.accent : 'transparent', color: on ? '#fff' : palette.textSecondary,
  });

  const errorBox = (() => {
    if (trialFail) {
      return (
        <Banner color={palette.warning}>
          {trialErrorWords(trial.values, Object.fromEntries(Object.keys(trial.values).map((k) => [k, savedValue(k) ?? '—'])),
                           trialFail.error.replace(/\.$/, ''))}
        </Banner>
      );
    }
    if (trying || !savedError) return null;
    return (
      <Banner color={palette.danger}>
        <span style={{ flex: 1 }}>
          The code stopped{savedError.line ? ` at line ${savedError.line}` : ''}: {savedError.message}.
          {' '}Parts keep using the last good drawing.
        </span>
        {savedError.line && (
          <button style={btn} onClick={() => { setTab('code'); setGoTo({ line: savedError.line!, n: Date.now() }); }}>
            Show line {savedError.line}
          </button>
        )}
        <button style={btn} title="Ask the AI to fix the code"
          onClick={() => askAi.current?.(`The code stopped${savedError.line ? ` at line ${savedError.line}` : ''}: ${savedError.message}. Please fix it.`)}>
          Fix with AI
        </button>
      </Banner>
    );
  })();

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: palette.background,
                  color: palette.text, fontSize: '13px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: palette.panelBg,
                    borderBottom: `1px solid ${palette.border}` }}>
        {projectId && (
          <Link to={`/project/${projectId}`} style={{ color: palette.textSecondary, textDecoration: 'none', fontSize: '12px' }}
                title="Back to the project">
            ← {projectName || 'Project'}
          </Link>
        )}
        <span style={{ fontWeight: 600 }}>{doc.name}</span>
        <span title="Its drawing comes from code: parts use its outputs"
          style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.6px', padding: '2px 6px', borderRadius: 4,
                   color: palette.accent, border: `1px solid ${palette.accent}` }}>GENERATED</span>
        <div role="tablist" style={{ display: 'flex', border: `1px solid ${palette.inputBorder}`, borderRadius: 4, overflow: 'hidden',
                                     marginLeft: 12 }}>
          <button role="tab" aria-selected={tab === 'drawing'} style={seg(tab === 'drawing')} onClick={() => setTab('drawing')}>Drawing</button>
          <button role="tab" aria-selected={tab === 'code'} style={seg(tab === 'code')} onClick={() => setTab('code')}>
            Code{dirty ? ' •' : ''}
          </button>
        </div>
        {tab === 'drawing' && <button style={btn} onClick={() => setFitKey((k) => k + 1)} title="Fit the drawing to the window">Fit</button>}
        <span style={{ flex: 1 }} />
        {projectId && (
          <div style={{ position: 'relative' }}>
            <button style={btn} onClick={() => setUseMenu((o) => !o)}
              title="Extrude, cut or revolve an output (or the whole sketch) in parts of this project">
              Use in a part ▾
            </button>
            {useMenu && (
              <div role="menu" style={{ position: 'absolute', right: 0, top: 30, zIndex: 30, background: palette.panelBg,
                                        border: `1px solid ${palette.border}`, borderRadius: 6, minWidth: 160,
                                        boxShadow: '0 4px 14px rgba(0,0,0,0.25)' }}>
                {(['extrude', 'cut', 'revolve'] as const).map((o) => (
                  <button key={o} role="menuitem" onClick={() => { setUseMenu(false); setOp(o); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
                             color: palette.text, padding: '7px 12px', cursor: 'pointer', fontSize: '12px' }}>
                    {OP_WORDS[o].button}{picked ? ` ${picked}` : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {errorBox}
          {tab === 'drawing' ? (
            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <SketchDrawing entities={entities} notes={notes} outputs={outputs} checks={checks} users={users} lit={lit}
                onHover={setHover} onPick={setPicked} dimmed={dimmed} fitKey={fitKey}
                hint={hint} onEditAttempt={editAttempt} />
            </div>
          ) : (
            <CodeView code={code} onChange={(c) => { setCode(c); setBroken(null); }} onRun={() => void runCode()}
              running={running} dirty={dirty} error={savedError} broken={broken}
              onUndo={() => { setCode(saved); setBroken(null); }} onSaveAnyway={() => void runCode(true)}
              history={doc.data.codeHistory ?? []} goToLine={goTo} />
          )}
          <SketchChat docId={id} projectId={projectId} messages={chat} update={updateChat} onReply={onReply}
            onRevert={(c) => void revertTo(c)} onParamsAccepted={() => void paramsAccepted().catch((e) => addLog('error', `Couldn't reload after accepting: ${errorText(e)}`))} askRef={askAi}
            placeholder="Ask the AI to change the layout, add a check, or explain a size. It changes the code; click one of its changes to go back to it."
            card={(m) => m.held ? (
              <HeldCard held={m.held} actionKey={cardKey(id, 'held', m.at)} onApply={() => applyHeld(m.at)}
                onKeep={() => updateChat((ms) => withCardStatus(ms, m.at, 'held', 'kept'))} />
            ) : null} />
        </div>

        <aside style={{ width: 310, flexShrink: 0, overflowY: 'auto', background: palette.panelBg,
                        borderLeft: `1px solid ${palette.border}` }}>
          <OutputsPanel outputs={outputs} users={users} lit={lit} onHover={setHover} onPick={setPicked} />
          <ParametersPanel reads={reads} params={params} trial={trial.values} busy={trialBusy}
            onTry={tryValue} onReset={resetTrial} onApply={() => void askApply()} onRange={(n, r) => void setRange(n, r)}
            projectId={projectId}
            note={applied ? (
              <span>
                {applied}{' '}
                {stale.length
                  ? <>{stale.length} part{stale.length === 1 ? ' is' : 's are'} out of date. <button style={{ ...btn, padding: '1px 8px' }}
                      disabled={!!rebuild?.at} onClick={() => void rebuildAll()}>Rebuild all</button></>
                  : 'Every part is up to date.'}
              </span>
            ) : undefined} />
          <ChecksPanel checks={checks} lit={lit} onPick={setPicked} />
          <UsedByPanel users={users} rebuild={rebuild} onRebuildAll={() => void rebuildAll()} />
        </aside>
      </div>

      {confirm && (
        <Modal onClose={() => !applying && setConfirm(null)} label="Apply to project">
          <p style={{ margin: '0 0 14px', lineHeight: 1.5 }}>{confirm.words}</p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button style={btn} disabled={applying} onClick={() => setConfirm(null)}>Cancel</button>
            <button style={{ ...btn, background: palette.primaryBtn, color: '#fff', border: 'none' }} disabled={applying}
              onClick={() => void apply()}>{applying ? 'Applying…' : 'Apply'}</button>
          </div>
        </Modal>
      )}
      {op && projectId && (
        <TargetDialog op={op} docId={id} projectId={projectId} sketchId={sketch.id} sketchName={sketch.name}
          title={doc.name} picks={picks} initialPick={picked ? { kind: 'group', name: picked } : null}
          onClose={() => setOp(null)} />
      )}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  const palette = useThemeStore((s) => s.palette);
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: palette.background, color: palette.textSecondary }}>{children}</div>
  );
}

function Banner({ color, children }: { color: string; children: ReactNode }) {
  const palette = useThemeStore((s) => s.palette);
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', fontSize: '12.5px',
                               background: palette.panelBg, borderBottom: `2px solid ${color}`, color: palette.text }}>
      {children}
    </div>
  );
}

function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const palette = useThemeStore((s) => s.palette);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 50, display: 'flex',
                  alignItems: 'center', justifyContent: 'center' }}
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-label={label} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
           style={{ width: 420, maxWidth: 'calc(100vw - 32px)', background: palette.panelBg, border: `1px solid ${palette.border}`,
                    borderRadius: 8, padding: '16px 18px', color: palette.text, fontSize: '13px',
                    boxShadow: '0 6px 24px rgba(0,0,0,0.35)' }}>
        {children}
      </div>
    </div>
  );
}
