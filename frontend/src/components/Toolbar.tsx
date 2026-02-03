import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { useUIStateStore } from '@/stores/uiStateStore';
import { useThemeStore } from '@/theme';
import { exportDocumentToDxf } from '@/export/dxf';
import { exportDocumentToPdf } from '@/export/pdf';
import { downloadTextFile, downloadBlob } from '@/export/download';
import type { ToolType } from '@/types/editor';

const TOOLS: { type: ToolType; label: string; shortcut: string }[] = [
  { type: 'select', label: 'Select', shortcut: 'V — X construction, M mirror, A circular' },
  { type: 'line', label: 'Line', shortcut: 'l' },
  { type: 'circle', label: 'Circle', shortcut: 'c' },
  { type: 'rectangle', label: 'Rect', shortcut: 'r' },
  { type: 'dimension', label: 'Dimension', shortcut: 'D' },
];

export function Toolbar() {
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const drawerOpen = useUIStateStore((s) => s.drawerOpen);
  const toggleDrawer = useUIStateStore((s) => s.toggleDrawer);
  const doc = useDocumentStore((s) => s.document);
  const palette = useThemeStore((s) => s.palette);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  return (
    <div
      style={{
        display: 'flex',
        gap: '4px',
        padding: '6px 8px',
        background: palette.panelBg,
        borderBottom: `1px solid ${palette.border}`,
      }}
    >
      <button
        onClick={toggleDrawer}
        style={{
          padding: '4px 12px',
          border: `1px solid ${drawerOpen ? palette.accent : palette.inputBorder}`,
          borderRadius: '4px',
          background: drawerOpen ? palette.activeItemBg : palette.buttonBg,
          color: drawerOpen ? palette.accent : palette.text,
          cursor: 'pointer',
          fontSize: '16px',
          marginRight: '8px',
          lineHeight: 1,
        }}
        title="Toggle document drawer"
      >
        {'\u2261'}
      </button>
      {TOOLS.map((t) => (
        <button
          key={t.type}
          onClick={() => setActiveTool(t.type)}
          style={{
            padding: '4px 12px',
            border: `1px solid ${palette.inputBorder}`,
            borderRadius: '4px',
            background: activeTool === t.type ? palette.activeItemBg : palette.buttonBg,
            color: activeTool === t.type ? palette.accent : palette.text,
            borderColor: activeTool === t.type ? palette.accent : palette.inputBorder,
            cursor: 'pointer',
            fontSize: '13px',
          }}
          title={`${t.label} (${t.shortcut})`}
        >
          {t.label}
        </button>
      ))}
      <button
        onClick={() => {
          const ids = useEditorStore.getState().selectedEntityIds;
          if (ids.size === 0) return;
          if (activeTool !== 'select') setActiveTool('select');
          useEditorStore.getState().setMirrorEntityIds([...ids]);
        }}
        style={{
          padding: '4px 12px',
          border: `1px solid ${palette.inputBorder}`,
          borderRadius: '4px',
          background: palette.buttonBg,
          color: palette.text,
          cursor: 'pointer',
          fontSize: '13px',
          marginLeft: '4px',
        }}
        title="Mirror selected entities (M)"
      >
        Mirror
      </button>
      <button
        onClick={() => {
          const ids = useEditorStore.getState().selectedEntityIds;
          if (ids.size === 0) return;
          if (activeTool !== 'select') setActiveTool('select');
          useEditorStore.getState().setCircularCopyEntityIds([...ids]);
        }}
        style={{
          padding: '4px 12px',
          border: `1px solid ${palette.inputBorder}`,
          borderRadius: '4px',
          background: palette.buttonBg,
          color: palette.text,
          cursor: 'pointer',
          fontSize: '13px',
        }}
        title="Circular copy selected entities (A)"
      >
        Circular
      </button>
      <div style={{ flex: 1 }} />
      <button
        onClick={() => {
          const dxf = exportDocumentToDxf(doc);
          downloadTextFile(dxf, `${doc.name}.dxf`, 'application/dxf');
        }}
        style={{
          padding: '4px 12px',
          border: `1px solid ${palette.inputBorder}`,
          borderRadius: '4px',
          background: palette.buttonBg,
          color: palette.textSecondary,
          cursor: 'pointer',
          fontSize: '13px',
        }}
        title="Export visible sketches as DXF"
      >
        Export DXF
      </button>
      <button
        onClick={() => {
          const blob = exportDocumentToPdf(doc, palette);
          downloadBlob(blob, `${doc.name}.pdf`);
        }}
        style={{
          padding: '4px 12px',
          border: `1px solid ${palette.inputBorder}`,
          borderRadius: '4px',
          background: palette.buttonBg,
          color: palette.textSecondary,
          cursor: 'pointer',
          fontSize: '13px',
        }}
        title="Export visible sketches as PDF"
      >
        Export PDF
      </button>
      <button
        onClick={toggleTheme}
        style={{
          padding: '4px 12px',
          border: `1px solid ${palette.inputBorder}`,
          borderRadius: '4px',
          background: palette.buttonBg,
          color: palette.textSecondary,
          cursor: 'pointer',
          fontSize: '13px',
        }}
        title="Toggle light/dark theme"
      >
        {theme === 'dark' ? 'Light' : 'Dark'}
      </button>
    </div>
  );
}
