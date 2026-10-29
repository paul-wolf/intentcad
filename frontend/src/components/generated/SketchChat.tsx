/**
 * The sketch chat, in both sketch editors: the part chat's history and box
 * (context files, @-mentions, the model picker), asking POST
 * /api/sketches/{id}/ask. What a reply does is the editor's (`onReply`): a
 * generated sketch saves new code, a drawn one offers a generated sketch.
 * This file also has the two cards those replies show: a change that stops
 * making outputs parts use (applied only when the user says so), and a
 * proposed generated sketch with a picture of it. Proposed project parameters
 * and brief changes get the part chat's cards (ChatHistory), in both kinds.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ApiError, errorText, sketchApi, type SketchAskResponse } from '@/api/client';
import { projectApi } from '@/api/projectClient';
import { useThemeStore, type ThemePalette } from '@/theme';
import type { ChatMessage } from '@/types/document';
import type { GenRunResult } from '@/types/generated';
import { filesToSend, skipList, spendNote, usageLabel } from '@/build/contextFiles';
import { mentionedIds } from '@/utils/mentions';
import { ChatHistory, ChatInput, useChatBox, useModelPicker } from '@/components/ChatPanel';
import { ContextPane, useContextFiles, type CtxColors } from '@/components/ContextPane';
import { useProjectDocs } from '@/components/ProjectChat';
import { SketchDrawing } from './SketchDrawing';
import { clearCardAction, useCardAction } from '@/components/cardAction';

/** The pictures of proposed sketches, by message time: kept for this visit only. */
const pictures = new Map<number, GenRunResult>();

/** How a run's checks went, for the chat: "All 3 checks pass." */
export function runWords(r: GenRunResult | undefined): string {
  if (!r?.ok || !r.checks.length) return '';
  const n = r.checks.length, ok = r.checks.filter((c) => c.ok).length;
  if (ok === n) return n === 1 ? 'The check passes.' : `All ${n} checks pass.`;
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name).join(', ');
  return `${ok} of ${n} checks pass (fails: ${failed}).`;
}

/** Why an AI edit of `base` (the code it edited) waits on its card instead of
 *  replacing the editor's code: unsaved code it didn't see, or code saved here
 *  while it worked. Null: nothing here changed, it can be saved. */
export function heldBecause(editor: string, saved: string, base: string): { changed: true; unsaved?: true } | null {
  if (editor === base) return null;
  return editor !== saved ? { changed: true, unsaved: true } : { changed: true };
}

