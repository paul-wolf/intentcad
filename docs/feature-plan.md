# Part editor feature plan

What the 3D part editor still needs to cover the features people actually use in
Fusion, Onshape and FreeCAD for 3D-printed parts. Lean on purpose: no obscure
features, nothing that duplicates another feature.

## Principle: button or AI?

A feature gets a **button operation** (dialog, live preview, one script line, values
in `P`, reopenable) when you have to **point at geometry** (faces, edges, a plane),
**judge a value by eye** (radius, depth), or use it **constantly**.
Everything else is **AI-only**: the AI can write any build123d feature, so rare
operations cost nothing to support, they just don't get UI.

## Done

- Sketch on face / base plane with the full 2D sketcher
- Extrude: cut, join, new body, through all, both ways
- Shell; Hole (clearance, tapped, insert, counterbore, countersink, standoff)
- auto_round, Lighten (truss windows), organic helpers (spoke, frame)
- `P` parameters; sketch dimensions can use `P`
- Face sketches follow their face (normal) and its edges (reference outline)
- Drag handles on parameters
- STEP import; STL / STEP / DXF export
- Measure (face readouts), standard views, normal-to, ortho
- Versions; Operations panel (one registry, selection-aware)
- Section view (Z): draggable clipping plane with hatched caps, wall-thickness and two-point readouts
- Construction planes: offset (face or base plane, distance may be a `P` expression) and on an edge at an angle; named in `PLANES`, follow the part, sketch on them, align the section to them
- Every operation reopens in its dialog; steps list (select, edit, switch off, delete, ⚠ per step)
- Edge selection (pick, loops, chains) with `edge_ref()`; Fillet / Chamfer on selected edges
- Mirror: a whole body across a face, base plane or construction plane (join, or a separate body), and chosen steps (extrude, holes, fillet, chamfer) as linked copies that follow their original
- Pattern: linear (one or two directions, spacing or extent, symmetric, skip) and circular (round an axis: X/Y/Z, a straight edge, a hole's rim or cylinder) of a whole body or of chosen steps, as linked copies like Mirror; numbers in P, drag handles for spacing and count, click a copy to leave it out
- Tangent plane on a cylindrical face (outward on a boss, toward the axis in a bore) at an angle round it from X/Y/Z or a flat face (a shaft's flat), angle in P, set by clicking the face or dragging a handle; for radial holes, with circular pattern for several
- Revolve: a closed sketch profile turned round an axis (sketch V/H axis, construction or reference line; a straight part edge; a cylinder's centre line; X/Y/Z) as new body, join or cut; full or partial angle, both ways, flip, numbers in P; default axis picked from the profile, crossings marked red and refused; rotation handle on the preview; supported in mirror/pattern steps
- Extrude up to face (a slanted wall, a cylinder, with an offset past or short of it, the face picked in the view) and up to next (each region to its own first face: standoffs to the floor, a set screw into the bore), in the extrude dialog's Extent; the face follows the part; supported in mirror/pattern steps
- Overhang highlight (H, Inspect): faces past a threshold (30–70°, default 45°) shaded steep or ceiling by angle, per fragment; hover for the angle; a print bed face other than Z (stored in the part, matched each build, also used by auto_round's bed protection); panel with projected areas and region count; Ask AI to fix puts a request with the flagged regions in the chat box
- Context files: datasheets and photos the AI reads, with cited dimensions (step 1 of 3); attached from the chat too (a paperclip button, drop or paste, an Attach a file button under the AI's open question)
- Sketcher gaps: H/V between any two points; point on line / circle and symmetric about a line; corner fillet (radius a dimension, clamped when too large); trim (splits polylines and circles, keeps the constraints that still apply); offset of a closed shape, circle or chain (arcs or miters, follows its source, distance a dimension, unlink); project part edges onto a face/plane sketch (follow the part, broken when the edge goes)
- CAM for sketches (2D editor): Setup (machine with a default material, tool library with cutting data per material, carbon fibre included, stock, origin, clamps), Plan (operations with defaults worked out from the setup, AI proposals with reasons to accept, per-value sources, lines that meet picked as one outline, Fix with AI can change an operation's shapes), Run (checks, simulator, steps at the machine, G-code)
- User events: sign-ins (and failed ones), sign-outs, parts and sketches made and AI calls with their cost, in one table; an Events page for superusers (search, kind, user, period) with AI spend per user; earlier sign-ins, AI calls and documents copied in
- Duplicate a part or sketch: a button on its card makes "Copy of <name>" in the same project, with the model, its STEP files, the part's context files and CAM jobs (no G-code); a fresh version history
- Examples for new organisations: a superuser chooses one project on the Organisations page; each new organisation gets its own copy (parts, sketches, STEP and context files, CAM jobs without G-code), with a box to skip it and an Add examples button for organisations made earlier
- The part editor names the part's project in the line under the top bar; click it to go back to the project
- Open in a new tab: Cmd/Ctrl-click or middle-click the logo, Home, Project, the breadcrumbs, a project row or a part/sketch card
- Project as context for the AI (phase 1 of 4): a Markdown project brief with versions (word warning past 2,000) that every part's chat reads first; a one-line description per part or sketch; the AI sees the project's other parts (size, key parameters) and reads one's script or parameters when it needs to; @-mentions; it answers questions in the chat and proposes brief changes as a diff to accept or reject
- Shared definitions (project context phase 2 of 4): a part's script builds from a sketch document in its project as SK["alias"] (closed shapes, named groups and elements, circles, points) and from project parameters as PP["name"] (a Parameters table on the project page); parts show out of date when what they read changes, the sketch editor lists its users with Rebuild all and warns before a save drops a group or name a part uses; a part version pins the sketch and parameter values it was built with (Follow latest undoes it); the AI switches parts to a shared sketch and proposes parameters to accept
- Sketch to parts (project context phase 2 of 4): Extrude…, Cut… and Revolve… in a project sketch's editor pick the shapes (whole sketch, a group, a named element) and the parts or a new part, then open each part in turn with the dialog and its preview ready (Place on: its own plane, a base or construction plane, or a clicked face; Skip and Cancel); Save to project turns a sketch on a part's face into a project sketch the part reads as SK["alias"]; a part links to its project sketches (Sketch … Edit ↗) and rebuilds when you come back after changing one; a sketch links back to its project; a one-sketch document and its sketch share one name
- Project parameters in sketches (project context phase 2 of 4): a project sketch's Parameters panel shows and edits the project's parameters, its dimensions use them by name (text values listed, not usable), and its own parameters sit under This sketch only with Move to project (a taken name: use the project's value or rename; no name is both); a change re-solves the sketches that use it in the browser (in the sketch editor on open, in the part editor before a build, after a save on the project page or an accepted AI proposal), and parts never build from a sketch not yet solved for the current values; a value a sketch can't meet still saves, the sketch keeps its last good shape and the failure shows on the sketch, the parameter and the parts; renaming rewrites sketch expressions and PP["…"] after listing what it changes; the project's Parameters table has Used by; degree/length mix-ups are warned
- Generated sketches and sketch chat (project context phase 3 of 4): New sketch opens the sketch editor with a chat; the AI proposes a generated sketch in one sentence and makes it (or Write it as code instead); its code reads project parameters, runs in the build worker and its stored result is what parts read (parts never run it); the editor shows the drawing with dims and labels, Outputs (sizes, Used by, hover both ways), Parameters (sliders try values without saving, Reset, Apply to project with the parts it affects), Checks (click to light the output) and Code (Run, errors on the line, earlier versions); a failing run keeps the last good drawing dimmed and parts build from it; dropping an output a part uses is held with the parts it breaks; Use project sketch shows generated sketches with a picture and their outputs, read as SK["alias"].group("output"); the sketch chat has the part chat's context plus the sketch and its users, edits a generated sketch's code and offers a generated sketch from a drawn one; Used by also counts names a part loops over

## Foundation: edge selection ✓ done

Pick edges in the 3D view (hover, click, Shift for more, loops/chains), with stable
`edge_ref()` references in scripts, like `face_ref()`. Fillet, chamfer, mirror
lines, pattern directions, revolve axes and "up to" references all depend on it.

## Tier 1: core features still missing

| # | Feature | Notes | Size |
|---|---------|-------|------|
| 1 | ~~Fillet / chamfer on selected edges~~ ✓ done | The most-used CAD operation. First user of edge selection. | M |
| 2 | ~~Reopen any operation to edit~~ ✓ done | Extrude, Shell, Hole, Fillet/Chamfer, Round, Lighten reopen; steps list with suppress/delete. | S |
| 3 | ~~Section view~~ ✓ done | Draggable clipping plane: walls, insert depth, board fit. | S |
| 4 | ~~Construction planes~~ ✓ done | Offset from a face or base plane (distance may be a P expression, so a midplane is `width / 2`), and through an edge at an angle. Named, follow the part, usable wherever a plane is needed. Tangent planes on a cylinder are #6b; other plane types (3 points) and axes are AI-only. | S-M |
| 5 | ~~Mirror (features or body, across a plane)~~ ✓ done | Symmetric parts, left/right versions. Any plane: face, base plane, construction plane. | M |
| 6 | ~~3D pattern (linear / circular)~~ ✓ done | Vents, ribs, boss circles. Follow the 2D copy dialogs. | M |
| 6b | ~~Tangent plane on a cylinder~~ ✓ done | Touches a cylindrical face at an angle round its axis (angle from a stated reference, in P); sketch x along the axis. For radial holes: set screws in hubs/knobs, cable holes in round enclosures. Pairs with up-to-face (#8) and circular pattern. Later: Hole tool places radial holes on a clicked cylinder directly. | S |
| 7 | ~~Revolve~~ ✓ done | Knobs, spacers, pulleys, grooves: new/join/cut, full or partial (both ways, flip). Axis: a sketch line (V/H axis, construction or reference line), a straight part edge, a cylinder's centre line, or X/Y/Z. Crossing the axis is marked and refused. Works in mirror/pattern steps. | S-M |
| 8 | ~~Extrude "up to face" / "up to next"~~ ✓ done | Bosses meeting walls; geometry-defined depths. Up to face ends on a face's surface, extended (slanted wall, cylinder), with an offset past or short of it; up to next stops each region of the profile at its own first face (a join where it meets material, a cut where it breaks out of it). Overhang/bridge cases it can't do are refused. Works in mirror/pattern steps. | S-M |
| 9 | ~~Sketcher gaps~~ ✓ done | H/V between two points, point on curve and symmetric, corner fillet, trim, offset (linked to its source), project edges of other faces. | S each |

## Tier 2: specific to 3D printing

| # | Feature | Notes | Size |
|---|---------|-------|------|
| 10 | Text (sketch text, extrude to emboss/engrave) | Labels and markings. | M |
| 11 | Split body (optional alignment pin holes) | Parts bigger than the bed; support-free halves. | M |
| 12 | 3MF export | Slicers prefer it: units and bodies survive. | S |
| 13 | ~~Overhang highlight~~ ✓ done | See print problems before slicing: steep and ceiling faces past an adjustable threshold, a chosen print bed face, areas, Ask AI to fix. | S |

## AI only (no buttons)

Sweep, loft, draft angles, ribs, threads, variable fillets, coils, unusual shapes.

## Deliberately out of scope

Assemblies with joints between documents, 2D technical drawings (DXF views cover
it), simulation, sheet metal, surface modelling, rendering.

## Order

Done: edge selection, 1-9, 6b, 13, project context phases 1-3 (with project parameters in sketches, generated sketches and sketch chat). Next: 12, 10, 11. Context
files steps 2-3 and project context phase 4 run on their own tracks. Each step stands alone and is kept or reverted on
its own merit.

Known gap: a build served from the browser's cache doesn't update the server's record of
the part's last build, so a part can show out of date until it is built again on the
server (Rebuild all, or a change that misses the cache). The cache key includes the
shared inputs, so a cache hit never shows a stale shape.
