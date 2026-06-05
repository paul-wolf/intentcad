import { useRef, useEffect, useState } from 'react';
import { useLogStore } from '@/stores/logStore';
import { useThemeStore } from '@/theme';
import type { LogEntry } from '@/stores/logStore';
import { ClipboardPanel } from './ClipboardPanel';

export function LogPanel() {
  const entries = useLogStore((s) => s.entries);
  const clearLog = useLogStore((s) => s.clear);
  const palette = useThemeStore((s) => s.palette);
  const [collapsed, setCollapsed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return (
      d.getHours().toString().padStart(2, '0') + ':' +
      d.getMinutes().toString().padStart(2, '0') + ':' +
      d.getSeconds().toString().padStart(2, '0')
    );
  };

  const levelColor = (entry: LogEntry) => {
    if (entry.level === 'warn') return palette.warning;
    if (entry.level === 'error') return palette.danger;
    return palette.text;
  };

  return (
    <div style={{ borderTop: `1px solid ${palette.border}`, background: palette.panelBg, display: 'flex' }}>
      {/* Log section */}
      <div style={{ flex: 1, minWidth: 0 }}>
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
          <span>Log</span>
          <span style={{ flex: 1 }} />
          {!collapsed && (
            <span
              style={{ color: palette.textMuted, cursor: 'pointer', fontSize: '11px' }}
              onClick={(e) => { e.stopPropagation(); clearLog(); }}
            >
              Clear
            </span>
          )}
        </div>

        {/* Log list */}
        {!collapsed && (
          <div
            ref={listRef}
            style={{
              height: '108px',
              overflowY: 'auto',
              padding: '0 10px 4px',
              fontSize: '11px',
              fontFamily: 'monospace',
              lineHeight: '16px',
            }}
          >
            {entries.map((entry) => (
              <div key={entry.id}>
                <span style={{ color: palette.textMuted }}>{formatTime(entry.timestamp)}</span>
                {' '}
                <span style={{ color: levelColor(entry) }}>{entry.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Clipboard panel on the right */}
      {!collapsed && <ClipboardPanel />}
    </div>
  );
}
