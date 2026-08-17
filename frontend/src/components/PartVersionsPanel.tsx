import { useEffect, useState } from 'react';
import { useThemeStore } from '@/theme';
import { api as docApi, type VersionListItem } from '@/api/client';

/** A line-level diff of `from` → `to` (LCS). '-' lines are in `from` only,
 *  '+' lines in `to` only, ' ' unchanged. Used to show a saved version vs. the
 *  current script. */
function lineDiff(from: string, to: string): { type: ' ' | '-' | '+'; text: string }[] {
  const A = from.split('\n');
  const B = to.split('\n');
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (g: number[][], i: number, k: number) => g[i]![k]!;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = A[i] === B[j] ? at(dp, i + 1, j + 1) + 1 : Math.max(at(dp, i + 1, j), at(dp, i, j + 1));
  const out: { type: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: ' ', text: A[i]! }); i++; j++; }
    else if (at(dp, i + 1, j) >= at(dp, i, j + 1)) { out.push({ type: '-', text: A[i]! }); i++; }
    else { out.push({ type: '+', text: B[j]! }); j++; }
  }
  while (i < n) out.push({ type: '-', text: A[i++]! });
  while (j < m) out.push({ type: '+', text: B[j++]! });
  return out;
}

function fmtWhen(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Server-backed version browser for a part. Lists the immutable snapshots,
 *  previews a chosen one (full script or a diff against the current code), and
 *  restores it (restoring simply re-saves that code, which creates a new version
 *  — so nothing is ever lost). */
export function PartVersionsPanel({ docId, currentCode, onRestore, onClose }: {
  docId: string;
  currentCode: string;
  onRestore: (code: string) => void;
  onClose: () => void;
}) {
  const palette = useThemeStore((s) => s.palette);
  const [versions, setVersions] = useState<VersionListItem[] | null>(null);
  const [error, setError] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [selCode, setSelCode] = useState<string>('');
  const [loadingCode, setLoadingCode] = useState(false);
  const [mode, setMode] = useState<'full' | 'diff'>('diff');

  useEffect(() => {
    let cancelled = false;
    docApi.listVersions(docId)
      .then((v) => { if (!cancelled) { setVersions(v); if (v[0]) select(v[0].id); } })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const select = (id: string) => {
    setSelId(id);
    setLoadingCode(true);
    docApi.getVersion(docId, id)
      .then((full) => {
        const code = (full.data as { modelCode?: string }).modelCode ?? '';
        setSelCode(code);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingCode(false));
  };

  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  const diff = mode === 'diff' ? lineDiff(selCode, currentCode) : null;
  const isCurrent = selCode.trim() === currentCode.trim();

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(880px, 94vw)', height: '100%', display: 'flex', flexDirection: 'column',
                 background: palette.panelBg, borderLeft: `1px solid ${palette.border}`, boxShadow: '-8px 0 32px rgba(0,0,0,0.4)' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderBottom: `1px solid ${palette.border}` }}>
          <span style={{ fontSize: '15px', fontWeight: 600, color: palette.text }}>Versions</span>
          <span style={{ fontSize: '12px', color: palette.textSecondary }}>
            {versions ? `${versions.length} saved` : 'loading…'}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose}
            style={{ padding: '5px 11px', fontSize: '13px', background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}`, borderRadius: 6, cursor: 'pointer' }}>Close</button>
        </div>

        {error && (
          <div style={{ padding: '10px 16px', color: '#f87171', fontSize: '13px', fontFamily: mono }}>{error}</div>
        )}

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* list */}
          <div style={{ width: 300, flexShrink: 0, overflowY: 'auto', borderRight: `1px solid ${palette.border}` }}>
            {versions && versions.length === 0 && (
              <div style={{ padding: '16px', fontSize: '13px', color: palette.textSecondary }}>No versions yet.</div>
            )}
            {versions?.map((v, idx) => {
              const active = v.id === selId;
              return (
                <button key={v.id} onClick={() => select(v.id)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px',
                           background: active ? palette.inputBg : 'none', border: 'none',
                           borderBottom: `1px solid ${palette.border}`, borderLeft: `3px solid ${active ? palette.accent : 'transparent'}`,
                           cursor: 'pointer', color: palette.text }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: palette.textSecondary }}>
                    <span>{fmtWhen(v.created_at)}{idx === 0 ? ' · latest' : ''}</span>
                    <span>{v.chars} chars</span>
                  </div>
                  <div style={{ fontSize: '13px', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                fontFamily: v.label ? 'inherit' : mono, opacity: v.label ? 1 : 0.75 }}>
                    {v.label || v.preview || '(empty)'}
                  </div>
                </button>
              );
            })}
          </div>

          {/* preview / diff */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderBottom: `1px solid ${palette.border}` }}>
              {(['diff', 'full'] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)}
                  style={{ padding: '4px 11px', fontSize: '12px', borderRadius: 6, cursor: 'pointer',
                           background: mode === m ? palette.accent : 'none', color: mode === m ? '#fff' : palette.textSecondary,
                           border: `1px solid ${mode === m ? palette.accent : palette.border}` }}>
                  {m === 'diff' ? 'Diff vs current' : 'Full script'}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              {isCurrent
                ? <span style={{ fontSize: '12px', color: palette.textSecondary }}>This is the current model</span>
                : (
                  <button onClick={() => onRestore(selCode)} disabled={!selCode}
                    style={{ padding: '6px 14px', fontSize: '13px', fontWeight: 600, borderRadius: 6,
                             background: palette.accent, color: '#fff', border: 'none', cursor: selCode ? 'pointer' : 'default', opacity: selCode ? 1 : 0.5 }}>
                    Restore this version
                  </button>
                )}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '10px 0', fontFamily: mono, fontSize: '12.5px', lineHeight: 1.55 }}>
              {loadingCode ? (
                <div style={{ padding: '12px 16px', color: palette.textSecondary }}>Loading…</div>
              ) : mode === 'full' ? (
                <pre style={{ margin: 0, padding: '0 16px', whiteSpace: 'pre-wrap', color: palette.text }}>{selCode}</pre>
              ) : (
                <div>
                  {isCurrent ? (
                    <div style={{ padding: '12px 16px', color: palette.textSecondary }}>Identical to the current model — nothing to diff.</div>
                  ) : diff!.map((ln, i) => (
                    <div key={i} style={{ display: 'flex', padding: '0 16px', whiteSpace: 'pre-wrap',
                          background: ln.type === '+' ? 'rgba(34,197,94,0.12)' : ln.type === '-' ? 'rgba(239,68,68,0.12)' : 'transparent',
                          color: ln.type === '+' ? '#4ade80' : ln.type === '-' ? '#f87171' : palette.text }}>
                      <span style={{ width: 14, flexShrink: 0, opacity: 0.7 }}>{ln.type}</span>
                      <span>{ln.text || ' '}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {mode === 'diff' && !isCurrent && (
              <div style={{ padding: '7px 14px', borderTop: `1px solid ${palette.border}`, fontSize: '11.5px', color: palette.textSecondary }}>
                <span style={{ color: '#f87171' }}>− this version</span>{'   '}
                <span style={{ color: '#4ade80' }}>+ current model</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
