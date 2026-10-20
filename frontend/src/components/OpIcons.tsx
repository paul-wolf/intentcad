/**
 * The operations' icons (build/operations.ts names them): inline SVG on a
 * 24 grid, strokes 1.5 px on screen whatever the size, in currentColor,
 * drawn to read at 20 px.
 */
import type { ReactNode } from 'react';
import type { OpIcon as OpIconName } from '@/build/operations';
import type { StandardView } from '@/build/viewOrient';

// an oblique cube: the front square, and the back one up and to the right
const CUBE_FACES: Record<Exclude<StandardView, 'iso'>, string> = {
  front: '4,9 14,9 14,19 4,19',
  top: '4,9 9,4 19,4 14,9',
  right: '14,9 19,4 19,14 14,19',
  back: '9,4 19,4 19,14 9,14',
  left: '4,9 9,4 9,14 4,19',
  bottom: '4,19 9,14 19,14 14,19',
};

function cube(view: StandardView): ReactNode {
  const hidden = view === 'back' || view === 'left' || view === 'bottom';
  return (
    <>
      {view !== 'iso' && <polygon points={CUBE_FACES[view]} fill="currentColor" fillOpacity={0.3} stroke="none" />}
      <path d="M4 9h10v10H4zM4 9l5-5h10l-5 5M19 4v10l-5 5" />
      {(hidden || view === 'iso') && <path d="M9 4v10h10M9 14l-5 5" strokeDasharray={view === 'iso' ? '1.5 1.5' : undefined}
                                           opacity={view === 'iso' ? 0.6 : 1} />}
    </>
  );
}

const ICONS: Record<OpIconName, ReactNode> = {
  'sketch-face': <><path d="M2 19l5-6h15l-5 6z" /><path d="M14 3l3 3-6 6H8V9z" /></>,
  'plane-top': <><path d="M2 17l6-6h14l-6 6z" /><circle cx="12" cy="14" r="1" fill="currentColor" /></>,
  'plane-front': <><path d="M6 4h12v16H6z" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>,
  'plane-right': <><path d="M8 3l8 5v13l-8-5z" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>,
  extrude: <><path d="M3 19l4-4h14l-4 4z" /><path d="M12 15V4M8.5 7.5L12 4l3.5 3.5" /></>,
  hole: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" /></>,
  shell: <><path d="M3 6v14h18V6" /><path d="M7 6v10h10V6" /></>,
  fillet: <><path d="M4 20h16V11a7 7 0 0 0-7-7H4z" opacity={0.5} /><path d="M13 4a7 7 0 0 1 7 7" strokeWidth={2.4} /></>,
  chamfer: <><path d="M4 20h16V10l-6-6H4z" opacity={0.5} /><path d="M14 4l6 6" strokeWidth={2.4} /></>,
  round: <><path d="M4 21v-9a8 8 0 0 1 8-8h9" /><path d="M4 4h3M4 4v3" opacity={0.5} /></>,
  lighten: <><path d="M3 5h18v14H3z" /><path d="M3 19l6-14 6 14 6-14" /></>,
  protect: <><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" /><path d="M9 12h6" /></>,
  fix: <path d="M15 4a4.5 4.5 0 0 0-4.5 6L4 16.5 7.5 20l6.5-6.5A4.5 4.5 0 0 0 20 9l-3 3-3-1-1-3z" />,
  measure: <><path d="M3 16L16 3l5 5L8 21z" /><path d="M7 12l2 2M10 9l2 2M13 6l2 2" /></>,
  // a block cut open: the cut face hatched, the plane beyond it
  section: <><path d="M4 9l5-5h11v11l-5 5H4z" opacity={0.5} /><path d="M4 9h11v11H4z" /><path d="M15 9l5-5" opacity={0.5} />
    <path d="M4 13l4-4M4 17l8-8M7 20l8-8M11 20l4-4" strokeWidth={1.1} /></>,
  normal: <><path d="M5 3v18" /><path d="M21 12H9M12.5 8.5L9 12l3.5 3.5" /></>,
  ortho: <><path d="M5 4h14M5 20h14" /><path d="M5 4v16M19 4v16" strokeDasharray="2 2" /></>,
  params: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2.2" fill="var(--op-icon-bg, none)" /><circle cx="15" cy="17" r="2.2" fill="var(--op-icon-bg, none)" /></>,
  build: <path d="M7 4l12 8-12 8z" />,
  import: <><path d="M12 3v12M7.5 10.5L12 15l4.5-4.5" /><path d="M4 16v4h16v-4" /></>,
  export: <><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5" /><path d="M4 16v4h16v-4" /></>,
  stl: <><path d="M12 3l9 16H3z" /><path d="M7.5 11h9M12 19l-4.5-8M12 19l4.5-8" /></>,
  parts: <><path d="M3 11h8v9H3zM13 4h8v9h-8z" /><path d="M13 17h8M17 13v8" opacity={0.6} /></>,
  dxf: <><path d="M5 3h10l4 4v14H5z" /><path d="M15 3v4h4" /><path d="M8 16l3-5 3 3 2-3" /></>,
  views3: <><path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3z" /></>,
  versions: <><path d="M4 12a8 8 0 1 0 2.5-5.8" /><path d="M4 4v4h4" /><path d="M12 8v4l3 2" /></>,
  process: <><path d="M8 3h8v6l-4 4-4-4z" /><path d="M12 13v3M4 20h16" /></>,
  // a page with a paper clip: a reference file
  context: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M10 11v5a1.5 1.5 0 0 0 3 0v-6" /></>,
  'view-front': cube('front'),
  'view-back': cube('back'),
  'view-left': cube('left'),
  'view-right': cube('right'),
  'view-top': cube('top'),
  'view-bottom': cube('bottom'),
  'view-iso': cube('iso'),
};

/** The Operations layout's own icon: a grid of four. */
export const OPS_GRID_ICON: ReactNode = <path d="M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z" />;

export function OpIcon({ name, size = 20, children }: { name?: OpIconName; size?: number; children?: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={(1.5 * 24) / size}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, display: 'block' }}>
      {name ? ICONS[name] : children}
    </svg>
  );
}
