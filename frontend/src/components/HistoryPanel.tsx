import { useRef, useEffect, useState } from 'react';
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
  const [collapsed, setCollapsed] = useState(false);
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
    <div style={{ borderTop: `1px solid ${palette.border}`, background: palette.panelBg }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '2px 10px',
          fontSize: '11px',
          fontFamily: 'monospace',
          color: palette.textMuted,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span style={{ fontSize: '9px' }}>{collapsed ? '\u25b6' : '\u25bc'}</span>
        <span>History</span>
        <span style={{ flex: 1 }} />
        {!collapsed && (
          <span style={{ color: palette.textMuted, fontSize: '11px' }}>
            {undoStack.length} undo{redoStack.length > 0 ? `, ${redoStack.length} redo` : ''}
          </span>
        )}
      </div>

      {/* History list */}
      {!collapsed && (
        <div
          ref={listRef}
          style={{
            height: '108px',
            overflowY: 'auto',
            padding: '0 10px 4px',
            fontSize: '11px',
            fontFamily: 'monospace',
            lineHeight: '18px',
          }}
        >
          {/* Undo entries: oldest first */}
          {undoStack.map((entry, i) => (
            <div
              key={`u-${i}`}
              style={{
                cursor: 'pointer',
                padding: '0 4px',
                borderRadius: '2px',
                color: palette.text,
                display: 'flex',
                justifyContent: 'space-between',
              }}
              onClick={() => handleClickUndo(i)}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = palette.activeItemBg; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span>{entry.label}</span>
              <span style={{ color: palette.textMuted }}>{relativeTime(entry.timestamp)}</span>
            </div>
          ))}

          {/* Current state marker */}
          <div
            style={{
              padding: '0 4px',
              borderRadius: '2px',
              color: palette.accent,
              fontWeight: 600,
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
                padding: '0 4px',
                borderRadius: '2px',
                color: palette.textMuted,
                opacity: 0.5,
                display: 'flex',
                justifyContent: 'space-between',
              }}
              onClick={() => handleClickRedo(i)}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = palette.activeItemBg; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span>{entry.label}</span>
              <span>{relativeTime(entry.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
