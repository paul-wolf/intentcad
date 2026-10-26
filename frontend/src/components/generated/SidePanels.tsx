/**
 * The right column of the generated sketch editor: its Outputs (hovering a
 * row lights the output in the drawing, as hovering the drawing lights the
 * row), the project Parameters the code read (sliders try values, nothing is
 * saved until Apply to project), its Checks (clicking one shows its output)
 * and the parts that use it, with Rebuild all.
 */
import { type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useThemeStore } from '@/theme';
import { useTokens } from '@/ui/tokens';
import type { UsedByPart } from '@/api/client';
import type { ProjectParameter } from '@/types/project';
import type { SavedRange } from '@/utils/paramRange';
import type { GenCheck, GenOutput } from '@/types/generated';
import { ParamControl, TrialBar, fmt } from '@/components/ParamControl';
import { checksWords, OUTPUT_ICON, outputsUsedBy, usedWords } from '@/build/generatedSketch';

export function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  const palette = useThemeStore((s) => s.palette);
  return (
    <section style={{ borderBottom: `1px solid ${palette.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px 4px',
                    fontSize: '11px', fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase', color: palette.textMuted }}>
        <span>{title}</span>
        {extra && <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>{extra}</span>}
      </div>
      <div style={{ padding: '2px 0 8px' }}>{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  const palette = useThemeStore((s) => s.palette);
  return <div style={{ padding: '2px 12px 4px', fontSize: '12px', color: palette.textMuted, lineHeight: 1.45 }}>{children}</div>;
}

export function OutputsPanel({ outputs, users, lit, onHover, onPick }: {
  outputs: GenOutput[];
  users: UsedByPart[];
  lit: ReadonlySet<string>;
  onHover: (name: string | null) => void;
  onPick: (name: string | null) => void;
}) {
  const palette = useThemeStore((s) => s.palette);
  return (
    <Section title="Outputs" extra={outputs.length ? <span style={{ color: palette.textMuted }}>parts use these</span> : undefined}>
      {!outputs.length && <Empty>No outputs yet. The code makes them with output("name", shapes), or ask the AI.</Empty>}
      {outputs.map((o) => {
        const on = lit.has(o.name);
        return (
          <div key={o.name} data-output-row={o.name}
            onMouseEnter={() => onHover(o.name)} onMouseLeave={() => onHover(null)}
            onClick={() => onPick(on ? null : o.name)}
            title={`Parts use it as SK["…"].group("${o.name}")`}
            style={{ display: 'flex', gap: 8, padding: '5px 12px', cursor: 'pointer',
                     background: on ? `${palette.accent}1f` : 'transparent', borderLeft: `2px solid ${on ? palette.accent : 'transparent'}` }}>
            <span aria-hidden style={{ width: 14, color: on ? palette.accent : palette.textMuted, fontSize: '13px' }}>{OUTPUT_ICON[o.kind]}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '12px', color: palette.text }}>{o.name}</span>
                <span style={{ fontSize: '11.5px', color: palette.textSecondary, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{o.size}</span>
              </div>
              {o.description && <div style={{ fontSize: '11.5px', color: palette.textSecondary }}>{o.description}</div>}
              <div style={{ fontSize: '11px', color: palette.textMuted }}>{usedWords(users, o.name)}</div>
            </div>
          </div>
        );
      })}
    </Section>
  );
}

export function ParametersPanel({ reads, params, trial, busy, onTry, onReset, onApply, onRange, note, projectId }: {
  /** the names the code read, with the values it read */
  reads: Record<string, number | string>;
  params: ProjectParameter[];
  trial: Record<string, number>;
  busy: boolean;
  onTry: (name: string, v: number, final: boolean) => void;
  onReset: () => void;
  onApply: () => void;
  onRange: (name: string, r: SavedRange | null) => void;
  note?: ReactNode;
  projectId: string | null;
}) {
  const palette = useThemeStore((s) => s.palette);
  const names = Object.keys(reads);
  const items = Object.entries(trial).map(([name, value]) => ({ name, value, saved: savedOf(name, reads, params) }));
  return (
    <Section title="Parameters (read by the code)">
      {!names.length && (
        <Empty>The code doesn't read any project parameters. Use PP["name"] in the code, or ask the AI to drive a size from one.</Empty>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 12px' }}>
        {names.map((name) => {
          const p = params.find((x) => x.name === name);
          const saved = savedOf(name, reads, params);
          if (typeof saved !== 'number') {
            return (
              <div key={name} style={{ display: 'flex', gap: 6, fontSize: '12px' }}
                   title="A text parameter: change it on the project page">
                <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', flex: 1, color: palette.text }}>{name}</span>
                <span style={{ color: palette.textSecondary }}>{fmt(saved)}</span>
              </div>
            );
          }
          return (
            <ParamControl key={name} label={name} value={trial[name] ?? saved} saved={saved} unit={p?.unit}
              range={p} savedWord="project" title={p?.description || undefined}
              onChange={(v, final) => onTry(name, v, final)}
              onRange={p ? (r) => onRange(name, r) : undefined} />
          );
        })}
      </div>
      {items.length > 0 && (
        <TrialBar items={items} savedWord="project" busy={busy} onReset={onReset} onApply={onApply}
          applyLabel="Apply to project…" style={{ margin: '10px 12px 0', flexWrap: 'wrap' }} />
      )}
      {note && <div style={{ margin: '8px 12px 0', fontSize: '12px', color: palette.text }}>{note}</div>}
      {projectId && (
        <div style={{ padding: '8px 12px 0', fontSize: '11.5px' }}>
          <Link to={`/project/${projectId}`} style={{ color: palette.textSecondary }}>All project parameters ↗</Link>
        </div>
      )}
    </Section>
  );
}

const savedOf = (name: string, reads: Record<string, number | string>, params: ProjectParameter[]) =>
  params.find((p) => p.name === name)?.value ?? reads[name];

export function ChecksPanel({ checks, lit, onPick }: {
  checks: GenCheck[];
  lit: ReadonlySet<string>;
  onPick: (output: string | null) => void;
}) {
  const palette = useThemeStore((s) => s.palette);
  const t = useTokens();
  return (
    <Section title="Checks" extra={checks.length ? (
      <span style={{ color: checks.every((c) => c.ok) ? t.ok : palette.danger }}>{checksWords(checks)}</span>) : undefined}>
      {!checks.length && <Empty>No checks. Ask the AI to add some, for example "check it fits a 300 mm bed".</Empty>}
      {checks.map((c, i) => {
        const on = !!c.output && lit.has(c.output);
        return (
          <div key={`${c.name}-${i}`} data-check={c.name}
            onClick={() => onPick(c.output && !on ? c.output : null)}
            title={c.output ? `Click to show ${c.output}` : undefined}
            style={{ display: 'flex', gap: 8, padding: '4px 12px', cursor: c.output ? 'pointer' : 'default',
                     background: on ? `${palette.accent}1f` : 'transparent' }}>
            <span aria-label={c.ok ? 'passes' : 'fails'} style={{ color: c.ok ? t.ok : palette.danger, fontWeight: 700, width: 12 }}>
              {c.ok ? '✓' : '✗'}
            </span>
            <div style={{ flex: 1, minWidth: 0, fontSize: '12px' }}>
              <div style={{ color: palette.text }}>{c.name}</div>
              {c.message && <div style={{ color: c.ok ? palette.textSecondary : palette.danger, fontSize: '11.5px' }}>{c.message}</div>}
            </div>
          </div>
        );
      })}
    </Section>
  );
}

export function UsedByPanel({ users, rebuild, onRebuildAll }: {
  users: UsedByPart[];
  rebuild: { at: string; done: string[]; failed: string[] } | null;
  onRebuildAll: () => void;
}) {
  const palette = useThemeStore((s) => s.palette);
  const stale = users.filter((p) => p.stale.length && !p.pinned);
  const btn: CSSProperties = {
    background: 'none', border: `1px solid ${palette.inputBorder}`, borderRadius: 3, color: palette.textSecondary,
    cursor: 'pointer', fontSize: '11px', padding: '2px 6px',
  };
  return (
    <Section title="Used by parts" extra={users.length ? (
      <button style={{ ...btn, opacity: stale.length && !rebuild?.at ? 1 : 0.5 }} disabled={!stale.length || !!rebuild?.at}
        onClick={onRebuildAll}
        title={stale.length ? `Rebuild the ${stale.length} out-of-date part(s) with this sketch as it is now`
          : 'Every part is built with this sketch as it is now'}>
        Rebuild all
      </button>) : undefined}>
      {!users.length && <Empty>No part uses this sketch yet. Pick an output and press Use in a part.</Empty>}
      {users.map((p) => {
        const outs = outputsUsedBy(p);
        return (
          <Link key={p.id} to={`/part/${p.id}`}
            style={{ display: 'flex', gap: 8, padding: '4px 12px', fontSize: '12px', textDecoration: 'none', color: palette.text }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>{p.name}</div>
              {outs.length > 0 && <div style={{ fontSize: '11px', color: palette.textMuted }}>uses {outs.join(', ')}</div>}
            </div>
            <span style={{ fontSize: '11px', color: p.stale.length && !p.pinned ? palette.warning : palette.textMuted }}
              title={p.stale.join(', ')}>
              {p.pinned ? 'pinned' : p.stale.length ? 'out of date' : 'up to date'}
            </span>
          </Link>
        );
      })}
      {rebuild && (
        <div style={{ display: 'flex', flexDirection: 'column', padding: '4px 12px', fontSize: '11px', color: palette.textMuted }}>
          {rebuild.at ? <span>Rebuilding {rebuild.at}…</span>
            : <span>Rebuilt {rebuild.done.length}{rebuild.failed.length ? `, ${rebuild.failed.length} failed` : ''}</span>}
          {rebuild.failed.map((f) => <span key={f} style={{ color: palette.danger }}>{f}</span>)}
        </div>
      )}
    </Section>
  );
}