export function SketchChat({ docId, projectId, messages, update, onReply, onRevert, onParamsAccepted, card, askRef,
                             placeholder, fill = false }: {
  docId: string;
  projectId: string | null;
  messages: ChatMessage[];
  /** change the chat as it is when the change is made, and persist it */
  update: (change: (messages: ChatMessage[]) => ChatMessage[]) => void;
  /** an edit or a proposal: the assistant message to add (the editor saves the code, or not) */
  onReply: (r: SketchAskResponse, at: number, instruction: string) => Promise<Partial<ChatMessage>>;
  onRevert: (code: string) => void;
  onParamsAccepted: () => void;
  card?: (m: ChatMessage, i: number) => ReactNode;
  /** set to a function that sends a message (Fix with AI); with `code`, the
   *  AI edits that (the editor's unsaved code) instead of the saved code.
   *  False: not sent (the AI is still on the last message). */
  askRef?: { current: ((text: string, code?: string) => boolean) | null };
  placeholder: string;
  /** the chat takes its column's height */
  fill?: boolean;
}) {
  const palette = useThemeStore((s) => s.palette);
  const picker = useModelPicker();
  const projectDocs = useProjectDocs(projectId, docId);
  const ctxOwner = useMemo(() => ({ document: docId }), [docId]);
  const ctxStore = useContextFiles(ctxOwner);
  const [asking, setAsking] = useState(false);
  const [showCtx, setShowCtx] = useState(false);
  const box = useChatBox({ docs: projectDocs.others, ctxStore, send: (text) => void send(text) });

  const send = async (text?: string, code?: string) => {
    const instruction = (text ?? box.ask).trim();
    if (!instruction || asking) return;
    if (box.uploading) { box.setSendQueued(instruction); return; }
    setAsking(true);
    setShowCtx(false);
    box.setMention(null);
    const sent = filesToSend(ctxStore.files, box.skipCtx);
    const said0: ChatMessage = { role: 'user', text: instruction, at: Date.now(),
                                 ...(sent.length ? { files: sent.map((f) => f.title) } : {}) };
    update((ms) => [...ms, said0]);
    box.setAsk('');
    try {
      const r = await sketchApi.ask(docId, {
        instruction, model: picker.model,
        history: messages.slice(-8).map((m) => ({ role: m.role, text: m.text })),
        skip_context: skipList(ctxStore.files, box.skipCtx),
        mentions: mentionedIds(instruction, projectDocs.others),
        ...(code !== undefined ? { code } : {}),
      });
      box.setSkipCtx(new Set());
      const at = Date.now();
      const said: ChatMessage = { role: 'assistant', text: '', usage: spendNote(r), at };
      // project parameters and a new brief, as in the part chat: cards to accept or reject
      const brief = r.brief_proposal && projectId ? (await projectApi.getProject(projectId).catch(() => null))?.brief ?? '' : null;
      Object.assign(said, projectCards(r, brief));
      if (r.kind === 'question') Object.assign(said, { kind: 'question', text: r.question || '' });
      else if (r.kind === 'answer') Object.assign(said, { kind: 'answer', text: r.answer || '' });
      else Object.assign(said, await onReply(r, at, instruction));
      // onto the chat as it is now: a card accepted while the AI was thinking stays accepted
      update((ms) => [...ms, said]);
    } catch (err) {
      const spent = err instanceof ApiError && err.usage ? usageLabel(err.usage) : undefined;
      update((ms) => [...ms, { role: 'assistant', kind: 'question', text: `⚠ ${errorText(err)}`, usage: spent, at: Date.now() }]);
    } finally {
      setAsking(false);
    }
  };
  if (askRef) askRef.current = (t, c) => { if (asking) return false; void send(t, c); return true; };

  const ctxColors: CtxColors = {
    text: palette.text, dim: palette.textSecondary, mute: palette.textMuted, border: palette.border,
    surface: palette.background, card: palette.inputBg, accent: palette.accent, primary: palette.primaryBtn,
    danger: palette.danger, warning: palette.warning,
  };
  return (
    <div data-sketch-chat style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: palette.panelBg,
                                   ...(fill ? { flex: 1 } : { borderTop: `1px solid ${palette.border}` }) }}>
      {showCtx ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', maxHeight: fill ? undefined : '40vh' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 12px 0' }}>
            <button onClick={() => setShowCtx(false)} style={linkBtn(palette)}>Back to the chat</button>
          </div>
          <ContextPane store={ctxStore} c={ctxColors} partOwned />
        </div>
      ) : (
        <ChatHistory messages={messages} scope={docId} asking={asking} fill={fill} box={box} palette={palette} projectId={projectId}
          onChange={update} onRevert={onRevert} onParamsAccepted={onParamsAccepted} card={card}
          revertTitle="Go back to the code as it was after this change" revertWords="↩ click to go back to this version" />
      )}
      {!messages.length && !asking && !showCtx && (
        <div style={{ padding: '8px 16px 0', fontSize: '12px', color: palette.textSecondary, lineHeight: 1.45 }}>{placeholder}</div>
      )}
      <ChatInput box={box} asking={asking} palette={palette} ctxStore={ctxStore} ctxColors={ctxColors}
        docs={projectDocs.others} picker={picker} hasMessages={messages.length > 0} showCtxError={!showCtx}
        onSend={() => void send()} onClear={() => update(() => [])} onOpenContext={() => setShowCtx(true)}
        placeholder={(w) => (w >= 420 && projectDocs.others.length ? 'Describe a change or ask; type @ to mention a part'
                             : w >= 260 ? 'Describe a change or ask a question' : 'Ask the AI')} />
    </div>
  );
}

const linkBtn = (palette: ThemePalette): CSSProperties => ({
  background: 'none', border: `1px solid ${palette.inputBorder}`, borderRadius: 4, color: palette.textSecondary,
  cursor: 'pointer', fontSize: '12px', padding: '3px 9px',
});

