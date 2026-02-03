import { useEditorStore } from '@/stores/editorStore';
import type { ToolType } from '@/types/editor';

const TOOLS: { type: ToolType; label: string; shortcut: string }[] = [
  { type: 'select', label: 'Select', shortcut: 'V' },
  { type: 'line', label: 'Line', shortcut: 'L' },
  { type: 'dimension', label: 'Dimension', shortcut: 'D' },
];

export function Toolbar() {
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);

  return (
    <div style={styles.container}>
      {TOOLS.map((t) => (
        <button
          key={t.type}
          onClick={() => setActiveTool(t.type)}
          style={{
            ...styles.button,
            ...(activeTool === t.type ? styles.active : {}),
          }}
          title={`${t.label} (${t.shortcut})`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    gap: '4px',
    padding: '6px 8px',
    background: '#1e293b',
    borderBottom: '1px solid #334155',
  } as React.CSSProperties,
  button: {
    padding: '4px 12px',
    border: '1px solid #475569',
    borderRadius: '4px',
    background: '#0f172a',
    color: '#e2e8f0',
    cursor: 'pointer',
    fontSize: '13px',
  } as React.CSSProperties,
  active: {
    background: '#334155',
    borderColor: '#60a5fa',
    color: '#60a5fa',
  } as React.CSSProperties,
};
