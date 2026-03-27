import { useState, useEffect, useCallback, useRef } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { generateId } from '@/utils/id';
import type { Plane } from '@/types/part';
import type { Point } from '@/types/document';
import type { PartViewport } from '@/part/PartViewport';

type SketchTool = 'rectangle' | 'circle' | 'line' | 'construction-line' | null;

interface InlineSketchOverlayProps {
  plane: Plane;
  sketchId: string;
  viewport: PartViewport;
  onDone: () => void;
}

/** Convert a 2D point on the plane to a 3D position. */
function to3D(p: Point, plane: Plane): [number, number, number] {
  const [ox, oy, oz] = plane.origin;
  const [nx, ny, nz] = plane.normal;
  const [xx, xy, xz] = plane.xAxis;
  const yx = xy * nz - xz * ny;
  const yy = xz * nx - xx * nz;
  const yz = xx * ny - xy * nx;
  return [
    ox + p.x * xx + p.y * yx,
    oy + p.x * xy + p.y * yy,
    oz + p.x * xz + p.y * yz,
  ];
}

/** Build Float32Arrays of 3D line segments for completed entities, split by regular/construction. */
function buildEntityLines(sketchId: string, plane: Plane): { regular: Float32Array; construction: Float32Array } {
  const doc = useDocumentStore.getState().document;
  const sketch = doc.sketches.find((s) => s.id === sketchId);
  if (!sketch) return { regular: new Float32Array(0), construction: new Float32Array(0) };

  const regular: number[] = [];
  const construction: number[] = [];

  function addSeg(arr: number[], a: [number, number, number], b: [number, number, number]) {
    arr.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }

  for (const entity of sketch.entities) {
    if (entity.type === 'point' || entity.type === 'dimension') continue;

    const isConstruction = 'construction' in entity && entity.construction;
    const target = isConstruction ? construction : regular;

    if (entity.type === 'rectangle') {
      const r = entity;
      const hw = r.width / 2, hh = r.height / 2;
      const corners: Point[] = [
        { x: r.center.x - hw, y: r.center.y - hh },
        { x: r.center.x + hw, y: r.center.y - hh },
        { x: r.center.x + hw, y: r.center.y + hh },
        { x: r.center.x - hw, y: r.center.y + hh },
      ];
      for (let i = 0; i < 4; i++) {
        addSeg(target, to3D(corners[i]!, plane), to3D(corners[(i + 1) % 4]!, plane));
      }
    } else if (entity.type === 'circle') {
      const c = entity;
      const n = 32;
      for (let i = 0; i < n; i++) {
        const a1 = (i / n) * Math.PI * 2;
        const a2 = ((i + 1) / n) * Math.PI * 2;
        addSeg(
          target,
          to3D({ x: c.center.x + c.radius * Math.cos(a1), y: c.center.y + c.radius * Math.sin(a1) }, plane),
          to3D({ x: c.center.x + c.radius * Math.cos(a2), y: c.center.y + c.radius * Math.sin(a2) }, plane),
        );
      }
    } else if (entity.type === 'line') {
      const pts = entity.points;
      for (let i = 0; i < pts.length - 1; i++) {
        addSeg(target, to3D(pts[i]!, plane), to3D(pts[i + 1]!, plane));
      }
      if (entity.closed && pts.length >= 3) {
        addSeg(target, to3D(pts[pts.length - 1]!, plane), to3D(pts[0]!, plane));
      }
    }
  }

  return { regular: new Float32Array(regular), construction: new Float32Array(construction) };
}

