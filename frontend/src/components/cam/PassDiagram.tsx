import type { ResolvedOp } from '@/cam/resolve';
import { useTokens, MONO, fmt } from './ui';
import { passDepths } from './opText';

/** The cut seen from the side: the stock, each pass, tabs, and how far it goes into the spoilboard. */
export function PassDiagram({ r, thickness, allowance }: { r: ResolvedOp; thickness: number; allowance: number }) {
  const t = useTokens();
  const f = r.fields;
  const depth = f.depth.value;
  const drilling = r.op.kind === 'drill' && f.holeMethod.value === 'drill';
  const passes = drilling ? [depth] : passDepths(r);
  const W = 420, H = 128, top = 18, left = 40, right = 14;
  const span = Math.max(thickness, depth) + Math.max(allowance, 0.5) + 1;
  const k = (H - top - 18) / span;
  const y = (d: number) => top + d * k;
  const stockW = W - left - right;
  const cutX0 = left + stockW * 0.32, cutX1 = left + stockW * 0.68;
  const tabs = r.op.kind === 'profile' && f.tabs.value;
  const tabTop = depth - f.tabHeight.value;
  const through = depth > thickness + 1e-9;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', margin: '6px 0 2px', background: t.surface2, borderRadius: 8, border: `1px solid ${t.border}` }}>
      {/* spoilboard */}
      <rect x={left} y={y(thickness)} width={stockW} height={H - y(thickness) - 4} fill={t.surface3} />
      <text x={left + stockW - 4} y={H - 8} textAnchor="end" fontSize={9.5} fill={t.textMute}>spoilboard</text>
      {/* stock */}
      <rect x={left} y={y(0)} width={stockW} height={thickness * k} fill={t.partSoft} stroke={t.part} strokeWidth={1} />
      <text x={left + 4} y={y(0) + 11} fontSize={9.5} fill={t.part}>stock {fmt(thickness)} mm</text>
      {/* the cut */}
      <rect x={cutX0} y={y(0)} width={cutX1 - cutX0} height={depth * k} fill={t.surface} stroke="none" />
      {passes.map((d, i) => (
        <g key={i}>
          <line x1={cutX0} x2={cutX1} y1={y(d)} y2={y(d)} stroke="#ff8c00" strokeWidth={1.4} strokeDasharray={i === passes.length - 1 ? undefined : '3 2'} />
          {passes.length <= 12 && <text x={cutX1 + 5} y={y(d) + 3} fontSize={9} fontFamily={MONO} fill={t.textDim}>{fmt(d)}</text>}
        </g>
      ))}
      {tabs && tabTop > 0 && (
        <g>
          <rect x={(cutX0 + cutX1) / 2 - 14} y={y(tabTop)} width={28} height={(depth - tabTop) * k} fill={t.part} opacity={0.55} />
          <text x={(cutX0 + cutX1) / 2} y={y(tabTop) - 3} textAnchor="middle" fontSize={9} fill={t.part}>tab {fmt(f.tabHeight.value)}</text>
        </g>
      )}
      {through && (
        <text x={cutX0 - 5} y={y(depth) + 3} textAnchor="end" fontSize={9} fill={t.textDim}>{fmt(depth - thickness)} into the spoilboard</text>
      )}
      {/* depth scale */}
      <line x1={left - 10} x2={left - 10} y1={y(0)} y2={y(depth)} stroke={t.textMute} strokeWidth={1} />
      <text x={left - 13} y={(y(0) + y(depth)) / 2 + 3} textAnchor="end" fontSize={9} fontFamily={MONO} fill={t.textDim}>{fmt(depth)}</text>
      <text x={W / 2} y={11} textAnchor="middle" fontSize={9.5} fill={t.textMute}>
        {drilling ? 'one hole' : `${passes.length} pass${passes.length === 1 ? '' : 'es'}`} · side view
      </text>
    </svg>
  );
}
