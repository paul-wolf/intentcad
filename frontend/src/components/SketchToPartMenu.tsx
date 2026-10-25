/**
 * Over a project sketch in the sketch editor: Extrude… / Cut… / Revolve…,
 * which pick the parts to do it to (or a new part) and hand the operation to
 * the part editor (build/sketchToPart.ts), one part after another.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { api } from '@/api/cachedClient';
import { errorText, type DocumentListItem } from '@/api/client';
import { flushSaveAsync, getBackendId, getProjectId, subscribeBackendId, subscribeProjectContext } from '@/api/autoSave';
import { createEmptyPart, generateNumberedName, isSketchDocument } from '@/utils/document';
import { addLog } from '@/stores/logStore';
import { aliasFor, OP_WORDS, partNameFor, pickFor, saveHandoff, type Handoff, type HandoffOp, type SkPick } from '@/build/sketchToPart';

const isSketchDoc = isSketchDocument;

export function SketchToPartMenu() {
  const palette = useThemeStore((s) => s.palette);
  const sketchDoc = useDocumentStore((s) => isSketchDoc(s.document));
  const sketch = useDocumentStore((s) => s.getActiveSketch());
  const backendId = useSyncExternalStore(subscribeBackendId, getBackendId);
  const projectId = useSyncExternalStore(subscribeProjectContext, getProjectId);
  const [op, setOp] = useState<HandoffOp | null>(null);
  if (!sketchDoc || !sketch || !backendId || !projectId) return null;
  const btn: React.CSSProperties = {
    background: 'none', border: 'none', color: palette.text, cursor: 'pointer', fontSize: '12px', padding: '4px 10px',
  };
  return (
    <>
      <div style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 5,
                    display: 'flex', alignItems: 'center', gap: '2px', padding: '2px 6px', background: palette.panelBg,
                    border: `1px solid ${palette.border}`, borderRadius: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.2)' }}>
        <span style={{ fontSize: '11px', color: palette.textMuted, padding: '0 4px' }}>Make parts:</span>
        {(['extrude', 'cut', 'revolve'] as const).map((o) => (
          <button key={o} style={btn} onClick={() => setOp(o)}
                  title={`${OP_WORDS[o].verb} this sketch (or its selected group) in parts of this project`}>
            {OP_WORDS[o].button}
          </button>
        ))}
      </div>
      {op && <TargetDialog op={op} docId={backendId} projectId={projectId} onClose={() => setOp(null)} />}
    </>
  );
}

function TargetDialog({ op, docId, projectId, onClose }: { op: HandoffOp; docId: string; projectId: string; onClose: () => void }) {
  const palette = useThemeStore((s) => s.palette);
  const navigate = useNavigate();
  const sketch = useDocumentStore((s) => s.getActiveSketch())!;
  const sketches = useDocumentStore((s) => s.document.sketches);
  const docName = useDocumentStore((s) => s.document.name);
  const selected = useEditorStore((s) => s.selectedEntityIds);
  const [docs, setDocs] = useState<DocumentListItem[] | null>(null);
  const [parts, setParts] = useState<Set<string>>(new Set());
  const [newPart, setNewPart] = useState(op !== 'cut');
  const [pick, setPick] = useState<SkPick>(() => pickFor(sketch, [...selected]));
  const title = sketches.length === 1 ? docName : sketch.name;   // what the sketch is called in the project
  const alias = aliasFor(title);   // what the scripts call it; a part that has one keeps its own
  const [partName, setPartName] = useState(() => partNameFor(title));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.listDocuments(projectId)
      .then((l) => { if (live) setDocs(l.filter((d) => d.kind === 'part')); })
      .catch((e) => { if (live) { setDocs([]); addLog('error', `Couldn't list the project's parts: ${errorText(e)}`); } });
    return () => { live = false; };
  }, [projectId]);

  const toggle = (id: string) => setParts((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const picks: { key: string; label: string; pick: SkPick }[] = [
    { key: '', label: 'The whole sketch', pick: null },
    ...(sketch.groups ?? []).map((g) => ({ key: `g:${g.name}`, label: `Group: ${g.name}`, pick: { kind: 'group' as const, name: g.name } })),
    ...sketch.entities.filter((e) => e.name?.trim()).map((e) => ({ key: `n:${e.name!.trim()}`, label: `Named: ${e.name!.trim()}`, pick: { kind: 'named' as const, name: e.name!.trim() } })),
  ];
  const pickKey = pick ? `${pick.kind === 'group' ? 'g' : 'n'}:${pick.name}` : '';
  const chosen = (docs ?? []).filter((d) => parts.has(d.id));
  const count = chosen.length + (newPart ? 1 : 0);
  const nameOk = !newPart || !!partName.trim();

  const start = async () => {
    setBusy(true);
    try {
      await flushSaveAsync();   // the parts read the sketch as saved
      const list: Handoff['parts'] = chosen.map((d) => ({ id: d.id, name: d.name }));
      if (newPart) {
        const want = partName.trim();
        const name = (docs ?? []).some((d) => d.name === want) ? generateNumberedName(want, (docs ?? []).map((d) => d.name)) : want;
        const doc = { ...createEmptyPart(name), sketchRefs: { [alias]: { document: docId, sketch: sketch.id } } };
        const saved = await api.createDocument(name, doc as unknown as Record<string, unknown>, projectId);
        list.unshift({ id: saved.id, name, isNew: true });
      }
      saveHandoff({ op, sketchDoc: docId, sketchId: sketch.id, sketchName: sketch.name, alias, pick,
                    parts: list, at: 0, done: [], skipped: [] });
      navigate(`/part/${list[0]!.id}`);
    } catch (e) {
      addLog('error', `Couldn't start the ${OP_WORDS[op].verb.toLowerCase()}: ${errorText(e)}`);
      setBusy(false);
    }
  };

  const label: React.CSSProperties = { display: 'block', fontSize: '11px', color: palette.textMuted, margin: '10px 0 4px' };
  const input: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', background: palette.inputBg, color: palette.text,
    border: `1px solid ${palette.inputBorder}`, borderRadius: '4px', padding: '4px 6px', fontSize: '12px',
  };
  const btn: React.CSSProperties = {
    background: 'none', border: `1px solid ${palette.inputBorder}`, borderRadius: '4px',
    color: palette.text, cursor: 'pointer', fontSize: '12px', padding: '4px 12px',
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 50, display: 'flex',
                  alignItems: 'center', justifyContent: 'center' }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-label={`${OP_WORDS[op].verb} in parts`}
           style={{ width: '380px', maxWidth: 'calc(100vw - 32px)', maxHeight: '80vh', overflowY: 'auto', background: palette.panelBg,
                    border: `1px solid ${palette.border}`, borderRadius: '8px', padding: '14px 16px', color: palette.text,
                    fontSize: '12px', boxShadow: '0 6px 24px rgba(0,0,0,0.35)' }}
           onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <div style={{ fontWeight: 600, fontSize: '13px' }}>{OP_WORDS[op].verb} “{title}” in parts</div>
        <div style={{ color: palette.textMuted, marginTop: '4px' }}>
          Each part opens in turn with the {op === 'revolve' ? 'Revolve' : 'Extrude'} dialog ready; you set the
          {op === 'revolve' ? ' axis and angle' : op === 'cut' ? ' depth' : ' height'} and where it goes there.
        </div>

        <label style={label}>Shapes</label>
        <select style={input} value={pickKey} onChange={(e) => setPick(picks.find((p) => p.key === e.target.value)?.pick ?? null)}>
          {picks.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>

        <label style={label}>Parts</label>
        {docs === null ? <div style={{ color: palette.textMuted }}>Loading…</div> : (
          <div style={{ border: `1px solid ${palette.border}`, borderRadius: '4px', padding: '4px 6px', maxHeight: '180px', overflowY: 'auto' }}>
            {op !== 'cut' && (
              <label style={{ display: 'flex', gap: '6px', alignItems: 'center', padding: '2px 0' }}>
                <input type="checkbox" checked={newPart} onChange={(e) => setNewPart(e.target.checked)} />
                <b>New part</b>
              </label>
            )}
            {op !== 'cut' && newPart && (
              <input style={{ ...input, margin: '0 0 4px 22px', width: 'calc(100% - 22px)' }} value={partName}
                     onChange={(e) => setPartName(e.target.value)} placeholder="Name of the new part" aria-label="Name of the new part" />
            )}
            {docs.map((d) => (
              <label key={d.id} style={{ display: 'flex', gap: '6px', alignItems: 'center', padding: '2px 0' }}>
                <input type="checkbox" checked={parts.has(d.id)} onChange={() => toggle(d.id)} />
                {d.name}
              </label>
            ))}
            {!docs.length && op === 'cut' && <div style={{ color: palette.textMuted }}>This project has no parts to cut yet.</div>}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' }}>
          <button style={btn} onClick={onClose}>Cancel</button>
          <button style={{ ...btn, borderColor: palette.accent, color: palette.accent, opacity: count && nameOk && !busy ? 1 : 0.5 }}
                  disabled={!count || !nameOk || busy} onClick={() => void start()}>
            {count > 1 ? `Start (${count} parts)` : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
