import { useEffect, useRef, useState } from 'react';
import { useCamStore } from '@/stores/camStore';
import { Btn, useTokens, SANS } from './ui';

/** The conversation with the CAM assistant: what it did, the choices it offers, what it assumed. */
export function AiThread({ limit = 6 }: { limit?: number }) {
  const t = useTokens();
  const thread = useCamStore((s) => s.job.thread);
  const sendChat = useCamStore((s) => s.sendChat);
  const aiBusy = useCamStore((s) => s.aiBusy);
  const [all, setAll] = useState(false);
  if (thread.length === 0) return null;
  const shown = all ? thread : thread.slice(-limit);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {thread.length > shown.length && (
        <Btn kind="ghost" small onClick={() => setAll(true)} style={{ alignSelf: 'flex-start' }}>Show {thread.length - shown.length} earlier</Btn>
      )}
      {shown.map((turn, i) =>
        turn.role === 'user' ? (
          <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', background: t.accentSoft, color: t.text, borderRadius: '10px 10px 2px 10px', padding: '7px 10px', fontSize: 12.5, whiteSpace: 'pre-wrap' }}>
            {turn.text}
          </div>
        ) : (
          <div key={i} style={{ background: t.surface, border: `1px solid ${t.violet}40`, borderLeft: `3px solid ${t.violet}`, borderRadius: 8, padding: '8px 11px', fontSize: 12.5 }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: t.violet, letterSpacing: '0.6px', marginBottom: 3 }}>AI</div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{turn.text}</div>
            {turn.choices && turn.choices.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
                {turn.choices.map((c, j) => (
                  <Btn key={j} kind="ai" small disabled={aiBusy} onClick={() => sendChat(c)} style={{ whiteSpace: 'normal', textAlign: 'left' }}>{c}</Btn>
                ))}
              </div>
            )}
            {turn.assumptions && turn.assumptions.length > 0 && (
              <ul style={{ margin: '7px 0 0', paddingLeft: 16, color: t.textDim, fontSize: 11.5, lineHeight: 1.5 }}>
                {turn.assumptions.map((a, j) => <li key={j}>{a}</li>)}
              </ul>
            )}
          </div>
        ),
      )}
    </div>
  );
}

/** Type a message to the assistant. */
export function Composer({ placeholder, focusOpId = null, autoFocus }: { placeholder: string; focusOpId?: string | null; autoFocus?: boolean }) {
  const t = useTokens();
  const sendChat = useCamStore((s) => s.sendChat);
  const aiBusy = useCamStore((s) => s.aiBusy);
  const aiError = useCamStore((s) => s.aiError);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const send = () => {
    if (!text.trim() || aiBusy) return;
    sendChat(text, focusOpId);
    setText('');
  };
  return (
    <div>
      {aiError && <div style={{ fontSize: 11.5, color: t.danger, marginBottom: 5 }}>The assistant failed: {aiError.slice(0, 200)}</div>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', background: t.surface2, border: `1px solid ${t.border2}`, borderRadius: 10, padding: 6 }}>
        <textarea
          ref={ref} value={text} rows={2} placeholder={placeholder} disabled={aiBusy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: t.text, fontFamily: SANS, fontSize: 12.5, padding: '3px 4px' }}
        />
        <Btn kind="ai" small disabled={aiBusy || !text.trim()} onClick={send}>{aiBusy ? 'Thinking…' : 'Send'}</Btn>
      </div>
    </div>
  );
}