const cardBox = (palette: ThemePalette, color: string): CSSProperties => ({
  marginTop: 5, padding: '9px 11px', borderRadius: 8, border: `1px solid ${color}`, background: palette.panelBg,
  fontSize: '12.5px', lineHeight: 1.45, color: palette.text, display: 'flex', flexDirection: 'column', gap: 7,
});

function Buttons({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{children}</div>;
}

export function CardButton({ primary, busy, onClick, children }: {
  primary?: boolean; busy?: boolean; onClick: () => void; children: ReactNode;
}) {
  const palette = useThemeStore((s) => s.palette);
  return (
    <button disabled={busy} onClick={onClick}
      style={{ ...linkBtn(palette), color: primary ? '#fff' : palette.text, opacity: busy ? 0.6 : 1,
               ...(primary ? { background: palette.primaryBtn, border: 'none' } : {}) }}>
      {children}
    </button>
  );
}

/** New code that stops making outputs parts use, that needs project
 *  parameters not accepted yet, or an AI edit of a part or sketch changed
 *  while it worked (here, or in another tab or browser): nothing is saved
 *  until the user says. */
export function HeldCard({ held, params = false, actionKey, onApply, onKeep, onAskAgain, what = 'part' }: {
  held: NonNullable<ChatMessage['held']>;
  /** (a changed part) the edit also reads project parameters not accepted yet */
  params?: boolean;
  /** where Apply is kept while it runs (see cardAction) */
  actionKey: string;
  /** throws what went wrong: the card shows it, with Try again */
  onApply: () => Promise<void>;
  onKeep: () => void;
  /** (a changed part or sketch) send the same request again, on the version there is now */
  onAskAgain?: () => void;
  /** what was changed, in the card's words */
  what?: 'part' | 'sketch';
}) {
  const palette = useThemeStore((s) => s.palette);
  const { busy, error, run } = useCardAction(actionKey);
  if (held.status !== 'pending') {
    return (
      <div style={{ fontSize: '11.5px', color: palette.textMuted, marginTop: 3, paddingLeft: 4 }}>
        {held.status === 'applied' ? '✓ applied' : held.status === 'again' ? 'Asked again on your version'
          : held.changed ? 'Kept your version' : 'Kept the old code'}
      </div>
    );
  }
  return (
    <div role="group" aria-label="Confirm the change" style={cardBox(palette, palette.warning)}>
      {held.changed ? (
        <span>
          {held.elsewhere
            ? `The ${what} was changed in another tab or browser while the AI was working on it, so its edit wasn't applied${
                held.elsewhere === 'shown' ? '; this tab now shows that version' : '; your unsaved changes here are still on screen'}.`
            : held.unsaved ? `Your ${what} has changes the AI didn't see, so its edit wasn't applied.`
            : `You changed the ${what} while the AI was working on it, so its edit wasn't applied.`}{' '}
          The edit is of the {what} as it was when you asked: applying it replaces {held.elsewhere === 'unsaved' ? 'that change and yours' : held.elsewhere ? 'that change' : 'your change'} (kept in Earlier versions){params ? ', and it uses the new project parameters above (accept them first)' : ''}.
        </span>
      ) : held.broken.length ? (
        <>
          <span>
            This change stops making {held.broken.map((b) => b.name).join(', ')}, which{' '}
            {held.broken.flatMap((b) => b.parts).filter((p, i, a) => a.indexOf(p) === i).join(', ')} use
            {held.broken.length === 1 ? 's' : ''}. Those parts would fail to build until they use another output.
          </span>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '12px', color: palette.textSecondary }}>
            {held.broken.map((b) => <li key={b.name}><code>{b.name}</code>: used by {b.parts.join(', ')}</li>)}
          </ul>
        </>
      ) : (
        <span>This code uses the new project parameters above. Accept them first, or apply it now and it shows an error until you do.</span>
      )}
      {error && <span role="alert" style={{ color: palette.danger }}>Couldn't apply it: {error}</span>}
      <Buttons>
        <CardButton primary busy={busy} onClick={() => void run(onApply)}>
          {busy ? 'Applying…' : error ? 'Try again' : held.changed ? 'Apply the AI\'s edit' : held.broken.length ? 'Apply anyway' : 'Apply now'}
        </CardButton>
        <CardButton busy={busy} onClick={() => { clearCardAction(actionKey); onKeep(); }}>
          {held.changed ? 'Keep my version' : 'Keep the old code'}
        </CardButton>
        {held.changed && onAskAgain && <CardButton busy={busy} onClick={onAskAgain}>Ask again on my version</CardButton>}
      </Buttons>
    </div>
  );
}

