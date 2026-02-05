import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { useUIStateStore } from '@/stores/uiStateStore';
import { useThemeStore } from '@/theme';
import { exportDocumentToDxf } from '@/export/dxf';
import { exportDocumentToPdf } from '@/export/pdf';
import { downloadTextFile, downloadBlob } from '@/export/download';
import { getEntityPoint, getEntityPoints } from '@/utils/entityPoints';
import { requestSave } from '@/api/autoSave';
import type { ToolType } from '@/types/editor';
import type { ThemePalette } from '@/theme';
import type { ReactNode } from 'react';

function ToolIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const ENTITY_TOOLS: { type: ToolType; label: string; icon?: ReactNode; shortcut: string }[] = [
  { type: 'select', label: 'Select', icon: <ToolIcon><path d="M3 1l0 12 3.5-3.5 3 5.5 2-1-3-5.5H13L3 1z" fill="currentColor" stroke="none" /></ToolIcon>, shortcut: 'Esc — X construction, K fix, = equal, J coincident, H horiz, V vert, I midpoint, N parallel, T perpendicular, Y tangent, B bisect, M mirror, A circular, G grid' },
  { type: 'line', label: 'Line', icon: <ToolIcon><line x1="3" y1="13" x2="13" y2="3" /></ToolIcon>, shortcut: 'l' },
  { type: 'point', label: 'Point', icon: <ToolIcon><circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="5" /></ToolIcon>, shortcut: '.' },
  { type: 'circle', label: 'Circle', icon: <ToolIcon><circle cx="8" cy="8" r="6" /></ToolIcon>, shortcut: 'c' },
  { type: 'rectangle', label: 'Rect', icon: <ToolIcon><rect x="2.5" y="4" width="11" height="8" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /></ToolIcon>, shortcut: 'r' },
  { type: 'rect2pt', label: '2pt Rect', icon: <ToolIcon><rect x="2.5" y="4" width="11" height="8" /><circle cx="2.5" cy="4" r="1.5" fill="currentColor" stroke="none" /><circle cx="13.5" cy="12" r="1.5" fill="currentColor" stroke="none" /></ToolIcon>, shortcut: 'Shift+R' },
  { type: 'polygon', label: 'Polygon', icon: <ToolIcon><polygon points="8,1.5 13.6,5 12.5,11.5 3.5,11.5 2.4,5" /></ToolIcon>, shortcut: 'P — ↑↓ sides' },
];

const MEASURE_TOOLS: { type: ToolType; label: string; icon?: ReactNode; shortcut: string }[] = [
  { type: 'dimension', label: 'Dimension', icon: <ToolIcon><line x1="2" y1="4" x2="2" y2="12" /><line x1="14" y1="4" x2="14" y2="12" /><line x1="2" y1="8" x2="5" y2="8" /><line x1="11" y1="8" x2="14" y2="8" /><path d="M5 6l-3 2 3 2" fill="none" /><path d="M11 6l3 2-3 2" fill="none" /></ToolIcon>, shortcut: 'D' },
];

function Sep({ color }: { color: string }) {
  return <div style={{ width: '1px', background: color, margin: '2px 4px', alignSelf: 'stretch' }} />;
}

