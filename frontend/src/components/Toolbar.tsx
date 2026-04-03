import { useNavigate } from 'react-router-dom';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { useUIStateStore } from '@/stores/uiStateStore';
import { useCamStore } from '@/stores/camStore';
import { useThemeStore } from '@/theme';
import { exportDocumentToDxf } from '@/export/dxf';
import { importDxf } from '@/export/dxfImport';
import { exportDocumentToPdf } from '@/export/pdf';
import { downloadTextFile, downloadBlob } from '@/export/download';
import { getEntityPoint, getEntityPoints } from '@/utils/entityPoints';
import { getSegmentCount } from '@/utils/lineSegments';
import { requestSave, getBackendId, flushSaveAsync } from '@/api/autoSave';
import { addLog } from '@/stores/logStore';
import { api, partApi } from '@/api/cachedClient';
import type { ToolType } from '@/types/editor';
import type { ThemePalette } from '@/theme';
import type { ReactNode } from 'react';

/** Resolve two segments: prefer explicit segment selection, fall back to entity selection for single-segment lines. */
function resolveTwoSegments(): { entityId: string; segmentIndex: number }[] | null {
  const es = useEditorStore.getState();
  if (es.selectedSegments.length === 2) return es.selectedSegments;
  if (es.selectedEntityIds.size === 2) {
    const sketch = useDocumentStore.getState().getActiveSketch();
    if (!sketch) return null;
    const ids = [...es.selectedEntityIds];
    const segs: { entityId: string; segmentIndex: number }[] = [];
    for (const id of ids) {
      const entity = sketch.entities.find((e) => e.id === id);
      if (!entity || entity.type !== 'line') return null;
      if (getSegmentCount(entity) !== 1) return null;
      segs.push({ entityId: id, segmentIndex: 0 });
    }
    return segs;
  }
  return null;
}

function ToolIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const ENTITY_TOOLS: { type: ToolType; label: string; icon?: ReactNode; shortcut: string }[] = [
  { type: 'select', label: 'Select', icon: <ToolIcon><path d="M3 1l0 12 3.5-3.5 3 5.5 2-1-3-5.5H13L3 1z" fill="currentColor" stroke="none" /></ToolIcon>, shortcut: 'Esc' },
  { type: 'line', label: 'Line', icon: <ToolIcon><line x1="3" y1="13" x2="13" y2="3" /></ToolIcon>, shortcut: 'l' },
  { type: 'point', label: 'Point', icon: <ToolIcon><circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="5" /></ToolIcon>, shortcut: '.' },
  { type: 'circle', label: 'Circle', icon: <ToolIcon><circle cx="8" cy="8" r="6" /></ToolIcon>, shortcut: 'c' },
  { type: 'rectangle', label: 'Rect', icon: <ToolIcon><rect x="2.5" y="4" width="11" height="8" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /></ToolIcon>, shortcut: 'r' },
  { type: 'rect2pt', label: '2pt Rect', icon: <ToolIcon><rect x="2.5" y="4" width="11" height="8" /><circle cx="2.5" cy="4" r="1.5" fill="currentColor" stroke="none" /><circle cx="13.5" cy="12" r="1.5" fill="currentColor" stroke="none" /></ToolIcon>, shortcut: 'Shift+R' },
  { type: 'polygon', label: 'Polygon', icon: <ToolIcon><polygon points="8,1.5 13.6,5 12.5,11.5 3.5,11.5 2.4,5" /></ToolIcon>, shortcut: 'P' },
  { type: 'bezier', label: 'Bezier', icon: <ToolIcon><path d="M2 13 C5 1, 11 15, 14 3" fill="none" /><line x1="2" y1="13" x2="5" y2="1" strokeDasharray="1.5 1" strokeWidth="1" /><line x1="14" y1="3" x2="11" y2="15" strokeDasharray="1.5 1" strokeWidth="1" /><circle cx="5" cy="1" r="1.2" fill="currentColor" stroke="none" /><circle cx="11" cy="15" r="1.2" fill="currentColor" stroke="none" /></ToolIcon>, shortcut: 's' },
];

