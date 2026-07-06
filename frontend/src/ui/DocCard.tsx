import { DocumentThumbnail } from '@/components/DocumentThumbnail';
import { useTokens, MONO } from './tokens';

/** Generic amber isometric-cube thumbnail for parts (a real render would be
 *  ideal later; this is a clean placeholder that reads as "3D part"). */
function PartThumb({ color }: { color: string }) {
  return (
    <svg width="96" height="96" viewBox="0 0 100 100" fill="none" stroke={color}
         strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round">
      <path d="M50 8 L88 30 L88 70 L50 92 L12 70 L12 30 Z" opacity="0.95" />
      <path d="M50 8 L50 50 M12 30 L50 50 M88 30 L50 50" opacity="0.75" />
    </svg>
  );
}

export interface DocCardData {
  id: string;
  name: string;
  kind?: 'part' | 'sketch';
  updated: string;
  subtitle?: string;    // e.g. project name (for the "recent" grid)
}

export interface DocCardEdit {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

/** A document card: grid-backed thumbnail with a PART/SKETCH badge, name, meta.
 *  Optional double-click rename and a hover delete. */
export function DocCard({ d, onOpen, onDoubleClick, onDelete, editing }: {
  d: DocCardData;
  onOpen: () => void;
  onDoubleClick?: () => void;
  onDelete?: () => void;
  editing?: DocCardEdit;
}) {
  const t = useTokens();
  const isPart = d.kind === 'part';
  const badgeColor = isPart ? t.part : t.sketch;
  const badgeBg = isPart ? t.partSoft : t.sketchSoft;

  return (
    <div onClick={editing ? undefined : onOpen} onDoubleClick={editing ? undefined : onDoubleClick}
      style={{ position: 'relative', background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, overflow: 'hidden',
               cursor: 'pointer', transition: 'transform .12s ease,border-color .12s ease,box-shadow .12s ease' }}
      onMouseEnter={(e) => { const s = e.currentTarget.style; s.transform = 'translateY(-3px)'; s.borderColor = t.border2; s.boxShadow = t.shadow;
                             const del = e.currentTarget.querySelector('[data-del]') as HTMLElement | null; if (del) del.style.opacity = '1'; }}
      onMouseLeave={(e) => { const s = e.currentTarget.style; s.transform = 'none'; s.borderColor = t.border; s.boxShadow = 'none';
                             const del = e.currentTarget.querySelector('[data-del]') as HTMLElement | null; if (del) del.style.opacity = '0'; }}
    >
      {onDelete && (
        <button data-del title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}
          style={{ position: 'absolute', top: 8, right: 8, zIndex: 3, opacity: 0, transition: 'opacity .1s',
                   display: 'flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center',
                   background: t.surface, border: `1px solid ${t.border2}`, borderRadius: 6, color: t.danger, cursor: 'pointer' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      )}
      <div style={{ position: 'relative', aspectRatio: '4 / 3', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    backgroundColor: t.thumbBg, borderBottom: `1px solid ${t.border}`,
                    backgroundImage: `linear-gradient(${t.grid} 1px,transparent 1px),linear-gradient(90deg,${t.grid} 1px,transparent 1px)`,
                    backgroundSize: '15px 15px' }}>
        <span style={{ position: 'absolute', top: 9, left: 9, zIndex: 2, fontFamily: MONO, fontSize: '9.5px',
                       fontWeight: 600, letterSpacing: '1px', color: badgeColor, background: badgeBg,
                       border: `1px solid ${badgeColor}`, borderRadius: 5, padding: '2px 6px' }}>
          {isPart ? 'PART' : 'SKETCH'}
        </span>
        {isPart
          ? <PartThumb color={t.part} />
          : <DocumentThumbnail documentId={d.id} width={120} height={90} background="transparent" stroke={t.thumbLine} />}
      </div>
      <div style={{ padding: '12px 14px 13px' }}>
        {editing ? (
          <input value={editing.value} autoFocus onClick={(e) => e.stopPropagation()}
            onChange={(e) => editing.onChange(e.target.value)} onBlur={editing.onCommit}
            onKeyDown={(e) => { if (e.key === 'Enter') editing.onCommit(); if (e.key === 'Escape') editing.onCancel(); }}
            style={{ width: '100%', background: t.appBg, border: `1px solid ${t.accent}`, borderRadius: 5, color: t.text, fontSize: '14px', padding: '3px 6px', outline: 'none' }} />
        ) : (
          <div style={{ fontSize: '14px', fontWeight: 600, color: t.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {d.name}
          </div>
        )}
        <div style={{ fontFamily: MONO, fontSize: '11px', color: t.textMute, marginTop: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {d.subtitle ? `${d.subtitle} · ${d.updated}` : d.updated}
        </div>
      </div>
    </div>
  );
}