/** Build preview line segments for the shape being drawn. */
function buildPreviewLines(
  tool: SketchTool,
  firstClick: Point | null,
  currentPos: Point | null,
  linePoints: Point[],
  plane: Plane,
): Float32Array {
  if (!tool || !currentPos) return new Float32Array(0);

  const segs: number[] = [];
  function addSeg(a: [number, number, number], b: [number, number, number]) {
    segs.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }

  if (tool === 'rectangle' && firstClick) {
    const cx = (firstClick.x + currentPos.x) / 2;
    const cy = (firstClick.y + currentPos.y) / 2;
    const hw = Math.abs(currentPos.x - firstClick.x) / 2;
    const hh = Math.abs(currentPos.y - firstClick.y) / 2;
    if (hw > 0.1 && hh > 0.1) {
      const corners: Point[] = [
        { x: cx - hw, y: cy - hh },
        { x: cx + hw, y: cy - hh },
        { x: cx + hw, y: cy + hh },
        { x: cx - hw, y: cy + hh },
      ];
      for (let i = 0; i < 4; i++) {
        addSeg(to3D(corners[i]!, plane), to3D(corners[(i + 1) % 4]!, plane));
      }
    }
  } else if (tool === 'circle' && firstClick) {
    const radius = Math.sqrt(
      (currentPos.x - firstClick.x) ** 2 + (currentPos.y - firstClick.y) ** 2,
    );
    if (radius > 0.1) {
      const n = 32;
      for (let i = 0; i < n; i++) {
        const a1 = (i / n) * Math.PI * 2;
        const a2 = ((i + 1) / n) * Math.PI * 2;
        addSeg(
          to3D({ x: firstClick.x + radius * Math.cos(a1), y: firstClick.y + radius * Math.sin(a1) }, plane),
          to3D({ x: firstClick.x + radius * Math.cos(a2), y: firstClick.y + radius * Math.sin(a2) }, plane),
        );
      }
    }
  } else if ((tool === 'line' || tool === 'construction-line') && linePoints.length > 0) {
    // Draw committed segments
    for (let i = 0; i < linePoints.length - 1; i++) {
      addSeg(to3D(linePoints[i]!, plane), to3D(linePoints[i + 1]!, plane));
    }
    // Rubber-band from last point to cursor
    addSeg(to3D(linePoints[linePoints.length - 1]!, plane), to3D(currentPos, plane));
  }

  return new Float32Array(segs);
}

