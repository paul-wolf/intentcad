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
      ['Hole', 'Screw holes going straight into the part. Where: the points and circle centres of a sketch '
        + '(select the face it is drawn on, or pick it in "At"), or the centre of a selected flat face. Kind: '
        + 'Clearance (close or normal fit), Tapped (self-tapping into plastic), Heat-set insert, Counterbore or '
        + 'Countersink; sizes M2–M5. Standoff puts each hole in a round boss of a height and outer diameter, '
        + 'with a fillet at its foot. Depth is a number or Through. The sizes come from one table (sources '
        + 'shown in the dialog); each shows "preset" and can be changed — a changed one becomes a parameter. '
        + 'hole_comp (in Parameters, 0 to start) is added to every hole diameter, to correct for your printer. '
        + 'The result shows as a blue ghost while you change things; it adds one script line. '
        + 'Or ask: "four M3 insert standoffs 6 high at the sketch points".'],
      ['Fillet / Chamfer', 'Rounds (Fillet) or bevels (Chamfer) the selected edges. Select edges — '
        + 'double-click one for the whole loop round the face under the cursor, Shift-click for more — then '
        + 'Fillet or Chamfer. In the dialog: the radius or distance (type it, or drag the blue handle on the '
        + 'first edge, in 0.1 mm steps), and the edges — hover a row to light it, × to leave it out, click an '
        + 'edge of the part to add or drop it. The result shows as a blue ghost; it adds one script line with '
        + 'the size a parameter (fillet_r, chamfer_d) and the edges by edge_ref, so they stay put when the part '
        + 'changes. Too large says the largest that works. Or ask: "fillet the top rim 1 mm".'],
      ['Edit a step', 'In the code view, put the cursor on a shell(…), holes(…), fillet(…) or chamfer(…) line '
        + 'and click "Edit …" at the top right (or double-click the line): its dialog opens with the line\'s '
        + 'values, and OK rewrites only that line.'],
      ['Fix with AI', 'Shown when a build fails: sends the error to the AI, which repairs the script and rebuilds.'],
    ],
  },
  {
    title: 'Select and tweak',
    items: [
      ['Click a face or edge', 'Selects it (the footer says what it is). Within a few pixels of an edge, the '
        + 'edge is picked, else the face under the cursor; whatever a click would pick lights up as you hover. '
        + 'Shift-click adds (or drops) one, for picking several; Shift-click two faces to measure between them '
        + 'and see the edge they share. Click empty space or press Esc to clear.'],
      ['Double-click an edge', 'Selects its whole loop: every edge round the face it borders that the cursor '
        + 'is over (e.g. all the edges round the top). Alt/⌥-double-click selects the chain of edges that run '
        + 'smoothly on from it. With one face selected, "Edges of this face" selects its boundary.'],
      ['Faces + edges · Faces · Edges', 'Along the bottom of the 3D view: what a click picks (key E steps through them).'],
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
      ['Normal', 'Look straight at the selected face (key N); with the section on, straight at the cut.'],
      ['Section', 'Key Z (or Section, under Inspect): cuts the view open at a plane to check walls, insert '
        + 'depths and board fit; the script is not changed. With a flat face selected it starts just inside that '
        + 'face, else through the middle, square to the view. The panel at the top turns it to X, Y or Z, aligns '
        + 'it to the selected face, flips which side is cut away and takes a typed offset; drag the arrow to move '
        + 'it (0.5 mm steps, Shift 0.1, Esc cancels; it snaps onto parallel faces). Hover the cut for the wall '
        + 'thickness there, or click two points on its outline for their distance — curved walls are measured '
        + 'on the mesh, so they are marked approximate (≈). It is remembered per part, and is off while sketching.'],
      ['Persp / Ortho', 'Perspective or orthographic — no perspective, for checking alignment (key O).'],
      ['Click X / Y / Z', 'In the axes at bottom left: view from that axis. Click again for the opposite side.'],
      ['Code · Chat · Context · 3D · Operations', 'At the top: what sits beside the 3D view. Code shows the script with the '
        + 'chat along the bottom; Chat puts the conversation where the script was; Context shows the reference files '
        + 'the AI reads (below); 3D gives the whole window to the '
        + 'part; Operations (the grid icon) shows every operation. Key L (or Ctrl/⌘+\\, even while typing) steps '
        + 'through them, Shift+L (Ctrl/⌘+Shift+\\) steps back; U goes to Operations and back to where you were.'],
      ['Operations', 'Every operation as a tile, by group, with the last four used at the top. A tile that can\'t '
        + 'run with what is selected stays dimmed and says what it needs; tiles that a new selection makes '
        + 'available light up for a moment. Hover or focus a tile for what it does, its key, and an example to ask '
        + 'the AI instead — clicking the example puts it in the chat box (it isn\'t sent). Arrow keys move between '
        + 'tiles, Enter runs one, Esc goes back. The top bar offers up to five that the selection makes possible '
        + '(a flat face: Sketch on face, Extrude, Hole…; an edge: Fillet, Chamfer…; nothing: sketch on a base plane) '
        + 'beside Build; the Operations button (U) opens the rest. The keys work either way.'],
      ['Context', 'Datasheets, drawings and photos the AI reads with each message: this part\'s, and the '
        + 'project\'s (shared by its parts). Drop files on the pane, use + Add file (or the Add context file '
        + 'operation), or paste a photo into the chat box. The switch on a card takes a file in or out of context; '
        + 'click a card to page through it, zoom (wheel, double-click) and pan (drag), and tick the pages the AI '
        + 'gets. The chips above the chat box are the files the next message sends; × leaves one out of that '
        + 'message only. The AI cites the file and page for each dimension it takes from them and lists '
        + 'the values it estimated, so check those before printing.'],
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
