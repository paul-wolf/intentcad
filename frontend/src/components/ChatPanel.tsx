/**
 * The AI chat, as the part editor shows it: the conversation (each edit a
 * checkpoint to click back to, questions marked, proposals to accept) and the
 * box below it (context-file chips, attach / drop / paste, @-mentions, the
 * model picker, Ask and Clear). What a message does is the editor's: it
 * passes `send`, and the history's revert and proposal callbacks.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { buildApi, type DocumentListItem, type ModelInfo, type ModelsResponse } from '@/api/client';
import type { ThemePalette } from '@/theme';
import type { ChatMessage } from '@/types/document';
import { useAuthStore } from '@/stores/authStore';
import { acceptable, chatUsageNote, filesToSend } from '@/build/contextFiles';
import { chooseModel, modelsStale } from '@/build/modelList';
import { insertMention, matchMentions, mentionQuery } from '@/utils/mentions';
import { Markdown } from '@/ui/Markdown';
import { ParameterProposalCard } from './ParameterProposalCard';
import { cardKey, withCardStatus } from './cardAction';
import { BriefProposalCard, MentionMenu } from './ProjectChat';
import { ContextChips, type ContextStore, type CtxColors } from './ContextPane';

/** Model picker. The list comes from the server (which asks the Models API);
 *  '' means "server default" until the list arrives. The page asks again when
 *  its list is old — on coming back to the tab or focusing the picker — so a
 *  new model shows up without a reload. Someone who never chose follows the
 *  default; a remembered pick the API no longer offers falls back to it. */
export function useModelPicker() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsSource, setModelsSource] = useState<ModelsResponse['source'] | null>(null);
  const modelsAt = useRef(0);
  const modelsLoading = useRef(false);
  const [model, setModel] = useState<string>(() => { try { return localStorage.getItem('intentcad-edit-model') || ''; } catch { return ''; } });
  const pickModel = (m: string) => { setModel(m); try { localStorage.setItem('intentcad-edit-model', m); } catch { /* ignore */ } };
  const loadModels = useRef((refresh: boolean) => {
    if (modelsLoading.current) return;
    modelsLoading.current = true;
    buildApi.models(refresh).then((r) => {
      modelsAt.current = Date.now();
      setModels(r.models);
      setModelsSource(r.source);
      let picked = false;
      try { picked = !!localStorage.getItem('intentcad-edit-model'); } catch { /* ignore */ }
      setModel((cur) => chooseModel(cur, r, picked));
    }).catch(() => { /* keep the free-text id; the server falls back to its default */ })
      .finally(() => { modelsLoading.current = false; });
  }).current;
  const modelsSourceRef = useRef(modelsSource);
  modelsSourceRef.current = modelsSource;
  const refreshModelsIfStale = () => {
    if (modelsStale(modelsAt.current, modelsSourceRef.current, Date.now())) loadModels(true);
  };
  useEffect(() => {
    loadModels(false);
    const onVisible = () => { if (document.visibilityState === 'visible') refreshModelsIfStale(); };
    window.addEventListener('focus', refreshModelsIfStale);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refreshModelsIfStale);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const modelTitle = (m: ModelInfo) =>
    `${m.label} — ${m.note}. $${m.input_per_m}/M in · $${m.output_per_m}/M out (released ${m.released})`
    + (modelsSource === 'static' ? '. Offline list: the Models API could not be reached; retrying.' : '');
  return { models, model, pickModel, refreshModelsIfStale, modelTitle };
}
export type ModelPicker = ReturnType<typeof useModelPicker>;

/** The message box's state: the text, the @-mention being typed, the files
 *  left out of the next message, an upload in progress (and a message waiting
 *  for it), the box's width. `send` is called with a message queued while its
 *  file was uploading, once the upload is in. */
