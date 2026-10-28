import { useEffect, useMemo, useState } from 'react';
import { useThemeStore } from '@/theme';
import { buildApi } from '@/api/client';
import type { XY } from '@/build/faceSketch';
import { chosenRegions, lostPicks, regionsWords, togglePick, type SketchRegion } from '@/build/regions';

// the regions of each set of loops asked for (a sketch's shapes don't change while a dialog is open)
const cache = new Map<string, Promise<{ regions: SketchRegion[]; error: string | null }>>();
function regionsOf(loops: unknown[]) {
  const key = JSON.stringify(loops);
  let p = cache.get(key);
  if (!p) {
    p = buildApi.sketchRegions(loops).catch((err) => { cache.delete(key); throw err; });
    cache.set(key, p);
  }
  return p;
}

/** The regions of a sketch's closed shapes (`loops`), once read (null till then). */
export function useSketchRegions(loops: unknown[] | null): SketchRegion[] | null {
  const key = loops ? JSON.stringify(loops) : '';
  const [got, setGot] = useState<{ key: string; regions: SketchRegion[] } | null>(null);
  useEffect(() => {
    if (!loops || !loops.length) return;
    let gone = false;
    regionsOf(loops).then((r) => { if (!gone) setGot({ key, regions: r.regions }); }, () => {});
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return got && got.key === key ? got.regions : null;
}

/** Click the regions of the sketch to take or leave out: taken regions are
 *  filled, the others hatched. Shown when the sketch has more than one
 *  region (or a pick is stored). `value` null: the default regions. */
export function RegionPicker({ regions, value, onChange, width = 206, height = 120 }: {
  regions: SketchRegion[] | null;
  value: XY[] | null | undefined;
  onChange: (v: XY[] | null) => void;
  width?: number;
  height?: number;
}) {
  const palette = useThemeStore((s) => s.palette);
  const [hover, setHover] = useState(-1);
  const box = useMemo(() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of regions ?? []) for (const t of r.tris) for (const [x, y] of t) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (!Number.isFinite(x0)) return null;
    const pad = Math.max(x1 - x0, y1 - y0, 1) * 0.06;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  }, [regions]);
  if (!regions || !box || (regions.length < 2 && !value)) return null;
  const on = chosenRegions(regions, value);
  const lost = lostPicks(regions, value);
  const mark = Math.max(box.w, box.h) * 0.03;
  const pts = (p: XY[]) => p.map(([x, y]) => `${x},${y}`).join(' ');
  // a region's triangles as one path, so their shared sides don't show
  const area = (r: SketchRegion) => r.tris.map((t) => `M${pts(t)}Z`).join('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', color: palette.text }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
        <span style={{ flex: 1 }}>Regions: <b>{regionsWords(regions, value)}</b></span>
        {value && (
          <button onClick={() => onChange(null)} title="Take the default regions again: every shape, holes left open"
                  style={{ fontSize: '11px', padding: '0 6px', cursor: 'pointer', borderRadius: '3px',
                           background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.border}` }}>
            Default
          </button>
        )}
      </div>
      <svg role="group" aria-label="Sketch regions" width={width} height={height}
           viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet"
           style={{ background: palette.inputBg, border: `1px solid ${palette.border}`, borderRadius: '4px' }}
           onMouseLeave={() => setHover(-1)}>
        <defs>
          <pattern id="region-hatch" width={mark * 1.6} height={mark * 1.6} patternUnits="userSpaceOnUse"
                   patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={mark * 1.6} stroke={palette.textSecondary} strokeWidth={mark * 0.25} opacity={0.5} />
          </pattern>
        </defs>
        {regions.map((r, i) => (
          <g key={i} role="checkbox" aria-checked={on[i]} aria-label={`Region ${i + 1}`} style={{ cursor: 'pointer' }}
             onMouseEnter={() => setHover(i)} onClick={() => onChange(togglePick(regions, value, i))}>
            <title>{on[i] ? 'Taken: click to leave it out' : 'Left out: click to take it'}</title>
            <path d={area(r)} fill={on[i] ? palette.accent : 'url(#region-hatch)'}
                  fillOpacity={on[i] ? (hover === i ? 0.75 : 0.55) : 1} />
            {hover === i && !on[i] && <path d={area(r)} fill={palette.accent} fillOpacity={0.18} />}
          </g>
        ))}
        {regions.map((r, i) => r.edges.map((e, j) => (
          <polyline key={`${i}-${j}`} points={pts(e)} fill="none" pointerEvents="none"
                    stroke={on[i] ? palette.accent : palette.textSecondary} strokeWidth={on[i] ? 2 : 1}
                    strokeDasharray={on[i] ? undefined : '3 2'} vectorEffect="non-scaling-stroke" />
        )))}
        {lost.map(([x, y], i) => (
          <g key={`lost${i}`} stroke={palette.danger} strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none">
            <line x1={x - mark} y1={y - mark} x2={x + mark} y2={y + mark} vectorEffect="non-scaling-stroke" />
            <line x1={x - mark} y1={y + mark} x2={x + mark} y2={y - mark} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </svg>
      {lost.length > 0 ? (
        <div style={{ color: palette.danger, lineHeight: 1.35 }}>
          {lost.length > 1 ? `${lost.length} regions` : 'A region'} picked for this step {lost.length > 1 ? 'are' : 'is'} gone
          after the sketch changed: click the regions to use.
        </div>
      ) : (
        <div style={{ color: palette.textSecondary, lineHeight: 1.35 }}>
          Click a region to take it or leave it out.
        </div>
      )}
    </div>
  );
}