function ToolButtons({ tools, activeTool, setActiveTool, palette }: { tools: typeof ENTITY_TOOLS; activeTool: ToolType; setActiveTool: (t: ToolType) => void; palette: ThemePalette }) {
  return <>
    {tools.map((t) => (
      <button
        key={t.type}
        onClick={() => setActiveTool(t.type)}
        style={{
          padding: '4px 12px',
          borderWidth: '1px',
          borderStyle: 'solid',
          borderColor: activeTool === t.type ? palette.accent : palette.inputBorder,
          borderRadius: '4px',
          background: activeTool === t.type ? palette.activeItemBg : palette.buttonBg,
          color: activeTool === t.type ? palette.accent : palette.text,
          cursor: 'pointer',
          fontSize: '13px',
        }}
        title={`${t.label} (${t.shortcut})`}
      >
        {t.icon ?? t.label}
      </button>
    ))}
  </>;
}

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
          lineHeight: 1,
        }}
        title="Toggle document drawer"
      >
        {'\u2261'}
      </button>
      <Sep color={palette.border} />
      <button
        onClick={() => { useDocumentStore.getState().undo(); requestSave(); }}
        style={{
          padding: '4px 12px',
          border: `1px solid ${palette.inputBorder}`,
          borderRadius: '4px',
          background: palette.buttonBg,
          color: palette.text,
          cursor: 'pointer',
          fontSize: '13px',
        }}
        title="Undo (Ctrl+Z)"
      >
        <ToolIcon><path d="M4 7h7a4 4 0 0 1 0 8H9" /><path d="M7 4L4 7l3 3" /></ToolIcon>
      </button>
      <button
        onClick={() => { useDocumentStore.getState().redo(); requestSave(); }}
        style={{
          padding: '4px 12px',
          border: `1px solid ${palette.inputBorder}`,
          borderRadius: '4px',
          background: palette.buttonBg,
          color: palette.text,
          cursor: 'pointer',
          fontSize: '13px',
        }}
        title="Redo (Ctrl+Shift+Z)"
      >
        <ToolIcon><path d="M12 7H5a4 4 0 0 0 0 8h2" /><path d="M9 4l3 3-3 3" /></ToolIcon>
      </button>
      <Sep color={palette.border} />
      <ToolButtons tools={ENTITY_TOOLS} activeTool={activeTool} setActiveTool={setActiveTool} palette={palette} />
      <Sep color={palette.border} />
      <ToolButtons tools={MEASURE_TOOLS} activeTool={activeTool} setActiveTool={setActiveTool} palette={palette} />
      <Sep color={palette.border} />
      <button
        onClick={() => {
          const ids = useEditorStore.getState().selectedEntityIds;
          if (ids.size === 0) return;
          useDocumentStore.getState().beginTransaction('Toggle fixed');
          useDocumentStore.getState().toggleFixed([...ids]);
          requestSave();
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
        title="Fix selected entities in place (K)"
      >
        <ToolIcon><rect x="3" y="7" width="10" height="8" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></ToolIcon>
      </button>
      <button
        onClick={() => {
          const ids = useEditorStore.getState().selectedEntityIds;
          if (ids.size !== 2) return;
          useDocumentStore.getState().beginTransaction('Toggle equal');
          useDocumentStore.getState().toggleEqual([...ids]);
          requestSave();
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
        title="Equal size constraint between two entities (=)"
      >
        <ToolIcon><line x1="2" y1="6" x2="14" y2="6" /><line x1="2" y1="10" x2="14" y2="10" /></ToolIcon>
      </button>
      <button
        onClick={() => {
          const es = useEditorStore.getState();
          const selPts = es.selectedPoints;
          const ids = es.selectedEntityIds;

          if (selPts.length === 2) {
            useDocumentStore.getState().beginTransaction('Toggle coincident');
            useDocumentStore.getState().toggleCoincidentWithPoints(selPts[0]!, selPts[1]!);
            requestSave();
          } else if (selPts.length === 1 && ids.size === 1) {
            const entityId = [...ids][0]!;
            const activeSketch = useDocumentStore.getState().getActiveSketch();
            if (!activeSketch) return;
            const entity = activeSketch.entities.find((ent) => ent.id === entityId);
            const sourceEntity = activeSketch.entities.find((ent) => ent.id === selPts[0]!.entityId);
            if (!entity || !sourceEntity) return;
            const srcPt = getEntityPoint(sourceEntity, selPts[0]!.pointIndex);
            if (!srcPt) return;
            const pts = getEntityPoints(entity);
            let bestDist = Infinity;
            let bestIdx = 0;
            for (const [idx, p] of pts) {
              const d = (p.x - srcPt.x) ** 2 + (p.y - srcPt.y) ** 2;
              if (d < bestDist) { bestDist = d; bestIdx = idx; }
            }
            useDocumentStore.getState().beginTransaction('Toggle coincident');
            useDocumentStore.getState().toggleCoincidentWithPoints(selPts[0]!, { entityId, pointIndex: bestIdx });
            requestSave();
          } else if (ids.size === 2) {
            useDocumentStore.getState().beginTransaction('Toggle coincident');
            useDocumentStore.getState().toggleCoincident([...ids]);
            requestSave();
          } else {
            return;
          }
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
        title="Coincident constraint — join closest points (J)"
      >
        <ToolIcon><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" /></ToolIcon>
      </button>
      <button
        onClick={() => {
          const es = useEditorStore.getState();
          const ids = es.selectedEntityIds;
          if (ids.size === 0) return;
          const segs = es.selectedSegments.length > 0
            ? es.selectedSegments.map((s) => ({ entityId: s.entityId, segmentIndex: s.segmentIndex }))
            : undefined;
          useDocumentStore.getState().beginTransaction('Toggle horizontal');
          useDocumentStore.getState().toggleHorizontal([...ids], segs);
          requestSave();
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
        title="Horizontal constraint — force segment endpoints to same Y (H)"
      >
        <ToolIcon><line x1="2" y1="8" x2="14" y2="8" /></ToolIcon>
      </button>
      <button
        onClick={() => {
          const es = useEditorStore.getState();
          const ids = es.selectedEntityIds;
          if (ids.size === 0) return;
          const segs = es.selectedSegments.length > 0
            ? es.selectedSegments.map((s) => ({ entityId: s.entityId, segmentIndex: s.segmentIndex }))
            : undefined;
          useDocumentStore.getState().beginTransaction('Toggle vertical');
          useDocumentStore.getState().toggleVertical([...ids], segs);
          requestSave();
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
        title="Vertical constraint — force segment endpoints to same X (V)"
      >
        <ToolIcon><line x1="8" y1="2" x2="8" y2="14" /></ToolIcon>
      </button>
      <button
        onClick={() => {
          const es = useEditorStore.getState();
          const selPts = es.selectedPoints;
          const selSegs = es.selectedSegments;
          if (selPts.length !== 1 || selSegs.length !== 1) return;
          useDocumentStore.getState().beginTransaction('Toggle midpoint');
          useDocumentStore.getState().toggleMidpoint(selPts[0]!, selSegs[0]!);
          requestSave();
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
        title="Midpoint constraint — pin point to segment midpoint (I)"
      >
        <ToolIcon><line x1="2" y1="8" x2="14" y2="8" /><line x1="8" y1="5" x2="8" y2="11" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /></ToolIcon>
      </button>
      <button
        onClick={() => {
          const es = useEditorStore.getState();
          const selSegs = es.selectedSegments;
          if (selSegs.length !== 2) return;
          useDocumentStore.getState().beginTransaction('Toggle parallel');
          useDocumentStore.getState().toggleParallel(selSegs[0]!, selSegs[1]!);
          requestSave();
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
        title="Parallel constraint — force two segments parallel (N)"
      >
        <ToolIcon><line x1="4" y1="2" x2="4" y2="14" /><line x1="12" y1="2" x2="12" y2="14" /></ToolIcon>
      </button>
      <button
        onClick={() => {
          const es = useEditorStore.getState();
          const selSegs = es.selectedSegments;
          if (selSegs.length !== 2) return;
          useDocumentStore.getState().beginTransaction('Toggle perpendicular');
          useDocumentStore.getState().togglePerpendicular(selSegs[0]!, selSegs[1]!);
          requestSave();
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
        title="Perpendicular constraint — force two segments perpendicular (T)"
      >
        <ToolIcon><line x1="3" y1="13" x2="3" y2="3" /><line x1="3" y1="13" x2="13" y2="13" /><rect x="3" y="9" width="4" height="4" fill="none" /></ToolIcon>
      </button>
      <button
        onClick={() => {
          const es = useEditorStore.getState();
          const selSegs = es.selectedSegments;
          const ids = es.selectedEntityIds;
          const activeSketch = useDocumentStore.getState().getActiveSketch();
          if (!activeSketch) return;
          if (selSegs.length === 1 && ids.size === 2) {
            const segEntityId = selSegs[0]!.entityId;
            const otherIds = [...ids].filter((id) => id !== segEntityId);
            if (otherIds.length === 1) {
              const otherEntity = activeSketch.entities.find((ent) => ent.id === otherIds[0]!);
              if (otherEntity && otherEntity.type === 'circle') {
                useDocumentStore.getState().beginTransaction('Toggle tangent');
                useDocumentStore.getState().toggleTangent(segEntityId, selSegs[0]!.segmentIndex, otherIds[0]!, -1);
                requestSave();
              }
            }
          } else if (ids.size === 2 && selSegs.length === 0) {
            const idArr = [...ids];
            const e1 = activeSketch.entities.find((ent) => ent.id === idArr[0]!);
            const e2 = activeSketch.entities.find((ent) => ent.id === idArr[1]!);
            if (e1 && e2 && e1.type === 'circle' && e2.type === 'circle') {
              useDocumentStore.getState().beginTransaction('Toggle tangent');
              useDocumentStore.getState().toggleTangent(idArr[0]!, -1, idArr[1]!, -1);
              requestSave();
            }
          }
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
        title="Tangent constraint — force line/circle tangency (Y)"
      >
        <ToolIcon><circle cx="8" cy="6" r="4.5" /><line x1="2" y1="10.5" x2="14" y2="10.5" /></ToolIcon>
      </button>
      <button
        onClick={() => {
          const es = useEditorStore.getState();
          const selSegs = es.selectedSegments;
          if (selSegs.length !== 2) return;
          useDocumentStore.getState().beginTransaction('Toggle bisect');
          useDocumentStore.getState().toggleBisect(selSegs[0]!, selSegs[1]!);
          requestSave();
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
        title="Bisect constraint — first segment passes through midpoint of second (B)"
      >
        <ToolIcon><line x1="2" y1="13" x2="14" y2="3" /><line x1="8" y1="2" x2="8" y2="14" strokeDasharray="2 2" /></ToolIcon>
      </button>
      <Sep color={palette.border} />
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
        }}
        title="Mirror selected entities (M)"
      >
        <ToolIcon><polygon points="5,3 1,8 5,13" /><line x1="8" y1="1" x2="8" y2="15" /><polygon points="11,3 15,8 11,13" /></ToolIcon>
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
        <ToolIcon><circle cx="8" cy="8" r="6" strokeDasharray="3 2" /><circle cx="8" cy="2" r="1.5" fill="currentColor" stroke="none" /><circle cx="13.2" cy="11" r="1.5" fill="currentColor" stroke="none" /><circle cx="2.8" cy="11" r="1.5" fill="currentColor" stroke="none" /></ToolIcon>
      </button>
      <button
        onClick={() => {
          const ids = useEditorStore.getState().selectedEntityIds;
          if (ids.size === 0) return;
          if (activeTool !== 'select') setActiveTool('select');
          useEditorStore.getState().setGridCopyEntityIds([...ids]);
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
        title="Grid copy selected entities (G)"
      >
        <ToolIcon><rect x="1.5" y="1.5" width="4" height="4" /><rect x="6" y="1.5" width="4" height="4" strokeDasharray="1.5 1" /><rect x="10.5" y="1.5" width="4" height="4" strokeDasharray="1.5 1" /><rect x="1.5" y="6" width="4" height="4" strokeDasharray="1.5 1" /><rect x="1.5" y="10.5" width="4" height="4" strokeDasharray="1.5 1" /></ToolIcon>
      </button>
      <Sep color={palette.border} />
      <button
        onClick={() => useEditorStore.getState().setViewportCommand('center-origin')}
        style={{
          padding: '4px 12px',
          border: `1px solid ${palette.inputBorder}`,
          borderRadius: '4px',
          background: palette.buttonBg,
          color: palette.text,
          cursor: 'pointer',
          fontSize: '13px',
        }}
        title="Center origin in viewport (Home)"
      >
        Origin
      </button>
      <button
        onClick={() => useEditorStore.getState().setViewportCommand('fit-entities')}
        style={{
          padding: '4px 12px',
          border: `1px solid ${palette.inputBorder}`,
          borderRadius: '4px',
          background: palette.buttonBg,
          color: palette.text,
          cursor: 'pointer',
          fontSize: '13px',
        }}
        title="Fit all entities in viewport (F)"
      >
        Fit All
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