export function useChatBox({ docs, ctxStore, send }: {
  docs: DocumentListItem[]; ctxStore: ContextStore; send: (text: string) => void;
}) {
  const [ask, setAsk] = useState('');
  const [mention, setMention] = useState<{ start: number; query: string; active: number } | null>(null);
  // files left out of the next message only (the chips' ×); cleared after it is sent
  const [skipCtx, setSkipCtx] = useState<ReadonlySet<string>>(new Set());
  const [uploading, setUploading] = useState('');
  // a message sent while its file was still uploading: sent once the upload is in
  const [sendQueued, setSendQueued] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // the message box's width, for a placeholder that fits
  const [inputW, setInputW] = useState(0);
  const inputObs = useRef<ResizeObserver | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setInputEl = useCallback((el: HTMLInputElement | null) => {
    inputRef.current = el;
    inputObs.current?.disconnect();
    if (!el || typeof ResizeObserver === 'undefined') return;
    inputObs.current = new ResizeObserver(() => setInputW(el.offsetWidth));
    inputObs.current.observe(el);
  }, []);
  const sendRef = useRef(send);
  sendRef.current = send;

  // the upload is in and the skip set updated (same render): now send
  useEffect(() => {
    if (uploading || sendQueued === null) return;
    setSendQueued(null);
    sendRef.current(sendQueued);
  }, [uploading, sendQueued]);

  // @-mentions: the menu follows the @-word before the caret; a pick puts "@Name " in its place
  const trackMention = (text: string, caret: number | null) => {
    const q = docs.length && caret !== null ? mentionQuery(text, caret) : null;
    setMention((cur) => (q ? { ...q, active: cur && cur.start === q.start ? cur.active : 0 } : null));
  };
  const pickMention = (name: string) => {
    const el = inputRef.current;
    if (!mention || !el) return;
    const next = insertMention(ask, mention.start, el.selectionStart ?? ask.length, name);
    setAsk(next.text);
    setMention(null);
    window.setTimeout(() => { el.focus(); el.setSelectionRange(next.caret, next.caret); }, 0);
  };
  // images pasted or dropped into the chat: added to this document, in context
  const attach = async (list: File[]) => {
    const ok = list.filter(acceptable);
    if (!ok.length) { ctxStore.setError('Only PDF, PNG, JPEG, WebP or HEIC files can go with a message.'); return; }
    for (const f of ok) {
      setUploading(f.name || 'image');
      // a pasted screenshot is called image.png; give it a name worth citing
      const named = f.name && f.name !== 'image.png' ? f
        : new File([f], `pasted-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.${f.type.split('/')[1] || 'png'}`, { type: f.type });
      const added = await ctxStore.upload('part', named);
      if (added && !added.in_context) await ctxStore.update(added.id, { in_context: true });
      if (added) setSkipCtx((cur) => { if (!cur.has(added.id)) return cur; const n = new Set(cur); n.delete(added.id); return n; });
    }
    setUploading('');
    inputRef.current?.focus();
  };
  const pickFiles = () => fileRef.current?.click();
  return { ask, setAsk, mention, setMention, skipCtx, setSkipCtx, uploading, sendQueued, setSendQueued,
           dragging, setDragging, fileRef, inputRef, setInputEl, inputW, trackMention, pickMention, attach, pickFiles };
}
export type ChatBox = ReturnType<typeof useChatBox>;

const paperclip = (size: number) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

/** The conversation. `fill`: it takes the column's height (else at most 30%
 *  of the window). An edit with code is a checkpoint: clicking it calls
 *  `onRevert`. `scrollKey`: a change keeps the latest message in view. */
