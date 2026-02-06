import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useThemeStore } from '@/theme';
import { partApi, type PartListItem } from '@/api/client';
import { getBackendId, flushSave } from '@/api/autoSave';

export function PartsPanel() {
  const navigate = useNavigate();
  const palette = useThemeStore((s) => s.palette);
  const [parts, setParts] = useState<PartListItem[]>([]);

  const backendId = getBackendId();

  useEffect(() => {
    if (!backendId) return;
    let cancelled = false;
    partApi.listParts()
      .then((all) => {
        if (cancelled) return;
        // Filter to parts belonging to this document
        // We need to fetch each part to check documentId, but that's expensive.
        // Instead, store documentId in the list response. For now, show all and
        // let the user see which are theirs. We'll improve this.
        setParts(all);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [backendId]);

  // Filter parts that belong to this document by fetching their data
  const [docParts, setDocParts] = useState<PartListItem[]>([]);

  useEffect(() => {
    if (!backendId || parts.length === 0) {
      setDocParts([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      parts.map((p) =>
        partApi.getPart(p.id).then((full) => {
          const data = full.data as { documentId?: string };
          return data.documentId === backendId ? p : null;
        }).catch(() => null)
      )
    ).then((results) => {
      if (!cancelled) {
        setDocParts(results.filter((r): r is PartListItem => r !== null));
      }
    });
    return () => { cancelled = true; };
  }, [backendId, parts]);

  const handleOpen = (id: string) => {
    flushSave();
    navigate(`/part/${id}`);
  };

  if (docParts.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderBottom: `1px solid ${palette.border}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 10px',
          borderBottom: `1px solid ${palette.border}`,
        }}
      >
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            color: palette.textMuted,
          }}
        >
          Parts
        </span>
      </div>
      {docParts.map((p) => (
        <div
          key={p.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '6px 10px',
            cursor: 'pointer',
            fontSize: '12px',
            color: palette.text,
          }}
          onClick={() => handleOpen(p.id)}
          title="Open 3D part editor"
        >
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.name}
          </span>
          <span style={{ fontSize: '10px', color: palette.accent, flexShrink: 0 }}>
            3D
          </span>
        </div>
      ))}
    </div>
  );
}
