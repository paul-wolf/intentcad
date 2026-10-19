import { useRef, useEffect } from 'react';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

/** The steps so far, oldest first. Clicking one shows the sketch just after
 *  it (Start: before any); the steps below the highlighted one are undone and
 *  can be clicked to redo them. */
export function HistoryPanel() {
  const undoStack = useDocumentStore((s) => s.undoStack);
  const redoStack = useDocumentStore((s) => s.redoStack);
  const goToHistory = useDocumentStore((s) => s.goToHistory);
  const palette = useThemeStore((s) => s.palette);
  const listRef = useRef<HTMLDivElement>(null);

  // row 0 is Start, row k the state after step k
  const rows = [
    { label: 'Start', timestamp: undefined as number | undefined },
    ...undoStack.map((e) => ({ label: e.label, timestamp: e.timestamp as number | undefined })),
    ...[...redoStack].reverse().map((e) => ({ label: e.label, timestamp: e.timestamp as number | undefined })),
  ];
  const current = undoStack.length;

  // keep the current step in view
  useEffect(() => {
    (listRef.current?.children[current] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [current, undoStack, redoStack]);

  return (
    <div
      style={{
        width: '160px',
        flexShrink: 0,
        background: palette.panelBg,
        borderRight: `1px solid ${palette.border}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
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
          History
        </span>
        <span style={{ color: palette.textMuted, fontSize: '10px' }}
              title={redoStack.length > 0 ? `${undoStack.length} steps, ${redoStack.length} undone` : `${undoStack.length} steps`}>
          {undoStack.length}
          {redoStack.length > 0 ? `/${redoStack.length}` : ''}
        </span>
      </div>

      {/* History list */}
      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 0',
          fontSize: '11px',
          fontFamily: 'monospace',
        }}
      >
        {rows.map((row, i) => {
          const isCurrent = i === current;
          const undone = i > current;
          return (
            <div
              key={i}
              title={isCurrent ? 'Where you are now'
                : i === 0 ? 'Back to before the first step'
                : undone ? `Redo up to and including ${row.label}` : `Back to just after ${row.label}`}
              style={{
                cursor: isCurrent ? 'default' : 'pointer',
                padding: '3px 10px 3px 8px',
                borderLeft: `2px solid ${isCurrent ? palette.accent : 'transparent'}`,
                color: isCurrent ? palette.accent : undone ? palette.textMuted : palette.text,
                fontWeight: isCurrent ? 600 : undefined,
                opacity: undone ? 0.5 : 1,
                display: 'flex',
                flexDirection: 'column',
                gap: '1px',
              }}
              onClick={isCurrent ? undefined : () => goToHistory(i)}
              onMouseEnter={(e) => { if (!isCurrent) (e.currentTarget as HTMLElement).style.background = palette.activeItemBg; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.label}
              </span>
              {row.timestamp !== undefined && (
                <span style={{ color: palette.textMuted, fontSize: '9px', fontWeight: 400 }}>
                  {relativeTime(row.timestamp)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
