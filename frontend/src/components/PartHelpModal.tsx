import { useEffect } from 'react';
import { useThemeStore } from '@/theme';

interface PartHelpModalProps {
  onClose: () => void;
}

// What each control in the part editor does. Toolbar tooltips stay one line;
// the detail lives here.
const SECTIONS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Change the part',
    items: [
      ['Describe a change', 'Type what you want in the box at the bottom and press Ask — e.g. "add four M4 corner bolt holes", '
        + '"make the walls 3 mm", "lighten this by 50%". Select a face first to aim the change at it. '
        + 'Each answer appears in the chat; click an earlier one to go back to it.'],
      ['Lighten', 'The AI cuts windows between ribs in flat plates, or rebuilds an open bracket as tapered spokes, '
        + 'aiming to remove 30–40% of the mass. Holes and mounting faces stay exact; edges are rounded last. '
        + 'Select a face first to lighten just that face.'],
      ['Round', 'The AI rounds every edge of the part (outside corners and inside blends), keeping holes, '
        + 'the bed face and mating faces exact. The two radii land in Parameters.'],
      ['Shell', 'Hollows the part out to walls of a thickness, leaving the selected faces open. Select the '
        + 'face(s) to open (Shift-click for more), then Shell. In the dialog: the thickness, Inside (the outside '
        + 'stays the same) or Outside (the part grows), and the open faces — hover a row to light its face, × to '
        + 'close it, click a face of the part to add it. The result shows as a blue ghost while you change '
        + 'things. It adds one script line, the thickness a parameter (wall). Too thick says the largest that '
        + 'works. Or ask: "shell it, 2 mm walls, open top".'],
      ['Edit a step', 'In the code view, put the cursor on a shell(…) line and click "Edit shell" at the top right '
        + '(or double-click the line): its dialog opens with the line\'s values, and OK rewrites only that line.'],
      ['Fix with AI', 'Shown when a build fails: sends the error to the AI, which repairs the script and rebuilds.'],
    ],
  },
  {
    title: 'Select and tweak',
    items: [
      ['Click a face', 'Shows what it is in the footer. Click a second face to pick the edge between them. '
        + 'Shift-click adds (or drops) a face, for picking several (e.g. the faces Shell leaves open).'],
      ['Drag the arrow', 'A selected face that a parameter moves gets a blue arrow: drag it to change that '
        + 'parameter (Tab cycles if several do).'],
      ['Parameters', 'The named sizes at the top. Edit a value and the part rebuilds; hover one to see which faces it moves.'],
      ['Protect', 'With a face selected on a rounded part: keeps that face flat and its edges sharp.'],
      ['Hold ⌥', 'Shows dimensions in the 3D view.'],
      ['Sketch on face', 'Select a flat face and press K (or the button): the full 2D sketcher opens on that face. '
        + 'Esc or Done returns to 3D; the sketch stays drawn on the part. Double-click it to edit again.'],
      ['Sketch on a plane', 'With nothing selected, K (or Sketch…) offers the Top, Front and Right planes through '
        + 'the origin (keys T, F, R). This is how a new part starts: sketch the outline, then Extrude → New body.'],
      ['Extrude…', 'In the sketch banner. With no part yet, New body makes the shapes the part, at a height. '
        + 'After that: Cut the closed shapes into the part (through all, or to a depth) or Join them on as '
        + 'pegs/bosses. While the dialog is open the view tilts to preview it: the shapes at each end and '
        + 'arrows the way it goes (red cut, green join), with the direction in words. Flip sends it the other '
        + 'way; on a base plane, Both ways extrudes the depth to each side. It adds one script line and a '
        + 'depth parameter; editing the sketch later rebuilds the part. Wrong way? Versions restores the '
        + 'previous script, or negate the amount in that line.'],
    ],
  },
  {
    title: 'View',
    items: [
      ['Drag · scroll', 'Drag to orbit (the part turns about its vertical Z axis), scroll to zoom.'],
      ['Front … Iso', 'The buttons along the bottom of the 3D view. Keys 1–6 and 0 do the same, in that order.'],
      ['Normal', 'Look straight at the selected face (key N).'],
      ['Persp / Ortho', 'Perspective or orthographic — no perspective, for checking alignment (key O).'],
      ['Click X / Y / Z', 'In the axes at bottom left: view from that axis. Click again for the opposite side.'],
      ['Code · Chat · 3D', 'At the top: what sits beside the 3D view. Code shows the script with the chat along the '
        + 'bottom; Chat puts the conversation where the script was; 3D gives the whole window to the part. '
        + 'Key L (or Ctrl/⌘+\\, even while typing) steps through them.'],
      ['Params', 'Shows or hides the parameters (key P, or × on the pane). They sit above the script or chat, '
        + 'and float at the top right of the 3D view when it is maximised.'],
    ],
  },
  {
    title: 'Reading the footer',
    items: [
      ['rounded N edges', 'Edges rounded, plus any skipped (too tight to round — "show skipped" highlights them) '
        + 'and capped (rounded smaller than asked so they fit).'],
      ['windows · −X% mass', 'After lightening: windows cut (and any too small to keep), and how much material came off.'],
      ['⚠ warnings', 'Walls thinner than min_wall, steep overhangs, or joints that could not be blended. Hover for details.'],
    ],
  },
  {
    title: 'Files and settings',
    items: [
      ['Build', 'Rebuilds from the script after editing it by hand.'],
      ['Versions', 'Saved versions of the script; restore any of them.'],
      ['Process', 'How the part will be made (e.g. FDM printing). The AI designs every change to it.'],
      ['Import STEP', 'Starts the part from a STEP file.'],
      ['STL · STEP', 'Download the part for printing or for other CAD tools.'],
      ['Parts · DXF · 3-View', 'One STL per body (zipped); a flat top-down DXF for CNC; top, front and side DXFs.'],
    ],
  },
];

export function PartHelpModal({ onClose }: PartHelpModalProps) {
  const palette = useThemeStore((s) => s.palette);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1100,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Part editor help"
        style={{
          background: palette.panelBg,
          border: `1px solid ${palette.border}`,
          borderRadius: '8px',
          padding: '20px 28px',
          maxWidth: '760px',
          width: '90%',
          maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0, fontSize: '16px', color: palette.text }}>Part editor</h2>
          <button
            onClick={onClose}
            aria-label="Close"
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

        {SECTIONS.map((section) => (
          <div key={section.title} style={{ marginBottom: '18px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: palette.accent, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {section.title}
            </div>
            {section.items.map(([term, desc]) => (
              <div key={term} style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '12px', marginBottom: '7px' }}>
                <span style={{ fontSize: '12.5px', fontWeight: 600, color: palette.text }}>{term}</span>
                <span style={{ fontSize: '12.5px', lineHeight: 1.45, color: palette.textSecondary }}>{desc}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
