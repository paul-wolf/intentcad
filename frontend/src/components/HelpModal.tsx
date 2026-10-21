import { useThemeStore } from '@/theme';

interface HelpModalProps {
  onClose: () => void;
}

const SECTIONS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Drawing Tools',
    items: [
      ['L', 'Line'],
      ['C', 'Circle'],
      ['R', 'Rectangle (center)'],
      ['Shift + R', 'Rectangle (2-point)'],
      ['P', 'Polygon'],
      ['S', 'Bezier / Spline'],
      ['.', 'Point'],
      ['D', 'Dimension'],
      ['Esc', 'Select tool / Cancel'],
    ],
  },
  {
    title: 'Constraints',
    items: [
      ['K', 'Fix in place'],
      ['=', 'Equal'],
      ['J', 'Coincident (join points)'],
      ['H', 'Horizontal: a line or segment, or two points level (Shift-click two points, or two circles / points)'],
      ['V', 'Vertical: a line or segment, or two points one above the other'],
      ['I', 'Midpoint'],
      ['@', 'Point on curve: a point on a line (extended), an arc or a circle (select the point, Shift-click the curve)'],
      ['/', 'Symmetric: two points mirrored about a line (select the two points, Shift-click the line)'],
      ['N', 'Parallel'],
      ['T', 'Perpendicular'],
      ['Y', 'Tangent'],
      ['B', 'Bisect'],
    ],
  },
  {
    title: 'Modify',
    items: [
      ['(', 'Fillet: click a corner (Shift adds) or drag a box over several, then type the radius and Enter, or drag out from a corner. Too large: clamped to the largest that fits. The radius is a dimension'],
      ['-', 'Trim: hover a curve to see the piece between its neighbouring crossings, click to remove it, or drag across several. Circles become arcs; constraints that no longer apply are dropped (the log says how many)'],
      ['O', 'Offset: click a closed shape, a circle or a chain of lines (Shift adds; a selection made first is used), then drag out to the side you want or type the distance (P allowed) and Enter. Outside / Inside (or Flip side), Arcs / Miters for sharp corners. The offset follows its source and its distance is a dimension; Unlink in the properties makes it independent'],
      [';', 'Project edges (sketching on a part): click an edge of the part to add it to the sketch as reference geometry, flattened onto the sketch plane; dotted lines show the edges you can pick, including those behind the face. It follows the part when the part changes (kept, marked broken, if its edge goes)'],
      ['W', 'Close / open path'],
      ['F', 'Toggle arc on segment'],
      ['M', 'Mirror selection'],
      ['A', 'Circular copy (on one already made: edit it)'],
      ['G', 'Grid copy (on one already made: edit it)'],
      ['Pattern panel', 'Select a copy or its original: edit or delete its copies'],
      ['Q', 'Copy selected entities JSON'],
      ['Shift + Q', 'Copy document JSON'],
      ['Shift + V', 'Paste document JSON (replaces entire document)'],
    ],
  },
  {
    title: 'General',
    items: [
      ['Ctrl + Z', 'Undo'],
      ['Ctrl + Shift + Z', 'Redo (also Ctrl + Y)'],
      ['History panel', 'Click a step to go back to just after it; Start: before any'],
      ['Home', 'Center on origin'],
      ['Axes button', "Hide/show the sketch's axes: H and V lines through the origin (on a face sketch the world origin projected onto the face) and a face's own centre lines. Click one to use it as a mirror line (M), for symmetric, point on line or a dimension; the cursor snaps onto them. Constraints on them keep working when hidden"],
      ['Shift + F', 'Fit all entities'],
      ['Alt (hold)', 'Show all dimensions / free draw (no snap)'],
      ['?', 'This help'],
    ],
  },
];

export function HelpModal({ onClose }: HelpModalProps) {
  const palette = useThemeStore((s) => s.palette);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
      }}
      data-modal
      onClick={onClose}
    >
      <div
        style={{
          background: palette.panelBg,
          border: `1px solid ${palette.border}`,
          borderRadius: '8px',
          padding: '20px 28px',
          maxWidth: '600px',
          width: '90%',
          maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0, fontSize: '16px', color: palette.text }}>Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: palette.textSecondary,
              fontSize: '18px',
              cursor: 'pointer',
              padding: '0 4px',
            }}
          >
            &times;
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: palette.accent, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {section.title}
              </div>
              {section.items.map(([key, desc]) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                  <kbd style={{
                    display: 'inline-block',
                    minWidth: '28px',
                    padding: '1px 6px',
                    background: palette.inputBg,
                    border: `1px solid ${palette.border}`,
                    borderRadius: '3px',
                    fontSize: '11px',
                    fontFamily: 'monospace',
                    color: palette.text,
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                  }}>
                    {key}
                  </kbd>
                  <span style={{ fontSize: '12px', color: palette.textSecondary }}>{desc}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