const MEASURE_TOOLS: { type: ToolType; label: string; icon?: ReactNode; shortcut: string }[] = [
  { type: 'dimension', label: 'Dimension', icon: <ToolIcon><line x1="2" y1="4" x2="2" y2="12" /><line x1="14" y1="4" x2="14" y2="12" /><line x1="2" y1="8" x2="5" y2="8" /><line x1="11" y1="8" x2="14" y2="8" /><path d="M5 6l-3 2 3 2" fill="none" /><path d="M11 6l3 2-3 2" fill="none" /></ToolIcon>, shortcut: 'D' },
];

function Sep({ color }: { color: string }) {
  return <div style={{ width: '1px', background: color, margin: '2px 4px', alignSelf: 'stretch' }} />;
}

const BTN_PAD = '4px 8px';

function btn(palette: ThemePalette, active = false): React.CSSProperties {
  return {
    padding: BTN_PAD,
    border: `1px solid ${active ? palette.accent : palette.inputBorder}`,
    borderRadius: '4px',
    background: active ? palette.activeItemBg : palette.buttonBg,
    color: active ? palette.accent : palette.text,
    cursor: 'pointer',
    fontSize: '13px',
    lineHeight: 1,
  };
}

function ToolButtons({ tools, activeTool, setActiveTool, palette }: { tools: typeof ENTITY_TOOLS; activeTool: ToolType; setActiveTool: (t: ToolType) => void; palette: ThemePalette }) {
  return <>
    {tools.map((t) => (
      <button
        key={t.type}
        onClick={() => setActiveTool(t.type)}
        style={btn(palette, activeTool === t.type)}
        title={`${t.label} (${t.shortcut})`}
      >
        {t.icon ?? t.label}
      </button>
    ))}
  </>;
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '3px',
  alignItems: 'center',
};

