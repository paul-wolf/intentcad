import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';

export function StatusBar() {
  const cursorWorld = useEditorStore((s) => s.cursorWorld);
  const activeTool = useEditorStore((s) => s.activeTool);
  const docName = useDocumentStore((s) => s.document.name);
  const palette = useThemeStore((s) => s.palette);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '4px 10px',
        background: palette.panelBg,
        borderTop: `1px solid ${palette.border}`,
        fontSize: '12px',
        color: palette.textMuted,
        fontFamily: 'monospace',
      }}
    >
      <span>{docName}</span>
      <span style={{ color: palette.inputBorder }}>|</span>
      <span>Tool: {activeTool}</span>
      <span style={{ color: palette.inputBorder }}>|</span>
      <span>
        {cursorWorld
          ? `${cursorWorld.x.toFixed(1)} , ${cursorWorld.y.toFixed(1)} mm`
          : '— , — mm'}
      </span>
    </div>
  );
}
