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

## Foundation: edge selection (next, highest priority)

Pick edges in the 3D view (hover, click, Shift for more, loops/chains), with stable
`edge_ref()` references in scripts, like `face_ref()`. Fillet, chamfer, mirror
lines, pattern directions, revolve axes and "up to" references all depend on it.

## Tier 1: core features still missing

| # | Feature | Notes | Size |
|---|---------|-------|------|
| 1 | Fillet / chamfer on selected edges | The most-used CAD operation. First user of edge selection. | M |
| 2 | Reopen any operation to edit | Shell/Hole reopen already; Extrude and the rest must too. | S |
| 3 | Section view | Draggable clipping plane: walls, insert depth, board fit. | S |
| 4 | Mirror (features or body, across a plane) | Symmetric parts, left/right versions. | M |
| 5 | 3D pattern (linear / circular) | Vents, ribs, boss circles. Follow the 2D copy dialogs. | M |
| 6 | Offset plane | Sketch at a height or mid-way between faces. | S |
| 7 | Revolve | Knobs, spacers, pulleys. Reuses extrude plumbing. | S-M |
| 8 | Extrude "up to face" / "up to next" | Bosses meeting walls; geometry-defined depths. | S-M |
| 9 | Sketcher gaps | H/V between two points, offset curve, trim, project edges of other faces. | S each |

## Tier 2: specific to 3D printing

| # | Feature | Notes | Size |
|---|---------|-------|------|
| 10 | Text (sketch text, extrude to emboss/engrave) | Labels and markings. | M |
| 11 | Split body (optional alignment pin holes) | Parts bigger than the bed; support-free halves. | M |
| 12 | 3MF export | Slicers prefer it: units and bodies survive. | S |
| 13 | Overhang highlight (faces past 45 deg) | See print problems before slicing. | S |

## AI only (no buttons)

Sweep, loft, draft angles, ribs, threads, variable fillets, coils, unusual shapes.

## Deliberately out of scope

Assemblies with joints between documents, 2D technical drawings (DXF views cover
it), simulation, sheet metal, surface modelling, rendering.

## Order

Edge selection -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8, with 9 fitted in along the
way, then 10-13. Each step stands alone and is kept or reverted on its own merit.