export function ChatHistory({ messages, scope, asking, fill, box, palette, projectId, onChange, onRevert, onParamsAccepted, scrollKey,
                              revertTitle = 'Revert the model to this version', revertWords = '↩ click to revert here', card }: {
  messages: ChatMessage[];
  /** whose chat it is (the document id): its cards' saves are kept under it */
  scope: string;
  asking: boolean; fill: boolean; box: ChatBox; palette: ThemePalette;
  projectId: string | null;
  /** change the chat as it is when the change is made, and persist it */
  onChange: (change: (messages: ChatMessage[]) => ChatMessage[]) => void;
  onRevert: (code: string) => void;
  onParamsAccepted: () => void; scrollKey?: unknown; revertTitle?: string; revertWords?: string;
  /** a card of the editor's own under a message (the sketch chat's proposals) */
  card?: (m: ChatMessage, i: number) => ReactNode;
}) {
  const user = useAuthStore((st) => st.user);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;   // keep the latest message in view
  }, [messages, asking, scrollKey]);
  return (
    <div ref={scrollRef} style={{ ...(fill ? { flex: 1, minHeight: 0 } : { maxHeight: '30vh' }), overflowY: 'auto', padding: '10px 16px',
                                  display: 'flex', flexDirection: 'column', gap: '7px' }}>
      {messages.map((m, i) => {
        const mine = m.role === 'user';
        const revertable = m.role === 'assistant' && m.kind === 'edit' && !!m.code;
        const isQ = m.kind === 'question';
        return (
          <div key={`${m.at}-${i}`} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
            <div onClick={revertable ? () => onRevert(m.code!) : undefined}
              title={revertable ? revertTitle : undefined}
              style={{ padding: '7px 11px', borderRadius: '10px', fontSize: '13px', lineHeight: 1.45,
                       whiteSpace: 'pre-wrap', color: mine ? '#fff' : palette.text,
                       background: mine ? palette.primaryBtn : palette.inputBg,
                       border: `1px solid ${isQ ? (palette.warning ?? '#c78a1a') : palette.border}`,
                       cursor: revertable ? 'pointer' : 'default' }}>
              {isQ && <span style={{ color: palette.warning ?? '#c78a1a', fontWeight: 700, marginRight: 5 }}>?</span>}
              {m.kind === 'answer'
                ? <Markdown text={m.text} color={palette.text} dim={palette.textSecondary} border={palette.border}
                    codeBg={palette.background} style={{ whiteSpace: 'normal' }} />
                : m.text}
              {m.files?.length ? (
                <span style={{ display: 'block', fontSize: '11px', opacity: 0.75, marginTop: 3 }}>
                  📎 {m.files.join(', ')}
                </span>
              ) : null}
              {revertable && (
                <span style={{ display: 'block', fontSize: '11px', opacity: 0.6, marginTop: 3 }}>
                  {revertWords}
                </span>
              )}
            </div>
            {!mine && isQ && i === messages.length - 1 && !m.text.startsWith('⚠') && (
              <button onClick={box.pickFiles} disabled={!!box.uploading}
                title="Answer with a photo, drawing or datasheet (or type your answer below); add a sentence before you send"
                style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px',
                         background: 'none', color: palette.accent ?? palette.text, border: `1px solid ${palette.border}`,
                         borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>
                {paperclip(12)} Attach a file
              </button>
            )}
            {m.params && (
              <ParameterProposalCard params={m.params} projectId={projectId} palette={palette} actionKey={cardKey(scope, 'params', m.at)}
                onStatus={(status) => onChange((ms) => withCardStatus(ms, m.at, 'params', status))}
                onAccepted={onParamsAccepted} />
            )}
            {m.brief && (
              <BriefProposalCard brief={m.brief} projectId={projectId} palette={palette} actionKey={cardKey(scope, 'brief', m.at)}
                onStatus={(status) => onChange((ms) => withCardStatus(ms, m.at, 'brief', status))} />
            )}
            {card?.(m, i)}
            {chatUsageNote(user, m.usage) && (
              <div title="This call: input tokens (of them, read from the prompt cache) · output tokens · cost"
                style={{ fontSize: '10.5px', color: palette.textSecondary, marginTop: 2, paddingLeft: 4 }}>
                {m.usage}
              </div>
            )}
          </div>
        );
      })}
      {asking && (
        <div style={{ alignSelf: 'flex-start', fontSize: '12px', color: palette.textSecondary }}>thinking…</div>
      )}
    </div>
  );
}

