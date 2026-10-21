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
- Overhang highlight (H, Inspect): faces past a threshold (30–70°, default 45°) shaded steep or ceiling by angle, per fragment; hover for the angle; a print bed face other than Z (stored in the part, matched each build, also used by auto_round's bed protection); panel with projected areas and region count; Ask AI to fix puts a request with the flagged regions in the chat box
- Context files: datasheets and photos the AI reads, with cited dimensions (step 1 of 3)
- Sketcher gaps: H/V between any two points; point on line / circle and symmetric about a line; corner fillet (radius a dimension, clamped when too large); trim (splits polylines and circles, keeps the constraints that still apply); offset of a closed shape, circle or chain (arcs or miters, follows its source, distance a dimension, unlink); project part edges onto a face/plane sketch (follow the part, broken when the edge goes)

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
| 8 | Extrude "up to face" / "up to next" | Bosses meeting walls; geometry-defined depths. | S-M |
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

Done: edge selection, 1, 2, 3, 4, 5, 6, 6b, 7, 9, 13. Next:
8 (up to face) -> 12, 10, 11. Context files
steps 2-3 run on their own track. Each step stands alone and is kept or reverted on
its own merit.
