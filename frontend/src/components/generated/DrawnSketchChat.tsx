/**
 * The sketch chat in the drawn sketch editor: a column on the right (open
 * when the sketch is empty, else folded to a tab). The AI can't change drawn
 * shapes; it answers, and for a layout that follows rules it offers a
 * generated sketch: an empty sketch becomes it, any other gets a new one.
 * Also the hint on an empty sketch: draw, ask the AI, or write it as code.
 */
import { useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useThemeStore } from '@/theme';
import { errorText, sketchApi, type SketchAskResponse } from '@/api/client';
import { getBackendId, getProjectId, persistChat, setBackendId, subscribeProjectContext } from '@/api/autoSave';
import { useDocumentStore } from '@/stores/documentStore';
import { isAxis } from '@/utils/sketchAxes';
import { addLog } from '@/stores/logStore';
import type { ChatMessage, Entity } from '@/types/document';
import { CardButton, ProposalCard, SketchChat, proposalMessage } from './SketchChat';

const EMPTY: ChatMessage[] = [];

/** Nothing drawn (the built-in axes aside; and no part script): it can become generated in place. */
const nothingDrawn = (d: { modelCode?: string; sketches: { entities: Entity[] }[] }) =>
  !d.modelCode?.trim() && d.sketches.every((k) => k.entities.every(isAxis));

export function useSketchEmpty(): boolean {
  return useDocumentStore((s) => nothingDrawn(s.document));
}

/** Make this (empty) drawn sketch generated, in place: the drawn editor stops
 *  saving first, so nothing it had pending overwrites the generated sketch. */
async function convertInPlace(id: string, body: { code?: string; name?: string }, chat: ChatMessage[] | null,
                              onGenerated: () => void) {
  setBackendId(null);
  try {
    await sketchApi.create({ from_document: id, ...body });
  } catch (e) {
    setBackendId(id);
    throw e;
  }
  if (chat) await sketchApi.saveChat(id, chat).catch(() => {});
  onGenerated();
}

export function DrawnSketchChat({ id, onGenerated }: { id: string; onGenerated: () => void }) {
  const palette = useThemeStore((s) => s.palette);
  const navigate = useNavigate();
  const projectId = useSyncExternalStore(subscribeProjectContext, getProjectId);
  const messages = useDocumentStore((s) => s.document.chat ?? EMPTY);
  const empty = useSketchEmpty();
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? empty;

  const change = (i: number, status: 'accepted' | 'declined') => messages.map((m, j) =>
    (j === i && m.proposal ? { ...m, proposal: { ...m.proposal, status } } : m));
  const accept = async (i: number) => {
    const p = messages[i]?.proposal;
    if (!p) return;
    const done = change(i, 'accepted');
    try {
      if (p.empty && nothingDrawn(useDocumentStore.getState().document)) {
        await convertInPlace(id, { code: p.code, name: p.name }, done, onGenerated);
        return;
      }
      const r = await sketchApi.create({ from_document: id, code: p.code, name: p.name });
      persistChat(done);
      // the new sketch starts with this conversation, so its chat goes on from here
      await sketchApi.saveChat(r.id, done.slice(-12)).catch(() => {});
      navigate(`/edit/${r.id}`);
    } catch (e) {
      addLog('error', `Couldn't make the generated sketch: ${errorText(e)}`);
    }
  };
  const onReply = async (r: SketchAskResponse, at: number): Promise<Partial<ChatMessage>> =>
    r.kind === 'proposal' ? proposalMessage(r, at) : { kind: 'answer', text: r.note || r.answer || '' };

  if (!shown) {
    return (
      <button onClick={() => setOpen(true)} title="Ask the AI about this sketch, or have it generate one from rules"
        style={{ width: 28, flexShrink: 0, background: palette.panelBg, border: 'none', borderLeft: `1px solid ${palette.border}`,
                 color: palette.textSecondary, cursor: 'pointer', fontSize: '12px', writingMode: 'vertical-rl', padding: '12px 0' }}>
        AI chat{messages.length ? ` (${messages.length})` : ''}
      </button>
    );
  }
  return (
    <aside aria-label="Sketch chat" style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column',
                                             borderLeft: `1px solid ${palette.border}`, background: palette.panelBg }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', borderBottom: `1px solid ${palette.border}`,
                    fontSize: '11px', fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase', color: palette.textMuted }}>
        <span style={{ flex: 1 }}>AI chat</span>
        <button onClick={() => setOpen(false)} aria-label="Fold the chat" title="Fold the chat"
          style={{ background: 'none', border: 'none', color: palette.textSecondary, cursor: 'pointer', fontSize: '14px' }}>›</button>
      </div>
      <SketchChat docId={id} projectId={projectId} messages={messages} persist={persistChat} onReply={onReply}
        onRevert={() => {}} onParamsAccepted={() => {}} fill
        placeholder={empty
          ? 'Describe the layout, for example "a hexagon frame plate from the project parameters, with holes for the arm braces". The AI offers to generate it from code, so it follows the parameters.'
          : "Ask about this sketch. The AI can't move drawn shapes; for a layout that follows rules it can make a generated sketch."}
        card={(m, i) => m.proposal ? (
          <ProposalCard proposal={m.proposal} at={m.at} onAccept={() => accept(i)}
            onDecline={() => persistChat(change(i, 'declined'))} />
        ) : null} />
    </aside>
  );
}

/** Over an empty drawn sketch: what to do first. */
export function EmptySketchHint({ id, onGenerated }: { id: string; onGenerated: () => void }) {
  const palette = useThemeStore((s) => s.palette);
  const empty = useSketchEmpty();
  const [busy, setBusy] = useState(false);
  if (!empty || getBackendId() !== id) return null;
  const asCode = async () => {
    setBusy(true);
    try {
      await convertInPlace(id, {}, null, onGenerated);
    } catch (e) {
      addLog('error', `Couldn't make it a generated sketch: ${errorText(e)}`);
      setBusy(false);
    }
  };
  return (
    <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 6,
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8,
                  background: palette.panelBg, border: `1px solid ${palette.border}`, boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
                  fontSize: '12.5px', color: palette.text, maxWidth: 'calc(100% - 32px)' }}>
      <span>Draw with the tools, or describe the layout to the AI on the right.</span>
      <CardButton busy={busy} onClick={() => void asCode()}>Write it as code instead</CardButton>
    </div>
  );
}
