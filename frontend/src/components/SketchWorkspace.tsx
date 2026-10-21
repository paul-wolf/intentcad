import { useMemo, useEffect, useState, type ReactNode } from 'react';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { RightPanel } from './RightPanel';
import { LogPanel } from './LogPanel';
import { HistoryPanel } from './HistoryPanel';
import { DocumentPropertiesPanel } from './DocumentPropertiesPanel';
import { HelpModal } from './HelpModal';
import { CanvasContainer, type SketchViewportController } from '@/canvas/CanvasContainer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useBuildStore } from '@/stores/buildStore';
import { createLineTool } from '@/tools/lineTool';
import { createSelectTool } from '@/tools/selectTool';
import { createCircleTool } from '@/tools/circleTool';
import { createRectangleTool } from '@/tools/rectangleTool';
import { createPolygonTool } from '@/tools/polygonTool';
import { createPointTool } from '@/tools/pointTool';
import { createDimensionTool } from '@/tools/dimensionTool';
import { createRect2ptTool } from '@/tools/rect2ptTool';
import { createAxisRectTool } from '@/tools/axisRectTool';
import { createBezierTool } from '@/tools/bezierTool';
import { createFilletTool } from '@/tools/filletTool';
import { createTrimTool } from '@/tools/trimTool';
import type { Tool } from '@/tools/types';
import type { ToolType } from '@/types/editor';

export type { SketchViewportController };

interface SketchWorkspaceProps {
  docId?: string;
  /** Use this tool instead of the editor's active tool (CAM forces 'select'). */
  toolOverride?: ToolType;
  /** See-through drawing area: no background fill, so whatever is behind shows. */
  transparent?: boolean;
  /** Draw the grid (default true). */
  grid?: boolean;
  /** Don't ghost the document's other visible sketches. */
  soloActiveSketch?: boolean;
  /** External viewport control (start position, per-frame callback). */
  viewport?: SketchViewportController;
  /** 'all': every sketch shortcut. 'viewport': only Home / Shift+F (e.g. in CAM mode). */
  keys?: 'all' | 'viewport';
  /** Keep the keyboard even while the 3D Build panel is open (when hosted inside it). */
  ownsKeyboard?: boolean;
  /** Replace the default panels (CAM swaps them). */
  toolbar?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  /** Extra content inside the drawing row, over the canvas. */
  overlay?: ReactNode;
}

function createTool(type: ToolType): Tool {
  switch (type) {
    case 'line':
      return createLineTool();
    case 'point':
      return createPointTool();
    case 'circle':
      return createCircleTool();
    case 'rectangle':
      return createRectangleTool();
    case 'rect2pt':
      return createRect2ptTool();
    case 'axisrect':
      return createAxisRectTool();
    case 'polygon':
      return createPolygonTool();
    case 'select':
      return createSelectTool();
    case 'dimension':
      return createDimensionTool();
    case 'bezier':
      return createBezierTool();
    case 'fillet':
      return createFilletTool();
    case 'trim':
      return createTrimTool();
  }
}

/**
 * The 2D sketcher: toolbar, history and property panels, the drawing canvas
 * with dimension editing and dialogs, the tool factory and the keyboard
 * shortcuts. EditorPage hosts it full-page; it can also be mounted over
 * another view (transparent, externally driven viewport).
 */
export function SketchWorkspace({
  docId,
  toolOverride,
  transparent,
  grid,
  soloActiveSketch,
  viewport,
  keys = 'all',
  ownsKeyboard = false,
  toolbar,
  left,
  right,
  overlay,
}: SketchWorkspaceProps) {
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const [showHelp, setShowHelp] = useState(false);

  const effectiveTool = toolOverride ?? activeTool;
  const toolInstance: Tool = useMemo(() => createTool(effectiveTool), [effectiveTool]);

  // Keyboard shortcuts for tool switching
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      // The 3D Build panel owns the keyboard while open (don't undo the sketch, etc.)
      if (!ownsKeyboard && useBuildStore.getState().panelOpen) return;

      const ctrl = e.ctrlKey || e.metaKey;

      // Viewport shortcuts work in both modes
      if (e.key === 'Home') {
        e.preventDefault();
        useEditorStore.getState().setViewportCommand('center-origin');
        return;
      }
      if (e.key === 'F' && e.shiftKey) {
        useEditorStore.getState().setViewportCommand('fit-entities');
        return;
      }
      if (keys === 'viewport') return;

      // with Cmd held, a Mac reports Shift+Z as 'z'
      const z = e.key.toLowerCase() === 'z';
      if (ctrl && z && !e.shiftKey) {
        e.preventDefault();
        useDocumentStore.getState().undo();
        return;
      }
      if (ctrl && ((z && e.shiftKey) || e.key === 'y')) {
        e.preventDefault();
        useDocumentStore.getState().redo();
        return;
      }

      if (e.key === '.') setActiveTool('point');
      if (e.key === 'l' || e.key === 'L') setActiveTool('line');
      if (e.key === 'c' || e.key === 'C') setActiveTool('circle');
      if (e.key === 'r') setActiveTool('rectangle');
      if (e.key === 'R') setActiveTool('rect2pt');
      if (e.key === 'e' || e.key === 'E') setActiveTool('axisrect');
      if (e.key === 'p' || e.key === 'P') setActiveTool('polygon');
      if (e.key === 'd' || e.key === 'D') setActiveTool('dimension');
      if (e.key === 's' || e.key === 'S') setActiveTool('bezier');
      if (e.key === '(') setActiveTool('fillet');
      if (e.key === '-') setActiveTool('trim');
      if (e.key === '?') setShowHelp((v) => !v);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setActiveTool, keys, ownsKeyboard]);

  return (
    <div style={styles.container}>
      {toolbar ?? <Toolbar />}
      <div style={styles.middle}>
        {left ?? <HistoryPanel />}
        <CanvasContainer
          activeTool={toolInstance}
          docId={docId}
          transparent={transparent}
          grid={grid}
          soloActiveSketch={soloActiveSketch}
          viewport={viewport}
        />
        {overlay}
        {right ?? <><DocumentPropertiesPanel /><RightPanel /></>}
      </div>
      <LogPanel />
      <StatusBar />
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  } as React.CSSProperties,
  middle: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  } as React.CSSProperties,
};