/** A generated sketch the AI offers in a drawn one: a picture of it, its
 *  outputs and checks, and Make it / No, I'll draw it. */
export function ProposalCard({ proposal, at, actionKey, onAccept, onDecline }: {
  proposal: NonNullable<ChatMessage['proposal']>;
  at: number;
  /** where Make it is kept while it runs (see cardAction) */
  actionKey: string;
  /** throws what went wrong: the card shows it, with Try again */
  onAccept: () => Promise<void>;
  onDecline: () => void;
}) {
  const palette = useThemeStore((s) => s.palette);
  const { busy, error, run } = useCardAction(actionKey);
  const picture = pictures.get(at);
  if (proposal.status !== 'pending') {
    return (
      <div style={{ fontSize: '11.5px', color: palette.textMuted, marginTop: 3, paddingLeft: 4 }}>
        {proposal.status === 'accepted' ? `✓ made “${proposal.name}”` : 'Declined: drawing it by hand'}
      </div>
    );
  }
  return (
    <div role="group" aria-label="Proposed generated sketch" style={cardBox(palette, palette.accent)}>
      <div style={{ fontWeight: 600 }}>{proposal.name} <span style={{ fontWeight: 400, color: palette.textSecondary }}>(generated)</span></div>
      {picture?.ok && (
        <div style={{ height: 150, display: 'flex', border: `1px solid ${palette.border}`, borderRadius: 6, overflow: 'hidden',
                      background: palette.background }}>
          <SketchDrawing entities={picture.entities} notes={null} outputs={picture.outputs} users={[]} lit={new Set()}
            interactive={false} />
        </div>
      )}
      {proposal.outputs.length > 0 && (
        <div style={{ fontSize: '12px' }}>
          <span style={{ color: palette.textSecondary }}>Outputs parts can use: </span>
          {proposal.outputs.join(', ')}
        </div>
      )}
      {proposal.checks && <div style={{ fontSize: '12px', color: palette.textSecondary }}>{proposal.checks}</div>}
      {error && <span role="alert" style={{ color: palette.danger }}>Couldn't make it: {error}</span>}
      <Buttons>
        <CardButton primary busy={busy} onClick={() => void run(onAccept)}>
          {busy ? 'Making it…' : error ? 'Try again' : proposal.empty ? 'Make it a generated sketch' : 'Make a new generated sketch'}
        </CardButton>
        <CardButton busy={busy} onClick={() => { clearCardAction(actionKey); onDecline(); }}>No, I'll draw it</CardButton>
      </Buttons>
      {!proposal.empty && (
        <div style={{ fontSize: '11.5px', color: palette.textMuted }}>
          This sketch has drawing in it, so it stays as it is and the generated one is a new sketch.
        </div>
      )}
    </div>
  );
}

/** The project cards a reply brings, in any kind of reply: its proposed
 *  parameters (one card for all of them) and brief (a diff against `brief`,
 *  the brief now; null outside a project). */
export function projectCards(r: SketchAskResponse, brief: string | null): Pick<ChatMessage, 'params' | 'brief'> {
  const out: Pick<ChatMessage, 'params' | 'brief'> = {};
  if (r.parameter_proposals?.length) out.params = { items: r.parameter_proposals, status: 'pending' };
  if (r.brief_proposal && brief !== null) {
    out.brief = { text: r.brief_proposal.text, reason: r.brief_proposal.reason, base: brief, status: 'pending' };
  }
  return out;
}

/** A proposal reply as a chat message (the picture kept for this visit). */
export function proposalMessage(r: SketchAskResponse, at: number): Partial<ChatMessage> {
  if (r.result) pictures.set(at, r.result);
  const ok = r.result?.ok ? r.result : null;
  return {
    kind: 'answer', text: r.sentence || 'I can make this a generated sketch.',
    proposal: { name: r.name || 'Generated sketch', code: r.code || '', empty: !!r.empty,
                outputs: ok ? ok.outputs.map((o) => `${o.name} (${o.size})`) : [],
                checks: runWords(r.result), status: 'pending' },
  };
}
