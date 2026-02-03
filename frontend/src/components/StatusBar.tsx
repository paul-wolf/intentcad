import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';

export function StatusBar() {
  const cursorWorld = useEditorStore((s) => s.cursorWorld);
  const activeTool = useEditorStore((s) => s.activeTool);
  const docName = useDocumentStore((s) => s.document.name);

  return (
    <div style={styles.container}>
      <span style={styles.section}>{docName}</span>
      <span style={styles.separator}>|</span>
      <span style={styles.section}>Tool: {activeTool}</span>
      <span style={styles.separator}>|</span>
      <span style={styles.section}>
        {cursorWorld
          ? `${cursorWorld.x.toFixed(1)} , ${cursorWorld.y.toFixed(1)} mm`
          : '— , — mm'}
      </span>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 10px',
    background: '#1e293b',
    borderTop: '1px solid #334155',
    fontSize: '12px',
    color: '#94a3b8',
    fontFamily: 'monospace',
  } as React.CSSProperties,
  section: {} as React.CSSProperties,
  separator: {
    color: '#475569',
  } as React.CSSProperties,
};
