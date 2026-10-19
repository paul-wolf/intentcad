/**
 * The Operations layout: every operation of the part editor (build/operations.ts)
 * as a grid of tiles, by group, with the last few used at the top. A tile
 * that can't run with this selection stays in place, dimmed, saying what it
 * needs; tiles a new selection makes available light up briefly. Hovering or
 * focusing a tile shows its help below the grid, with an example to ask the
 * AI instead. Arrow keys move between tiles, Enter runs, Esc goes back to the
 * layout before.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useThemeStore } from '@/theme';
import {
  OPERATIONS, OP_GROUPS, OPS_KEY, opById, type Operation, type OpModel, type OpSelection,
} from '@/build/operations';
import { OpIcon } from './OpIcons';

interface Props {
  sel: OpSelection;
  model: OpModel;
  /** the ids of the last operations used, latest first */
  recent: string[];
  onRun(op: Operation): void;
  /** put this in the chat box (it isn't sent) */
  onExample(text: string): void;
  /** Esc: back to the layout before */
  onBack(): void;
}

// how long a tile stays lit after a new selection makes it available
const FRESH_MS = 1100;
// how long the pointer rests on a tile before the help card shows it
const HOVER_MS = 180;

export function Kbd({ keys }: { keys: string }) {
  const palette = useThemeStore((s) => s.palette);
  return (
    <span style={{ display: 'inline-flex', gap: '2px', flexShrink: 0 }}>
      {keys.split(' ').map((k) => (
        <kbd key={k} style={{ fontFamily: 'inherit', fontSize: '10.5px', lineHeight: '14px', minWidth: '14px',
                              textAlign: 'center', padding: '0 4px', borderRadius: '3px',
                              border: `1px solid ${palette.border}`, color: palette.textSecondary }}>{k}</kbd>
      ))}
    </span>
  );
}

