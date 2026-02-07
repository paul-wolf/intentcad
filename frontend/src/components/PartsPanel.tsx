import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useThemeStore } from '@/theme';
import { partApi, type PartListItem } from '@/api/client';
import { getBackendId, flushSave } from '@/api/autoSave';
import type { Part } from '@/types/part';
import { PartThumbnail } from './PartThumbnail';

export function PartsPanel() {
  const navigate = useNavigate();
  const palette = useThemeStore((s) => s.palette);
  const [listItems, setListItems] = useState<PartListItem[]>([]);
  const [docParts, setDocParts] = useState<Part[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const backendId = getBackendId();

  useEffect(() => {
    if (!backendId) return;
    let cancelled = false;
    partApi.listParts()
      .then((all) => {
        if (!cancelled) setListItems(all);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [backendId]);

  // Fetch full part data and filter to this document
  useEffect(() => {
    if (!backendId || listItems.length === 0) {
      setDocParts([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      listItems.map((p) =>
        partApi.getPart(p.id).then((full) => {
          const data = full.data as unknown as Part;
          if (data && data.documentId === backendId) {
            return { id: full.id, name: full.name, documentId: data.documentId, features: data.features ?? [] } as Part;
          }
          return null;
        }).catch(() => null)
      )
    ).then((results) => {
      if (!cancelled) {
        const filtered = results.filter((r): r is Part => r !== null);
        setDocParts(filtered);
        setSelectedIdx((prev) => Math.min(prev, Math.max(0, filtered.length - 1)));
      }
    });
    return () => { cancelled = true; };
  }, [backendId, listItems]);

  const handleOpen = (id: string) => {
    flushSave();
    navigate(`/part/${id}`);
  };

  if (docParts.length === 0) return null;

  const currentPart = docParts[selectedIdx]!;
  const canPrev = selectedIdx > 0;
  const canNext = selectedIdx < docParts.length - 1;

  const navBtnStyle: React.CSSProperties = {
    background: 'none',
    border: `1px solid ${palette.border}`,
    borderRadius: '3px',
    color: palette.text,
    cursor: 'pointer',
    fontSize: '14px',
    width: '24px',
    height: '24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderBottom: `1px solid ${palette.border}`,
        padding: '8px',
        gap: '6px',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{
          fontSize: '12px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: palette.textMuted,
        }}>
          Parts
        </span>
        <button
          style={{
            background: 'none',
            border: `1px solid ${palette.border}`,
            borderRadius: '3px',
            color: palette.accent,
            cursor: 'pointer',
            fontSize: '10px',
            padding: '2px 6px',
          }}
          onClick={() => handleOpen(currentPart.id)}
          title="Open part editor"
        >
          Open
        </button>
      </div>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      }}>
        <button
          style={{ ...navBtnStyle, opacity: canPrev ? 1 : 0.3 }}
          disabled={!canPrev}
          onClick={() => setSelectedIdx((i) => i - 1)}
        >
          {'\u2039'}
        </button>
        <div
          onClick={() => handleOpen(currentPart.id)}
          style={{ cursor: 'pointer', display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}
          title="Open part editor"
        >
          <PartThumbnail
            part={currentPart}
            width={160}
            height={100}
            background={palette.background}
          />
          <span style={{ fontSize: '10px', color: palette.textSecondary, marginTop: '2px' }}>
            {currentPart.name}
          </span>
        </div>
        <button
          style={{ ...navBtnStyle, opacity: canNext ? 1 : 0.3 }}
          disabled={!canNext}
          onClick={() => setSelectedIdx((i) => i + 1)}
        >
          {'\u203a'}
        </button>
      </div>
      <div style={{ fontSize: '10px', color: palette.textSecondary, textAlign: 'center' }}>
        {selectedIdx + 1} / {docParts.length}
      </div>
    </div>
  );
}
