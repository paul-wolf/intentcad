import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTokens, SANS, MONO, type Tokens } from '@/ui/tokens';
import type { SourceKind } from '@/cam/resolve';

/** Shared pieces for the CAM screens, on the redesign tokens. */

export type T = Tokens & { isDark: boolean };
export { useTokens, SANS, MONO };

/** Amber for "set here", from the tokens' part colour. */
export const sourceColor = (t: T, kind: SourceKind) => (kind === 'set' ? t.part : kind === 'ai' ? t.violet : t.textMute);

export function SourceDot({ kind, title }: { kind: SourceKind; title?: string }) {
  const t = useTokens();
  return (
    <span
      title={title ?? (kind === 'set' ? 'Set here' : kind === 'ai' ? 'Set by the AI' : 'Inherited')}
      style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: sourceColor(t, kind), flexShrink: 0 }}
    />
  );
}

export function SourceKey() {
  const t = useTokens();
  const item = (kind: SourceKind, label: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><SourceDot kind={kind} />{label}</span>
  );
  return (
    <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: t.textDim }}>
      {item('inherited', 'inherited')}{item('set', 'set here')}{item('ai', 'AI')}
    </div>
  );
}

export function Card({ title, right, children, style }: { title: ReactNode; right?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  const t = useTokens();
  return (
    <section style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, padding: '12px 14px', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: t.text, flex: 1 }}>{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function GroupLabel({ children }: { children: ReactNode }) {
  const t = useTokens();
  return <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.7px', color: t.textMute, margin: '14px 0 6px' }}>{children}</div>;
}

type BtnKind = 'default' | 'primary' | 'ghost' | 'ai' | 'danger';

export function Btn({ kind = 'default', small, children, style, ...rest }: { kind?: BtnKind; small?: boolean; children: ReactNode; style?: CSSProperties } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const t = useTokens();
  const look: Record<BtnKind, CSSProperties> = {
    default: { background: t.surface2, color: t.text, border: `1px solid ${t.border2}` },
    primary: { background: t.accent, color: '#fff', border: `1px solid ${t.accent}` },
    ghost: { background: 'transparent', color: t.textDim, border: '1px solid transparent' },
    ai: { background: t.violetSoft, color: t.violet, border: `1px solid ${t.violet}55` },
    danger: { background: 'transparent', color: t.danger, border: `1px solid ${t.danger}55` },
  };
  return (
    <button
      {...rest}
      style={{
        fontFamily: SANS, fontSize: small ? 11.5 : 12.5, fontWeight: 500, padding: small ? '3px 8px' : '6px 12px',
        borderRadius: 7, cursor: rest.disabled ? 'default' : 'pointer', opacity: rest.disabled ? 0.45 : 1, whiteSpace: 'nowrap',
        ...look[kind], ...style,
      }}
    >
      {children}
    </button>
  );
}

export function Pill({ tone, children }: { tone: 'proposed' | 'accepted' | 'ai' | 'info' | 'warn'; children: ReactNode }) {
  const t = useTokens();
  const c = {
    proposed: [t.violet, t.violetSoft], accepted: [t.ok, t.okSoft], ai: [t.violet, t.violetSoft],
    info: [t.textDim, t.surface3], warn: [t.part, t.partSoft],
  }[tone];
  return (
    <span style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 7px', borderRadius: 999, color: c[0], background: c[1], whiteSpace: 'nowrap' }}>{children}</span>
  );
}

export function Chip({ children, title, mono, style }: { children: ReactNode; title?: string; mono?: boolean; style?: CSSProperties }) {
  const t = useTokens();
  return (
    <span title={title} style={{ fontSize: 11, fontFamily: mono ? MONO : SANS, padding: '2px 7px', borderRadius: 6, background: t.surface3, color: t.textDim, border: `1px solid ${t.border}`, whiteSpace: 'nowrap', ...style }}>
      {children}
    </span>
  );
}

export const inputStyle = (t: T, width?: number | string): CSSProperties => ({
  fontFamily: MONO, fontSize: 12, padding: '4px 7px', borderRadius: 6, border: `1px solid ${t.border2}`,
  background: t.surface2, color: t.text, width: width ?? 80, boxSizing: 'border-box',
});

/** A number box that commits on Enter or blur, and ignores what isn't a number. */
export function NumInput({ value, onChange, step = 0.1, min, max, width, disabled, title }: {
  value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; width?: number; disabled?: boolean; title?: string;
}) {
  const t = useTokens();
  const [draft, setDraft] = useState(fmt(value));
  useEffect(() => setDraft(fmt(value)), [value]);
  const commit = () => {
    const v = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
      setDraft(fmt(value));
      return;
    }
    if (Math.abs(v - value) > 1e-9) onChange(v);
  };
  return (
    <input
      type="number" value={draft} step={step} min={min} max={max} disabled={disabled} title={title}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={inputStyle(t, width)}
    />
  );
}

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return '';
  return String(Number(v.toFixed(4)));
}

export function Select<V extends string>({ value, options, onChange, width, disabled }: {
  value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; width?: number | string; disabled?: boolean;
}) {
  const t = useTokens();
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as V)} style={{ ...inputStyle(t, width ?? 'auto'), fontFamily: SANS, padding: '4px 6px' }}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Segmented<V extends string>({ value, options, onChange }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  const t = useTokens();
  return (
    <div style={{ display: 'inline-flex', border: `1px solid ${t.border2}`, borderRadius: 7, overflow: 'hidden' }}>
      {options.map((o) => (
        <button
          key={o.value} onClick={() => onChange(o.value)}
          style={{
            fontFamily: SANS, fontSize: 11.5, padding: '4px 9px', border: 'none', cursor: 'pointer',
            background: o.value === value ? t.accentSoft : t.surface2, color: o.value === value ? t.accent : t.textDim,
            fontWeight: o.value === value ? 600 : 400,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A modal dialog over the editor. */
export function Dialog({ title, onClose, children, footer, width = 620 }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const t = useTokens();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,0.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SANS }}
    >
      <div style={{ width, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column', background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, boxShadow: t.shadow, color: t.text }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', borderBottom: `1px solid ${t.border}` }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, flex: 1 }}>{title}</h2>
          <Btn kind="ghost" small onClick={onClose} aria-label="Close">✕</Btn>
        </div>
        <div style={{ padding: '14px 18px', overflowY: 'auto', flex: 1 }}>{children}</div>
        {footer && <div style={{ padding: '12px 18px', borderTop: `1px solid ${t.border}`, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

/** A label/value row in a card. */
export function Row({ label, children, hint, dot }: { label: ReactNode; children: ReactNode; hint?: ReactNode; dot?: ReactNode }) {
  const t = useTokens();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30 }}>
      {dot}
      <span style={{ fontSize: 12.5, color: t.textDim, width: 120, flexShrink: 0 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>{children}</div>
      {hint && <span style={{ fontSize: 11, color: t.textMute, marginLeft: 'auto', textAlign: 'right' }}>{hint}</span>}
    </div>
  );
}

export const panelStyle = (t: T): CSSProperties => ({
  width: 460, flexShrink: 0, background: t.appBg, borderRight: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column',
  fontFamily: SANS, color: t.text, minHeight: 0,
});