export function OperationsPanel({ sel, model, recent, onRun, onExample, onBack }: Props) {
  const palette = useThemeStore((s) => s.palette);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const need = (op: Operation) => op.needs(sel, model);
  const enabled = OPERATIONS.filter((op) => need(op).ok).map((op) => op.id);
  const enabledKey = enabled.join();

  // light up what just became available (not on opening the layout)
  const prevEnabled = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const before = prevEnabled.current;
    prevEnabled.current = new Set(enabled);
    if (!before) return;
    const lit = enabled.filter((id) => !before.has(id));
    if (lit.length) setFresh(new Set(lit));
  }, [enabledKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!fresh.size) return;
    const t = window.setTimeout(() => setFresh(new Set()), FRESH_MS);
    return () => window.clearTimeout(t);
  }, [fresh]);

  // two columns, one when the pane is narrow, three when it is wide
  const [cols, setCols] = useState(2);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const fit = () => { const w = el.clientWidth; setCols(w < 360 ? 1 : w < 860 ? 2 : 3); };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the help card: the tile last hovered or focused
  // (hovering takes a moment to count, so the pointer can cross other tiles on its
  // way down to the card's example without changing it)
  const [shown, setShown] = useState<string | null>(null);
  const shownOp = shown ? opById(shown) : undefined;
  const hoverTimer = useRef<number | undefined>(undefined);
  const hoverOn = (id: string) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setShown(id), HOVER_MS);
  };
  const hoverOff = () => window.clearTimeout(hoverTimer.current);
  useEffect(() => hoverOff, []);

  // opening the layout puts the keyboard on the first tile, so the arrows work at once
  useEffect(() => {
    rootRef.current?.querySelector<HTMLButtonElement>('[data-tile]')?.focus({ preventScroll: true });
  }, []);

  const tiles = () => [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-tile]') ?? [])];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onBack(); return; }
    const all = tiles();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let to: HTMLButtonElement | undefined;
    if (e.key === 'ArrowRight') to = all[Math.min(all.length - 1, i + 1)];
    else if (e.key === 'ArrowLeft') to = all[Math.max(0, i - 1)];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // the nearest tile in the row below (above), across the group headings
      const down = e.key === 'ArrowDown';
      const r = all[i]!.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      let best = Infinity;
      for (const t of all) {
        const q = t.getBoundingClientRect();
        const dy = down ? q.top - r.bottom : r.top - q.bottom;
        if (dy < -1) continue;
        const score = dy * 4 + Math.abs(q.left + q.width / 2 - cx);
        if (t !== all[i] && score < best) { best = score; to = t; }
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      all[i]!.click();
      return;
    } else return;
    e.preventDefault();
    to?.focus();
    to?.scrollIntoView({ block: 'nearest' });
  };

  const tile = (op: Operation, key: string) => {
    const n = need(op);
    const lit = n.ok && fresh.has(op.id);
    const detail = n.ok ? op.detail?.(sel, model) : null;
    const name = op.label?.(model) ?? op.name;
    return (
      <button key={key} data-tile={op.id} className="op-tile" aria-disabled={!n.ok}
        title={n.ok ? op.help : `${op.help} — ${n.reason}`}
        onClick={() => { if (n.ok) onRun(op); }}
        onMouseEnter={() => hoverOn(op.id)} onMouseLeave={hoverOff} onFocus={() => setShown(op.id)}
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '3px', minWidth: 0,
          padding: '8px 10px', borderRadius: '6px', textAlign: 'left', font: 'inherit',
          border: `1px solid ${lit ? palette.accent : palette.border}`,
          background: lit ? `${palette.accent}24` : n.ok ? palette.buttonBg : 'transparent',
          boxShadow: lit ? `0 0 0 1px ${palette.accent}55` : 'none',
          transition: 'background-color 700ms ease, border-color 700ms ease, box-shadow 700ms ease',
          color: palette.text, cursor: n.ok ? 'pointer' : 'default',
        }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: n.ok ? 1 : 0.45 }}>
          <span style={{ color: n.ok ? palette.accent : palette.textSecondary }}><OpIcon name={op.icon} /></span>
          <span style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, whiteSpace: 'nowrap',
                         overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
          {op.shortcut && <Kbd keys={op.shortcut} />}
        </span>
        {(!n.ok || detail) && (
          <span style={{ fontSize: '11px', lineHeight: 1.35, paddingLeft: '28px',
                         color: palette.textSecondary, fontStyle: n.ok ? 'normal' : 'italic' }}>
            {n.ok ? detail : n.reason}
          </span>
        )}
      </button>
    );
  };

  const heading = (title: string) => (
    <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase',
                  color: palette.textSecondary, margin: '12px 2px 6px' }}>{title}</div>
  );
  const grid: CSSProperties = { display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: '6px' };
  const recentOps = recent.map(opById).filter((o): o is Operation => !!o);

  return (
    <div ref={rootRef} data-ops-panel onKeyDown={onKeyDown}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <style>{`.op-tile:hover { border-color: ${palette.accent} !important; }
               .op-tile:focus { outline: none; }
               .op-tile:focus-visible { outline: 2px solid ${palette.accent}; outline-offset: 1px; }`}</style>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '2px 14px 14px' }}>
        {recentOps.length > 0 && (
          <>
            {heading('Recent')}
            <div style={grid}>{recentOps.map((op) => tile(op, `recent:${op.id}`))}</div>
          </>
        )}
        {OP_GROUPS.map((g) => {
          const ops = OPERATIONS.filter((op) => op.group === g);
          if (!ops.length) return null;
          return (
            <div key={g}>
              {heading(g)}
              <div style={grid}>{ops.map((op) => tile(op, op.id))}</div>
            </div>
          );
        })}
      </div>
      {/* the help card */}
      <div aria-live="polite"
        style={{ flexShrink: 0, minHeight: '92px', padding: '10px 14px', borderTop: `1px solid ${palette.border}`,
                 fontSize: '12.5px', lineHeight: 1.45, color: palette.textSecondary }}>
        {shownOp ? (() => {
          const n = need(shownOp);
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: palette.text, marginBottom: '4px' }}>
                <span style={{ color: palette.accent }}><OpIcon name={shownOp.icon} size={18} /></span>
                <b style={{ fontWeight: 600 }}>{shownOp.label?.(model) ?? shownOp.name}</b>
                {shownOp.shortcut && <Kbd keys={shownOp.shortcut} />}
                {!n.ok && <span style={{ color: palette.warning, fontSize: '11.5px' }}>{n.reason}</span>}
              </div>
              <div>{shownOp.longHelp}</div>
              <div style={{ marginTop: '6px' }}>
                or ask:{' '}
                <button onClick={() => onExample(shownOp.example)}
                  title="Put this in the chat box (it isn't sent)"
                  style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer',
                           color: palette.accent, textDecoration: 'underline', textUnderlineOffset: '2px' }}>
                  “{shownOp.example}”
                </button>
              </div>
            </>
          );
        })() : (
          <div>
            Hover or focus a tile for what it does. Arrow keys move, Enter runs, Esc goes back
            ({OPS_KEY} switches here and back). Select faces in the 3D view: the tiles follow the selection.
          </div>
        )}
      </div>
    </div>
  );
}