export function Toolbar() {
  const navigate = useNavigate();
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const drawerOpen = useUIStateStore((s) => s.drawerOpen);
  const toggleDrawer = useUIStateStore((s) => s.toggleDrawer);
  const propertiesOpen = useUIStateStore((s) => s.propertiesOpen);
  const toggleProperties = useUIStateStore((s) => s.toggleProperties);
  const doc = useDocumentStore((s) => s.document);
  const palette = useThemeStore((s) => s.palette);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const camPanelOpen = useCamStore((s) => s.camPanelOpen);
  const toggleCamPanel = useCamStore((s) => s.toggleCamPanel);
  const showToolpathPreview = useCamStore((s) => s.showToolpathPreview);
  const toggleToolpathPreview = useCamStore((s) => s.toggleToolpathPreview);

  // In CAM mode, show a simplified toolbar
  if (camPanelOpen) {
    return (
      <div style={{ background: palette.panelBg, borderBottom: `1px solid ${palette.border}`, padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
        <div style={rowStyle}>
          <button
            onClick={() => navigate('/')}
            style={btn(palette)}
            title="Back to document list"
          >
            Home
          </button>
          <Sep color={palette.border} />
          <button
            onClick={toggleCamPanel}
            style={{ ...btn(palette), background: palette.primaryBtn, color: '#fff', borderColor: palette.primaryBtn }}
            title="Exit CAM mode and return to sketch editing"
          >
            &larr; Sketch
          </button>
          <Sep color={palette.border} />
          <span style={{ fontSize: '13px', fontWeight: 600, color: palette.text, padding: '4px 0' }}>
            CAM Mode
          </span>
          <span style={{ fontSize: '11px', color: palette.textSecondary, padding: '4px 0' }}>
            — Select entities, then assign to operations
          </span>

          <div style={{ flex: 1 }} />

          <button onClick={toggleToolpathPreview} style={{ ...btn(palette, showToolpathPreview), color: showToolpathPreview ? palette.accent : palette.textSecondary }} title="Toggle toolpath preview overlay">
            <ToolIcon><circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /><line x1="8" y1="2" x2="8" y2="0.5" /><line x1="8" y1="14" x2="8" y2="15.5" /></ToolIcon>
          </button>
          <Sep color={palette.border} />
          <button
            onClick={() => useEditorStore.getState().setViewportCommand('center-origin')}
            style={btn(palette)}
            title="Center origin in viewport (Home)"
          >
            Origin
          </button>
          <button
            onClick={() => useEditorStore.getState().setViewportCommand('fit-entities')}
            style={btn(palette)}
            title="Fit all entities in viewport (Shift+F)"
          >
            Fit All
          </button>
          <Sep color={palette.border} />
          <button onClick={toggleTheme} style={{ ...btn(palette), color: palette.textSecondary }} title="Toggle light/dark theme">
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: palette.panelBg, borderBottom: `1px solid ${palette.border}`, padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: '3px' }}>

      {/* ── Row 1: Draw ── */}
      <div style={rowStyle}>
        <button
          onClick={() => navigate('/')}
          style={btn(palette)}
          title="Back to document list"
        >
          Home
        </button>
        <Sep color={palette.border} />
        <button
          onClick={toggleDrawer}
          style={{ ...btn(palette, drawerOpen), fontSize: '16px' }}
          title="Toggle document drawer"
        >
          {'\u2261'}
        </button>
        <Sep color={palette.border} />
        <button onClick={() => { useDocumentStore.getState().undo(); requestSave(); }} style={btn(palette)} title="Undo (Ctrl+Z)">
          <ToolIcon><path d="M4 7h7a4 4 0 0 1 0 8H9" /><path d="M7 4L4 7l3 3" /></ToolIcon>
        </button>
        <button onClick={() => { useDocumentStore.getState().redo(); requestSave(); }} style={btn(palette)} title="Redo (Ctrl+Shift+Z)">
          <ToolIcon><path d="M12 7H5a4 4 0 0 0 0 8h2" /><path d="M9 4l3 3-3 3" /></ToolIcon>
        </button>
        <Sep color={palette.border} />
        <ToolButtons tools={ENTITY_TOOLS} activeTool={activeTool} setActiveTool={setActiveTool} palette={palette} />
        <Sep color={palette.border} />
        <ToolButtons tools={MEASURE_TOOLS} activeTool={activeTool} setActiveTool={setActiveTool} palette={palette} />

        <div style={{ flex: 1 }} />

        <button onClick={toggleProperties} style={btn(palette, propertiesOpen)} title="Toggle document properties panel">
          Props
        </button>
        <Sep color={palette.border} />
        <button
          onClick={async () => {
            const backendId = getBackendId();
            if (!backendId) return;
            try {
              // Ensure latest sketch data is saved before creating the part
              requestSave();
              await flushSaveAsync();
              // Fetch document to get its project_id for inheritance
              const docData = await api.getDocument(backendId);
              const saved = await partApi.createPart(doc.name + ' Part', {
                id: crypto.randomUUID(),
                name: doc.name + ' Part',
                documentId: backendId,
                features: [],
              }, docData.project_id ?? undefined);
              navigate(`/part/${saved.id}`);
            } catch (err) {
              console.error('Failed to create part:', err);
            }
          }}
          style={{ ...btn(palette), background: palette.primaryBtn, color: '#fff', borderColor: palette.primaryBtn }}
          title="Create a new 3D Part from this sketch"
        >
          New Part
        </button>
        <Sep color={palette.border} />
        <button
          onClick={() => { downloadTextFile(exportDocumentToDxf(doc), `${doc.name}.dxf`, 'application/dxf'); }}
          style={{ ...btn(palette), color: palette.textSecondary }}
          title="Export visible sketches as DXF"
        >
          DXF
        </button>
        <button
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.dxf';
            input.onchange = () => {
              const file = input.files?.[0];
              if (!file) return;
              file.text().then((text) => {
                const result = importDxf(text);
                if (result.entities.length === 0) {
                  addLog('warn', 'No supported entities found in DXF file');
                  return;
                }
                const store = useDocumentStore.getState();
                if (!store.getActiveSketch()) {
                  addLog('warn', 'No active sketch — create or select a sketch first');
                  return;
                }
                store.beginTransaction('Import DXF');
                for (const entity of result.entities) {
                  useDocumentStore.getState().addEntity(entity);
                }
                useDocumentStore.getState().centerToOrigin();
                requestSave();
                setTimeout(() => useEditorStore.getState().setViewportCommand('fit-entities'), 0);
                let msg = `Imported ${result.entities.length} entities from DXF`;
                if (result.skipped > 0) {
                  msg += ` (${result.skipped} skipped: ${result.skippedTypes.join(', ')})`;
                }
                addLog('info', msg);
              });
            };
            input.click();
          }}
          style={{ ...btn(palette), color: palette.textSecondary }}
          title="Import DXF file into active sketch"
        >
          +DXF
        </button>
        <button
          onClick={() => { downloadBlob(exportDocumentToPdf(doc, palette), `${doc.name}.pdf`); }}
          style={{ ...btn(palette), color: palette.textSecondary }}
          title="Export visible sketches as PDF"
        >
          PDF
        </button>
        <Sep color={palette.border} />
        <button onClick={toggleCamPanel} style={btn(palette, camPanelOpen)} title="Toggle CAM panel for G-code generation">
          CAM
        </button>
        <button onClick={toggleTheme} style={{ ...btn(palette), color: palette.textSecondary }} title="Toggle light/dark theme">
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>

      {/* ── Row 2: Edit ── */}
      <div style={rowStyle}>
        {/* Constraints */}
        <button
          onClick={() => {
            const ids = useEditorStore.getState().selectedEntityIds;
            if (ids.size === 0) return;
            useDocumentStore.getState().beginTransaction('Toggle fixed');
            useDocumentStore.getState().toggleFixed([...ids]);
            requestSave();
          }}
          style={btn(palette)}
          title="Fix selected entities in place (K)"
        >
          <ToolIcon><rect x="3" y="7" width="10" height="8" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></ToolIcon>
        </button>
        <button
          onClick={() => {
            const es = useEditorStore.getState();
            const selSegs = es.selectedSegments;
            if (selSegs.length === 2) {
              useDocumentStore.getState().beginTransaction('Toggle equal');
              useDocumentStore.getState().toggleEqual(
                [selSegs[0]!.entityId, selSegs[1]!.entityId],
                [selSegs[0]!, selSegs[1]!],
              );
              requestSave();
              return;
            }
            const ids = es.selectedEntityIds;
            if (ids.size !== 2) return;
            useDocumentStore.getState().beginTransaction('Toggle equal');
            useDocumentStore.getState().toggleEqual([...ids]);
            requestSave();
          }}
          style={btn(palette)}
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
            }
          }}
          style={btn(palette)}
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
          style={btn(palette)}
          title="Horizontal constraint (H)"
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
          style={btn(palette)}
          title="Vertical constraint (V)"
        >
          <ToolIcon><line x1="8" y1="2" x2="8" y2="14" /></ToolIcon>
        </button>
        <button
          onClick={() => {
            const es = useEditorStore.getState();
            if (es.selectedPoints.length !== 1 || es.selectedSegments.length !== 1) return;
            useDocumentStore.getState().beginTransaction('Toggle midpoint');
            useDocumentStore.getState().toggleMidpoint(es.selectedPoints[0]!, es.selectedSegments[0]!);
            requestSave();
          }}
          style={btn(palette)}
          title="Midpoint constraint (I)"
        >
          <ToolIcon><line x1="2" y1="8" x2="14" y2="8" /><line x1="8" y1="5" x2="8" y2="11" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /></ToolIcon>
        </button>
        <button
          onClick={() => {
            const segs = resolveTwoSegments();
            if (!segs) return;
            useDocumentStore.getState().beginTransaction('Toggle parallel');
            useDocumentStore.getState().toggleParallel(segs[0]!, segs[1]!);
            requestSave();
          }}
          style={btn(palette)}
          title="Parallel constraint (N)"
        >
          <ToolIcon><line x1="4" y1="2" x2="4" y2="14" /><line x1="12" y1="2" x2="12" y2="14" /></ToolIcon>
        </button>
        <button
          onClick={() => {
            const segs = resolveTwoSegments();
            if (!segs) return;
            useDocumentStore.getState().beginTransaction('Toggle perpendicular');
            useDocumentStore.getState().togglePerpendicular(segs[0]!, segs[1]!);
            requestSave();
          }}
          style={btn(palette)}
          title="Perpendicular constraint (T)"
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
          style={btn(palette)}
          title="Tangent constraint (Y)"
        >
          <ToolIcon><circle cx="8" cy="6" r="4.5" /><line x1="2" y1="10.5" x2="14" y2="10.5" /></ToolIcon>
        </button>
        <button
          onClick={() => {
            const segs = resolveTwoSegments();
            if (!segs) return;
            useDocumentStore.getState().beginTransaction('Toggle bisect');
            useDocumentStore.getState().toggleBisect(segs[0]!, segs[1]!);
            requestSave();
          }}
          style={btn(palette)}
          title="Bisect constraint (B)"
        >
          <ToolIcon><line x1="2" y1="13" x2="14" y2="3" /><line x1="8" y1="2" x2="8" y2="14" strokeDasharray="2 2" /></ToolIcon>
        </button>

        <Sep color={palette.border} />

        {/* Path modifiers */}
        <button
          onClick={() => {
            const ids = useEditorStore.getState().selectedEntityIds;
            if (ids.size === 0) return;
            useDocumentStore.getState().beginTransaction('Toggle closed');
            useDocumentStore.getState().toggleClosed([...ids]);
            requestSave();
          }}
          style={btn(palette)}
          title="Close/open path (W)"
        >
          <ToolIcon><polygon points="3,12 8,3 13,12" fill="none" /><circle cx="3" cy="12" r="1.5" /><circle cx="8" cy="3" r="1.5" /><circle cx="13" cy="12" r="1.5" /></ToolIcon>
        </button>
        <button
          onClick={() => {
            const es = useEditorStore.getState();
            const selSegs = es.selectedSegments;
            if (selSegs.length > 0) {
              useDocumentStore.getState().beginTransaction('Toggle arc');
              for (const seg of selSegs) {
                useDocumentStore.getState().toggleArc(seg.entityId, seg.segmentIndex);
              }
              requestSave();
            }
          }}
          style={btn(palette)}
          title="Toggle arc on selected segments (F)"
        >
          <ToolIcon><path d="M3 12 Q8 2 13 12" fill="none" /></ToolIcon>
        </button>

        <Sep color={palette.border} />

        {/* Transforms */}
        <button
          onClick={() => {
            const ids = useEditorStore.getState().selectedEntityIds;
            if (ids.size === 0) return;
            if (activeTool !== 'select') setActiveTool('select');
            useEditorStore.getState().setMirrorEntityIds([...ids]);
          }}
          style={btn(palette)}
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
          style={btn(palette)}
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
          style={btn(palette)}
          title="Grid copy selected entities (G)"
        >
          <ToolIcon><rect x="1.5" y="1.5" width="4" height="4" /><rect x="6" y="1.5" width="4" height="4" strokeDasharray="1.5 1" /><rect x="10.5" y="1.5" width="4" height="4" strokeDasharray="1.5 1" /><rect x="1.5" y="6" width="4" height="4" strokeDasharray="1.5 1" /><rect x="1.5" y="10.5" width="4" height="4" strokeDasharray="1.5 1" /></ToolIcon>
        </button>

        <button
          onClick={() => {
            useDocumentStore.getState().centerToOrigin();
            requestSave();
          }}
          style={btn(palette)}
          title="Center sketch at origin"
        >
          <ToolIcon><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /><line x1="8" y1="2" x2="8" y2="14" strokeDasharray="2 1.5" /><line x1="2" y1="8" x2="14" y2="8" strokeDasharray="2 1.5" /><rect x="3" y="3" width="10" height="10" rx="1" strokeDasharray="2 1.5" /></ToolIcon>
        </button>

        <div style={{ flex: 1 }} />

        {/* Viewport */}
        <button
          onClick={() => useEditorStore.getState().setViewportCommand('center-origin')}
          style={btn(palette)}
          title="Center origin in viewport (Home)"
        >
          Origin
        </button>
        <button
          onClick={() => useEditorStore.getState().setViewportCommand('fit-entities')}
          style={btn(palette)}
          title="Fit all entities in viewport (Shift+F)"
        >
          Fit All
        </button>
      </div>
    </div>
  );
}
