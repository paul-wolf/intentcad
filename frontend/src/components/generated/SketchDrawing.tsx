/**
 * A generated sketch's drawing: its outputs, the code's labels and
 * dimensions, on a grid. Hovering an element names its output (and the
 * parts that use it) and lights the output up, as hovering its row on the
 * right does. Wheel zooms, dragging the background pans.
 *
 * The drawing comes from code, so it can't be edited here: dragging an
 * element, double-clicking one or pressing Delete says so for a few seconds.
 * While the code fails (or a value is tried it can't handle) the last good
 * drawing stays, dimmed. A failing check shows on the drawing too: its output
 * in red, and its message at the top left (clicking it picks the output), so
 * a value only a check reads, such as a bed size, still visibly does something.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useThemeStore } from '@/theme';
import type { Entity as SketchEntity } from '@/types/document';
import type { GenAnnotations, GenCheck, GenOutput } from '@/types/generated';
import type { UsedByPart } from '@/api/client';
import { boundsOf, fitView, hoverWords, linePath, outputOf, toScreen, toSketch, type View } from '@/build/generatedSketch';

export const READ_ONLY_HINT = 'This drawing comes from code. Change a parameter on the right, or ask the AI below.';

export function SketchDrawing({ entities, notes, outputs, checks = [], users, lit, onHover, onPick, dimmed, fitKey, hint,
                                onEditAttempt, interactive = true, children }: {
  entities: SketchEntity[];
  notes: GenAnnotations | null;
  outputs: GenOutput[];
  /** failing ones show on the drawing */
  checks?: GenCheck[];
  users: UsedByPart[];
  /** the outputs shown lit (hovered, or picked on the right) */
  lit: ReadonlySet<string>;
  onHover?: (output: string | null) => void;
  onPick?: (output: string | null) => void;
  dimmed?: boolean;
  /** a change fits the drawing to the window again */
  fitKey?: unknown;
  /** the read-only hint is showing */
  hint?: boolean;
  onEditAttempt?: () => void;
  /** false: a still picture (no hover, pan or zoom) */
  interactive?: boolean;
  children?: ReactNode;
}) {
  const palette = useThemeStore((s) => s.palette);
  const box = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const drag = useRef<{ x: number; y: number; view: View; onShape: boolean; moved: boolean } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bounds = useMemo(() => boundsOf(entities, notes), [entities, notes]);
  const hasBounds = !!bounds;
  // fit when the window first has a size and something to show, and on fitKey
  useEffect(() => {
    if (!size.w || !size.h || !hasBounds) return;
    setView(fitView(bounds, size.w, size.h, interactive ? 56 : 8));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w > 0 && size.h > 0, hasBounds, fitKey]);
  // a resize keeps the middle and the scale
  useEffect(() => {
    setView((v) => (v && size.w && size.h ? { ...v, width: size.w, height: size.h } : v));
  }, [size.w, size.h]);

  const byName = useMemo(() => new Map(outputs.map((o) => [o.name, o])), [outputs]);
  const failing = interactive ? checks.filter((c) => !c.ok) : [];
  const failed = new Set(failing.map((c) => c.output).filter((o): o is string => !!o));
  const v = view && size.w ? { ...view, width: size.w, height: size.h } : null;

  const wheel = (e: React.WheelEvent) => {
    if (!interactive || !v) return;
    const r = box.current!.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [x, y] = toSketch(v, sx, sy);
    const scale = Math.min(1000, Math.max(0.01, v.scale * Math.exp(-e.deltaY * 0.0015)));
    // keep the point under the pointer where it is
    setView({ ...v, scale, cx: x - (sx - v.width / 2) / scale, cy: y - (sy - v.height / 2) / scale });
  };
  const down = (e: React.PointerEvent) => {
    if (!interactive || !v || e.button !== 0) return;
    const onShape = !!(e.target as Element).closest?.('[data-output]');
    drag.current = { x: e.clientX, y: e.clientY, view: v, onShape, moved: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved && d.onShape) onEditAttempt?.();
    d.moved = true;
    if (!d.onShape) setView({ ...d.view, cx: d.view.cx - dx / d.view.scale, cy: d.view.cy - dy / d.view.scale });
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    // a click: an element picks its output, the background drops the pick
    const el = (e.target as Element).closest?.('[data-output]');
    onPick?.(el ? el.getAttribute('data-output') : null);
  };

  const grid = v ? gridLines(v, palette.gridMinor, palette.gridMajor) : null;
  const shapes: ReactNode[] = [];
  if (v) {
    // lit outputs on top, then those a check fails on
    const rank = (e: SketchEntity) => { const o = outputOf(e.id) ?? ''; return lit.has(o) ? 2 : failed.has(o) ? 1 : 0; };
    const order = [...entities].sort((a, b) => rank(a) - rank(b));
    for (const e of order) {
      const out = outputOf(e.id) ?? '';
      const on = lit.has(out);
      const stroke = on ? palette.accent : failed.has(out) ? palette.danger : palette.line;
      const fill = on ? palette.accent : 'none';
      const common = {
        'data-output': out,
        onMouseEnter: interactive ? () => onHover?.(out) : undefined,
        onMouseLeave: interactive ? () => { onHover?.(null); setTip(null); } : undefined,
        onMouseMove: interactive ? (ev: React.MouseEvent) => {
          const o = byName.get(out);
          const r = box.current!.getBoundingClientRect();
          if (o) setTip({ x: ev.clientX - r.left, y: ev.clientY - r.top, text: hoverWords(o, users) });
        } : undefined,
        onDoubleClick: interactive ? () => onEditAttempt?.() : undefined,
        style: { cursor: interactive ? 'pointer' : 'default' },
      };
      const width = interactive ? (on ? 2.4 : 1.4) : 1;
      if (e.type === 'circle') {
        const [x, y] = toScreen(v, e.center.x, e.center.y);
        const r = Math.max(e.radius * v.scale, 0.8);
        shapes.push(
          <g key={e.id} {...common}>
            {interactive && <circle cx={x} cy={y} r={r} fill="transparent" stroke="transparent" strokeWidth={10} />}
            <circle cx={x} cy={y} r={r} stroke={stroke} strokeWidth={width} fill={fill} fillOpacity={on ? 0.15 : 0} />
          </g>,
        );
      } else if (e.type === 'line') {
        const d = linePath(e, v);
        const closed = !!e.closed;
        shapes.push(
          <g key={e.id} {...common}>
            {interactive && <path d={d} fill="none" stroke="transparent" strokeWidth={10} />}
            <path d={d} stroke={stroke} strokeWidth={width} strokeLinejoin="round"
              fill={closed ? fill : 'none'} fillOpacity={on && closed ? 0.1 : 0} />
          </g>,
        );
      } else if (e.type === 'point') {
        const [x, y] = toScreen(v, e.position.x, e.position.y);
        shapes.push(
          <g key={e.id} {...common} stroke={stroke} strokeWidth={width}>
            {interactive && <circle cx={x} cy={y} r={7} fill="transparent" stroke="none" />}
            <path d={`M${x - 4} ${y}H${x + 4}M${x} ${y - 4}V${y + 4}`} />
          </g>,
        );
      }
    }
  }

  const halo = { paintOrder: 'stroke' as const, stroke: palette.background, strokeWidth: 3, strokeLinejoin: 'round' as const };
  const annotations: ReactNode[] = [];
  if (v && notes && interactive) {
    notes.dims.forEach((d, i) => {
      const [x1, y1] = toScreen(v, d.p1[0], d.p1[1]);
      const [x2, y2] = toScreen(v, d.p2[0], d.p2[1]);
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1) return;
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const arrow = (x: number, y: number, s: number) =>
        `M${x} ${y}L${x + s * (8 * ux - 3 * uy)} ${y + s * (8 * uy + 3 * ux)}L${x + s * (8 * ux + 3 * uy)} ${y + s * (8 * uy - 3 * ux)}Z`;
      let a = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      if (a > 90) a -= 180;
      if (a < -90) a += 180;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      annotations.push(
        <g key={`d${i}`} stroke={palette.dimension} fill={palette.dimension}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={1} />
          <path d={arrow(x1, y1, 1)} stroke="none" />
          <path d={arrow(x2, y2, -1)} stroke="none" />
          <text x={mx} y={my - 5} textAnchor="middle" fontSize={11.5} fill={palette.dimensionText}
            transform={`rotate(${a} ${mx} ${my})`} style={halo}>{d.text}</text>
        </g>,
      );
    });
    notes.labels.forEach((l, i) => {
      const [x, y] = toScreen(v, l.at[0], l.at[1]);
      annotations.push(
        <text key={`l${i}`} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize={11.5}
          fill={palette.textSecondary} style={halo}>{l.text}</text>,
      );
    });
  }

  return (
    <div ref={box} tabIndex={interactive ? 0 : undefined} aria-label={interactive ? 'Drawing' : undefined}
      onWheel={wheel} onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onKeyDown={(e) => { if (e.key === 'Delete' || e.key === 'Backspace') onEditAttempt?.(); }}
      style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', background: palette.background,
               outline: 'none', touchAction: 'none', cursor: drag.current && !drag.current.onShape ? 'grabbing' : 'default' }}>
      <svg width={size.w} height={size.h} style={{ display: 'block', position: 'absolute', inset: 0 }}>
        {grid}
        <g style={{ opacity: dimmed ? 0.35 : 1, transition: 'opacity .15s' }}>
          {shapes}
          {annotations}
        </g>
      </svg>
      {tip && interactive && (
        <div style={{ position: 'absolute', left: Math.min(tip.x + 14, size.w - 260), top: tip.y + 16, maxWidth: 260,
                      pointerEvents: 'none', background: palette.panelBg, color: palette.text, border: `1px solid ${palette.border}`,
                      borderRadius: 6, padding: '4px 8px', fontSize: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.2)', zIndex: 4 }}>
          {tip.text}
        </div>
      )}
      {hint && (
        <div role="status" style={{ position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 5,
                                    background: palette.panelBg, color: palette.text, border: `1px solid ${palette.accent}`,
                                    borderRadius: 8, padding: '7px 12px', fontSize: '12.5px', boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
                                    maxWidth: 'calc(100% - 32px)' }}>
          {READ_ONLY_HINT}
        </div>
      )}
      {failing.length > 0 && (
        <div role="status" style={{ position: 'absolute', left: 12, top: 12, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 2,
                                    maxWidth: 'calc(100% - 24px)', background: palette.panelBg, border: `1px solid ${palette.danger}`,
                                    borderRadius: 6, padding: '5px 10px', fontSize: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.2)' }}>
          {failing.map((c, i) => (
            <div key={`${c.name}-${i}`} onPointerDown={(e) => e.stopPropagation()}
              onClick={() => c.output && onPick?.(lit.has(c.output) ? null : c.output)}
              title={c.output ? `Click to show ${c.output}` : undefined}
              style={{ color: palette.danger, cursor: c.output ? 'pointer' : 'default' }}>
              ✗ {c.name}{c.message ? `: ${c.message}` : ''}
            </div>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

/** A grid every 1, 2, 5, 10… mm (at least 14 px apart), every fifth line
 *  stronger, and the axes through the origin. */
function gridLines(v: View, minor: string, major: string): ReactNode {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const step = steps.find((s) => s * v.scale >= 14) ?? 1000;
  const [x0, y0] = toSketch(v, 0, 0);
  const [x1, y1] = toSketch(v, v.width, v.height);
  const lines: ReactNode[] = [];
  for (let i = Math.ceil(x0 / step); i * step <= x1; i++) {
    const [sx] = toScreen(v, i * step, 0);
    lines.push(<line key={`x${i}`} x1={sx} y1={0} x2={sx} y2={v.height} stroke={i === 0 ? major : i % 5 ? minor : major}
      strokeWidth={i === 0 ? 1.5 : 1} />);
  }
  for (let i = Math.ceil(y0 / step); i * step <= y1; i++) {
    const [, sy] = toScreen(v, 0, i * step);
    lines.push(<line key={`y${i}`} x1={0} y1={sy} x2={v.width} y2={sy} stroke={i === 0 ? major : i % 5 ? minor : major}
      strokeWidth={i === 0 ? 1.5 : 1} />);
  }
  return <g>{lines}</g>;
}
