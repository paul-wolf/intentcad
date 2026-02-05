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

export function HistoryPanel() {
  const undoStack = useDocumentStore((s) => s.undoStack);
  const redoStack = useDocumentStore((s) => s.redoStack);
  const jumpToHistory = useDocumentStore((s) => s.jumpToHistory);
  const redo = useDocumentStore((s) => s.redo);
  const palette = useThemeStore((s) => s.palette);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to keep current state visible
  useEffect(() => {
    const el = listRef.current;
    if (el) {
      // Current state is at index = undoStack.length, scroll it into view
      const rows = el.children;
      const currentIdx = undoStack.length;
      if (rows[currentIdx]) {
        (rows[currentIdx] as HTMLElement).scrollIntoView({ block: 'nearest' });
      }
    }
  }, [undoStack, redoStack]);

  const handleClickUndo = (index: number) => {
    jumpToHistory(index);
  };

  const handleClickRedo = (redoIndex: number) => {
    // Redo entries are stored in reverse order (last = most recent undo).
    // To jump to a redo entry at position redoIndex (0=first shown after current),
    // we need to redo (redoStack.length - 1 - redoIndex) times.
    const timesToRedo = redoIndex + 1;
    for (let i = 0; i < timesToRedo; i++) {
      redo();
    }
  };

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
        <span style={{ color: palette.textMuted, fontSize: '10px' }}>
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
        {/* Undo entries: oldest first */}
        {undoStack.map((entry, i) => (
          <div
            key={`u-${i}`}
            style={{
              cursor: 'pointer',
              padding: '3px 10px',
              color: palette.text,
              display: 'flex',
              flexDirection: 'column',
              gap: '1px',
            }}
            onClick={() => handleClickUndo(i)}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = palette.activeItemBg; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.label}
            </span>
            <span style={{ color: palette.textMuted, fontSize: '9px' }}>
              {relativeTime(entry.timestamp)}
            </span>
          </div>
        ))}

        {/* Current state marker */}
        <div
          style={{
            padding: '3px 10px',
            color: palette.accent,
            fontWeight: 600,
            borderLeft: `2px solid ${palette.accent}`,
            marginLeft: '0',
          }}
        >
          Current
        </div>

        {/* Redo entries: shown after current, dimmed, in reverse order (next redo first) */}
        {[...redoStack].reverse().map((entry, i) => (
          <div
            key={`r-${i}`}
            style={{
              cursor: 'pointer',
              padding: '3px 10px',
              color: palette.textMuted,
              opacity: 0.5,
              display: 'flex',
              flexDirection: 'column',
              gap: '1px',
            }}
            onClick={() => handleClickRedo(i)}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = palette.activeItemBg; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.label}
            </span>
            <span style={{ fontSize: '9px' }}>
              {relativeTime(entry.timestamp)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