export function InlineSketchOverlay({ plane, sketchId, viewport, onDone }: InlineSketchOverlayProps) {
  const palette = useThemeStore((s) => s.palette);
  const [activeTool, setActiveTool] = useState<SketchTool>('rectangle');
  const [firstClick, setFirstClick] = useState<Point | null>(null);
  const [currentPos, setCurrentPos] = useState<Point | null>(null);
  const [linePoints, setLinePoints] = useState<Point[]>([]);
  const entityCountRef = useRef(0);

  // Render completed entities + preview
  const updateDisplay = useCallback(() => {
    const { regular, construction } = buildEntityLines(sketchId, plane);
    const previewLines = buildPreviewLines(activeTool, firstClick, currentPos, linePoints, plane);
    viewport.setInlineSketchLines(regular, previewLines, construction);
  }, [sketchId, plane, viewport, activeTool, firstClick, currentPos, linePoints]);

  useEffect(() => {
    updateDisplay();
  }, [updateDisplay]);

  const commitLine = useCallback((points: Point[], isConstruction: boolean) => {
    if (points.length < 2) return;
    const store = useDocumentStore.getState();
    store.beginTransaction(isConstruction ? 'Add construction line' : 'Add line');
    store.addEntity({
      id: generateId('lin'),
      type: 'line',
      points: [...points],
      closed: false,
      construction: isConstruction,
    });
    entityCountRef.current++;
  }, []);

  // Mouse handlers on the viewport canvas
  useEffect(() => {
    const canvas = viewport.getCanvas();

    const handleMouseMove = (e: MouseEvent) => {
      const pos = viewport.projectToPlane(e.clientX, e.clientY, plane);
      if (pos) setCurrentPos(pos);
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const pos = viewport.projectToPlane(e.clientX, e.clientY, plane);
      if (!pos || !activeTool) return;

      if (activeTool === 'line' || activeTool === 'construction-line') {
        // Add point to the polyline
        setLinePoints((prev) => [...prev, pos]);
        return;
      }

      if (!firstClick) {
        setFirstClick(pos);
      } else {
        // Second click — finalize the shape
        const store = useDocumentStore.getState();

        if (activeTool === 'rectangle') {
          const cx = (firstClick.x + pos.x) / 2;
          const cy = (firstClick.y + pos.y) / 2;
          const w = Math.abs(pos.x - firstClick.x);
          const h = Math.abs(pos.y - firstClick.y);
          if (w > 0.1 && h > 0.1) {
            store.beginTransaction('Add rectangle');
            store.addEntity({
              id: generateId('rec'),
              type: 'rectangle',
              center: { x: cx, y: cy },
              width: w,
              height: h,
              anchor: 'center' as const,
            });
            entityCountRef.current++;
          }
        } else if (activeTool === 'circle') {
          const radius = Math.sqrt(
            (pos.x - firstClick.x) ** 2 + (pos.y - firstClick.y) ** 2,
          );
          if (radius > 0.1) {
            store.beginTransaction('Add circle');
            store.addEntity({
              id: generateId('cir'),
              type: 'circle',
              center: { x: firstClick.x, y: firstClick.y },
              radius,
            });
            entityCountRef.current++;
          }
        }

        setFirstClick(null);
        setCurrentPos(null);
      }
    };

    const handleDblClick = () => {
      // Double-click finishes a line/construction-line
      if (activeTool === 'line' || activeTool === 'construction-line') {
        if (linePoints.length >= 2) {
          commitLine(linePoints, activeTool === 'construction-line');
        }
        setLinePoints([]);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (activeTool === 'line' || activeTool === 'construction-line') {
          if (linePoints.length >= 2) {
            commitLine(linePoints, activeTool === 'construction-line');
          }
          setLinePoints([]);
        } else if (firstClick) {
          setFirstClick(null);
          setCurrentPos(null);
        } else {
          onDone();
        }
      } else if (e.key === 'Enter') {
        if ((activeTool === 'line' || activeTool === 'construction-line') && linePoints.length >= 2) {
          commitLine(linePoints, activeTool === 'construction-line');
          setLinePoints([]);
        }
      }
    };

    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('dblclick', handleDblClick);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('dblclick', handleDblClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [viewport, plane, activeTool, firstClick, linePoints, onDone, commitLine]);

  const switchTool = (tool: SketchTool) => {
    // Commit any in-progress line before switching
    if ((activeTool === 'line' || activeTool === 'construction-line') && linePoints.length >= 2) {
      commitLine(linePoints, activeTool === 'construction-line');
    }
    setLinePoints([]);
    setFirstClick(null);
    setActiveTool(tool);
  };

  const toolButtonStyle = (tool: SketchTool): React.CSSProperties => ({
    padding: '4px 12px',
    background: activeTool === tool ? palette.primaryBtn : palette.buttonBg,
    color: activeTool === tool ? '#fff' : palette.text,
    border: activeTool === tool ? 'none' : `1px solid ${palette.border}`,
    borderRadius: '4px',
    fontSize: '12px',
    cursor: 'pointer',
    fontWeight: activeTool === tool ? 600 : 400,
  });

  const isLineTool = activeTool === 'line' || activeTool === 'construction-line';

  return (
    <div
      style={{
        position: 'absolute',
        top: '8px',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 12px',
        background: palette.panelBg,
        border: `1px solid ${palette.border}`,
        borderRadius: '8px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
        zIndex: 10,
      }}
    >
      <span style={{ fontSize: '12px', color: palette.textSecondary, marginRight: '4px' }}>
        Sketch:
      </span>

      <button style={toolButtonStyle('rectangle')} onClick={() => switchTool('rectangle')}>
        Rectangle
      </button>
      <button style={toolButtonStyle('circle')} onClick={() => switchTool('circle')}>
        Circle
      </button>
      <button style={toolButtonStyle('line')} onClick={() => switchTool('line')}>
        Line
      </button>
      <button style={toolButtonStyle('construction-line')} onClick={() => switchTool('construction-line')}>
        Construction
      </button>

      <div style={{ width: '1px', height: '20px', background: palette.border }} />

      {isLineTool && linePoints.length > 0 && (
        <span style={{ fontSize: '11px', color: palette.accent }}>
          {linePoints.length} pts — dbl-click or Enter to finish
        </span>
      )}
      {isLineTool && linePoints.length === 0 && (
        <span style={{ fontSize: '11px', color: palette.textSecondary }}>
          Click to place points
        </span>
      )}
      {!isLineTool && firstClick && (
        <span style={{ fontSize: '11px', color: palette.accent }}>
          Click to place {activeTool}
        </span>
      )}
      {!isLineTool && !firstClick && activeTool && (
        <span style={{ fontSize: '11px', color: palette.textSecondary }}>
          Click to start {activeTool}
        </span>
      )}

      <div style={{ width: '1px', height: '20px', background: palette.border }} />

      <button
        style={{
          padding: '4px 16px',
          background: '#22c55e',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          fontSize: '12px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
        onClick={onDone}
      >
        Done
      </button>
    </div>
  );
}