/** The message box. `placeholder` gets the box's width, so the hint fits. */
export function ChatInput({ box, asking, palette, ctxStore, ctxColors, docs, picker, placeholder, hasMessages,
                            showCtxError, onSend, onClear, onOpenContext }: {
  box: ChatBox; asking: boolean; palette: ThemePalette; ctxStore: ContextStore; ctxColors: CtxColors;
  docs: DocumentListItem[]; picker: ModelPicker; placeholder: (width: number) => string; hasMessages: boolean;
  showCtxError: boolean; onSend: () => void; onClear: () => void; onOpenContext: () => void;
}) {
  const { ask, mention, setMention } = box;
  const { models, model } = picker;
  return (
  <div onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); box.setDragging(true); } }}
    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) box.setDragging(false); }}
    onDrop={(e) => { box.setDragging(false); const l = [...e.dataTransfer.files]; if (l.length) { e.preventDefault(); void box.attach(l); } }}
    style={{ position: 'relative', outline: box.dragging ? `2px dashed ${palette.accent ?? palette.border}` : 'none', outlineOffset: -3 }}>
  {box.dragging && (
    <div style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', gap: 6, background: `${palette.background}d9`, color: palette.accent ?? palette.text,
                  fontSize: '13px', fontWeight: 600 }}>
      {paperclip(14)} Drop to attach
    </div>
  )}
  <input ref={box.fileRef} type="file" multiple accept="image/*,application/pdf" style={{ display: 'none' }}
    onChange={(e) => { const l = [...(e.target.files ?? [])]; e.target.value = ''; if (l.length) void box.attach(l); }} />
  <ContextChips files={filesToSend(ctxStore.files, new Set())} skipped={box.skipCtx} c={ctxColors}
    onOpen={onOpenContext}
    onSkip={(id, skip) => box.setSkipCtx((cur) => { const n = new Set(cur); if (skip) n.add(id); else n.delete(id); return n; })} />
  {(box.uploading || (ctxStore.error && showCtxError)) && (
    <div onClick={() => ctxStore.setError('')}
      style={{ padding: '4px 16px 0', fontSize: '12px', color: box.uploading ? palette.textSecondary : palette.danger }}>
      {box.uploading ? `Attaching ${box.uploading}…${box.sendQueued !== null ? ' Your message goes once it’s attached.' : ''}` : ctxStore.error}
    </div>
  )}
  {/* in a narrow column the model, Ask and Clear wrap under the input */}
  <div style={{ position: 'relative', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '8px 16px' }}>
  {mention && (
    <MentionMenu docs={docs} query={mention.query} active={mention.active} palette={palette}
      onHover={(active) => setMention((mn) => (mn ? { ...mn, active } : mn))} onPick={(d) => box.pickMention(d.name)} />
  )}
  <button onClick={box.pickFiles} disabled={!!box.uploading} aria-label="Attach a file"
    title="Attach a photo, drawing or datasheet (or drop or paste one here); the AI reads it with your message"
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, flex: 'none',
             background: 'none', color: palette.textSecondary, border: `1px solid ${palette.inputBorder}`,
             borderRadius: '4px', cursor: !box.uploading ? 'pointer' : 'default',
             opacity: !box.uploading ? 1 : 0.5 }}>
    {paperclip(15)}
  </button>
  <input
    ref={box.setInputEl}
    value={ask}
    onChange={(e) => { box.setAsk(e.target.value); box.trackMention(e.target.value, e.target.selectionStart); }}
    onSelect={(e) => box.trackMention(e.currentTarget.value, e.currentTarget.selectionStart)}
    onBlur={() => setMention(null)}
    onKeyDown={(e) => {
      const hits = mention ? matchMentions(docs, mention.query) : [];
      if (mention && hits.length) {
        const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (step) { e.preventDefault(); setMention({ ...mention, active: (mention.active + step + hits.length) % hits.length }); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); box.pickMention(hits[Math.min(mention.active, hits.length - 1)]!.name); return; }
        if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
      }
      if (e.key === 'Enter') onSend();
    }}
    onPaste={(e) => {
      // a pasted photo or screenshot becomes a context file of this document
      const l = [...e.clipboardData.files];
      if (l.length) { e.preventDefault(); void box.attach(l); }
    }}
    placeholder={placeholder(box.inputW)}
    disabled={asking}
    style={{ flex: '1 1 140px', minWidth: 0, padding: '6px 10px', background: palette.inputBg,
             border: `1px solid ${palette.inputBorder}`, borderRadius: '4px',
             color: palette.text, fontSize: '13px', outline: 'none' }}
  />
  <select value={model} onChange={(e) => picker.pickModel(e.target.value)} onFocus={picker.refreshModelsIfStale}
    disabled={asking || models.length === 0}
    title={models.find((m) => m.id === model) ? picker.modelTitle(models.find((m) => m.id === model)!)
           : 'Model for AI edits — stronger tiers cost more; use them for hard tasks'}
    style={{ padding: '6px 8px', background: palette.inputBg, color: palette.textSecondary, maxWidth: 140,
             border: `1px solid ${palette.inputBorder}`, borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>
    {models.length === 0 && <option value={model}>{model || 'default model'}</option>}
    {models.map((m) => (
      <option key={m.id} value={m.id} title={picker.modelTitle(m)}>
        {m.label}{m.tier === 'fable' || m.tier === 'mythos' ? ' ✦' : ''}
      </option>
    ))}
  </select>
  <button onClick={onSend} disabled={asking || !ask.trim()}
    style={{ flex: 'none', padding: '6px 14px', background: palette.primaryBtn, color: '#fff', border: 'none',
             borderRadius: '4px', fontSize: '13px', cursor: ask.trim() && !asking ? 'pointer' : 'default',
             opacity: ask.trim() && !asking ? 1 : 0.5 }}>
    {asking ? 'Editing…' : 'Ask'}
  </button>
  {hasMessages && (
    <button onClick={onClear} title="Clear the conversation"
      style={{ flex: 'none', padding: '6px 10px', background: 'none', color: palette.textSecondary,
               border: `1px solid ${palette.border}`, borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>
      Clear
    </button>
  )}
  </div>
  </div>
  );
}
