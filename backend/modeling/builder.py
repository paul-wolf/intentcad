"""Turn a self-contained build request into a solid, then into a mesh + STEP.

Prototype scope: extrude features only.

Profile handling (the hard part) works like a real sketcher:
  1. Circles / rectangles / closed polylines become closed loops directly.
  2. Loose line segments are STITCHED end-to-end into closed loops (a boundary
     is often drawn as many separate edges, not one polyline).
  3. Loops are nested by geometric CONTAINMENT: an even-depth loop is a solid
     region, its directly-enclosed loops are holes. (No "largest = outer"
     guessing — that mistakes disjoint shapes for holes.)
  4. Each region becomes a face (outer + holes), is extruded, and fused.

Deliberately NOT handled yet (tracked as warnings, not errors):
  - bulge arcs (polyline segments treated as straight)
  - revolve / loft / fillet / chamfer / shell / construction planes
  - per-feature sketch plane placement (everything extrudes along +Z)
"""

from __future__ import annotations

import math
import tempfile
from dataclasses import dataclass, field

import cadquery as cq
from cadquery import Edge, Face, Solid, Vector, Wire

from .schemas import BuildRequest, SketchEntityIn, SketchIn
from .selectors import resolve_edges

_TOL = 1e-4      # endpoint-matching / closure tolerance (world units)
_ARC_MIN = 1e-4  # |bulge| below this is treated as a straight segment


class BuildError(Exception):
    """Unrecoverable modeling failure — surfaced to the client as HTTP 422."""


@dataclass
class BuildResult:
    positions: list[float]
    normals: list[float]
    triangle_count: int
    step: str
    metrics: dict = field(default_factory=dict)
    faces: list = field(default_factory=list)
    edges: list = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# ── coordinate convention ────────────────────────────────────────────────
# Editor is Y-down (screen); CAD is Y-up (math). Flip Y, same as export/dxf.ts.
# Containment math below stays in raw screen space — topology is flip-invariant.
def _v(x: float, y: float, z: float = 0.0) -> Vector:
    return Vector(x, -y, z)


# ── a closed loop: its wire + a 2D polygon (screen space) for containment ──
@dataclass
class Loop:
    wire: Wire
    poly: list[tuple[float, float]]  # screen-space polygon
    rep: tuple[float, float]         # a point inside `poly`
    area: float                      # unsigned polygon area


def _poly_area(poly: list[tuple[float, float]]) -> float:
    s = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def _make_loop(wire: Wire, poly: list[tuple[float, float]], rep: tuple[float, float]) -> Loop:
    return Loop(wire, poly, rep, _poly_area(poly))


def _contains(outer: Loop, inner: Loop) -> bool:
    """`outer` contains `inner`. A container is strictly larger; the area guard
    disambiguates coincident representative points (e.g. a concentric hole)."""
    return outer.area > inner.area and _point_in_poly(inner.rep, outer.poly)


def _rectangle_corners(e: SketchEntityIn) -> list[tuple[float, float]]:
    hw, hh = e.width / 2.0, e.height / 2.0
    if e.anchor == "corner":
        cx, cy = e.center.x + hw, e.center.y + hh
    else:
        cx, cy = e.center.x, e.center.y
    return [(cx - hw, cy - hh), (cx + hw, cy - hh), (cx + hw, cy + hh), (cx - hw, cy + hh)]


def _poly_wire(pts: list[tuple[float, float]]) -> Wire:
    return Wire.makePolygon([_v(x, y) for x, y in pts], close=True)


def _centroid(pts: list[tuple[float, float]]) -> tuple[float, float]:
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


# ── bulge arcs (matches frontend/src/utils/arcGeometry.ts) ───────────────
# bulge = tan(theta/4); positive bulge bulges to the LEFT of p1->p2. Everything
# here is in screen space; the Y-flip in _v reflects it into CAD space, which
# maps a circular arc to a circular arc, so the three-point construction holds.
def _arc_midpoint(p1: tuple[float, float], p2: tuple[float, float], bulge: float) -> tuple[float, float]:
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    d = math.hypot(dx, dy)
    if d == 0 or bulge == 0:
        return ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
    sag = bulge * d / 2.0
    perpx, perpy = -dy / d, dx / d  # left of p1->p2
    return ((p1[0] + p2[0]) / 2 - sag * perpx, (p1[1] + p2[1]) / 2 - sag * perpy)


def _arc_points(p1: tuple[float, float], p2: tuple[float, float], bulge: float,
                depth: int = 3) -> list[tuple[float, float]]:
    """Polyline approximation of an arc, from p1 (inclusive) toward p2 (exclusive).

    Recursive bisection: half the arc has bulge tan(atan(bulge)/2). Used only for
    2D containment/area — the wire itself uses an exact arc edge."""
    if abs(bulge) < _ARC_MIN or depth == 0:
        return [p1]
    mid = _arc_midpoint(p1, p2, bulge)
    half = math.tan(math.atan(bulge) / 2)
    return _arc_points(p1, mid, half, depth - 1) + _arc_points(mid, p2, half, depth - 1)


def _line_loop(verts: list[tuple[float, float]], bulges: list[float]) -> tuple[Wire, list[tuple[float, float]]]:
    """Closed loop from ordered vertices + per-segment bulges -> (wire, polygon).

    Segment i runs verts[i] -> verts[(i+1) % L] with bulge bulges[i] (0 if absent),
    matching the frontend segment/bulge indexing."""
    n = len(verts)
    edges = []
    poly: list[tuple[float, float]] = []
    for i in range(n):
        a, b = verts[i], verts[(i + 1) % n]
        bulge = bulges[i] if i < len(bulges) else 0.0
        if abs(bulge) >= _ARC_MIN:
            amid = _arc_midpoint(a, b, bulge)
            edges.append(Edge.makeThreePointArc(_v(*a), _v(*amid), _v(*b)))
            poly.extend(_arc_points(a, b, bulge))
        else:
            edges.append(Edge.makeLine(_v(*a), _v(*b)))
            poly.append(a)
    return Wire.assembleEdges(edges), poly


def _point_in_poly(pt: tuple[float, float], poly: list[tuple[float, float]]) -> bool:
    """Even-odd ray cast in 2D."""
    x, y = pt
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xint = x1 + (y - y1) / (y2 - y1) * (x2 - x1)
            if x < xint:
                inside = not inside
    return inside


def _close(a: tuple[float, float], b: tuple[float, float]) -> bool:
    return math.hypot(a[0] - b[0], a[1] - b[1]) <= _TOL


# ── stitch open polylines/segments into closed loops ─────────────────────
def _stitch(paths: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Greedily join open paths that share endpoints into closed rings.

    A path left over with >= 3 points is force-closed (assume it's an intended
    boundary drawn as one open polyline); shorter leftovers are dropped.
    """
    pending = [list(p) for p in paths]
    loops: list[list[tuple[float, float]]] = []

    while pending:
        chain = pending.pop()
        changed = True
        while changed and not (len(chain) >= 3 and _close(chain[0], chain[-1])):
            changed = False
            for i, p in enumerate(pending):
                if _close(chain[-1], p[0]):
                    chain += p[1:]
                elif _close(chain[-1], p[-1]):
                    chain += list(reversed(p))[1:]
                elif _close(chain[0], p[-1]):
                    chain = p[:-1] + chain
                elif _close(chain[0], p[0]):
                    chain = list(reversed(p))[1:] + chain
                else:
                    continue
                pending.pop(i)
                changed = True
                break

        if _close(chain[0], chain[-1]):
            chain = chain[:-1]
        if len(chain) >= 3:
            loops.append(chain)
    return loops


# ── entities → loops ─────────────────────────────────────────────────────
def _sketch_to_loops(sketch: SketchIn, warnings: list[str]) -> list[Loop]:
    loops: list[Loop] = []
    open_paths: list[list[tuple[float, float]]] = []

    for e in sketch.entities:
        if e.construction:
            continue

        if e.type == "circle" and e.center is not None and e.radius:
            cx, cy, r = e.center.x, e.center.y, e.radius
            poly = [(cx + r * math.cos(t), cy + r * math.sin(t))
                    for t in (2 * math.pi * k / 48 for k in range(48))]
            wire = Wire.makeCircle(r, _v(cx, cy), Vector(0, 0, 1))
            loops.append(_make_loop(wire, poly, (cx, cy)))

        elif e.type == "rectangle" and e.center is not None and e.width and e.height:
            corners = _rectangle_corners(e)
            loops.append(_make_loop(_poly_wire(corners), corners, _centroid(corners)))

        elif e.type == "line" and e.points and len(e.points) >= 2:
            pts = [(p.x, p.y) for p in e.points]
            bulges = list(e.bulge) if e.bulge else []
            has_arc = any(abs(b) >= _ARC_MIN for b in bulges)
            if _close(pts[0], pts[-1]):
                pts = pts[:-1]  # drop an explicit duplicate closing vertex
            # A multi-vertex polyline is a standalone profile — close it directly so
            # its arcs survive, even if the sketch never set `closed`. Only loose
            # 2-point segments go to the straight-only stitcher.
            if len(pts) >= 3 or (len(pts) == 2 and has_arc):
                wire, poly = _line_loop(pts, bulges)
                loops.append(_make_loop(wire, poly, _centroid(poly)))
            else:
                open_paths.append(pts)

    for ring in _stitch(open_paths):
        loops.append(_make_loop(_poly_wire(ring), ring, _centroid(ring)))

    if not loops:
        raise BuildError(f"sketch {sketch.id}: no closed profile to extrude")
    return loops


# ── loops → faces via containment nesting ────────────────────────────────
@dataclass
class Region:
    """A solid-forming area: one outer boundary wire plus hole wires."""
    outer: Wire
    holes: list[Wire]


def _loops_to_regions(loops: list[Loop], sketch_id: str) -> list[Region]:
    depth = [
        sum(1 for j, o in enumerate(loops) if j != i and _contains(o, lp))
        for i, lp in enumerate(loops)
    ]

    regions: list[Region] = []
    for i, lp in enumerate(loops):
        if depth[i] % 2 != 0:
            continue  # odd depth => this loop is a hole in some region
        holes = [
            o.wire for j, o in enumerate(loops)
            if depth[j] == depth[i] + 1 and _contains(lp, o)
        ]
        regions.append(Region(lp.wire, holes))

    if not regions:
        raise BuildError(f"sketch {sketch_id}: no outer region found")
    return regions


def _fuse(solids: list[Solid]) -> Solid:
    result = solids[0]
    for s in solids[1:]:
        result = result.fuse(s)
    return result


# ── extrude ──────────────────────────────────────────────────────────────
def _extrude(regions: list[Region], distance: float, direction: str | None, sketch_id: str) -> Solid:
    if not distance or distance <= 0:
        raise BuildError("extrude: distance must be > 0")

    def one(r: Region) -> Solid:
        try:
            face = Face.makeFromWires(r.outer, r.holes)
        except Exception as exc:
            raise BuildError(f"sketch {sketch_id}: could not form a face ({exc})") from exc
        if direction == "both":
            base = face.translate(Vector(0, 0, -distance / 2.0))
            return Solid.extrudeLinear(base, Vector(0, 0, distance))
        if direction == "reverse":
            return Solid.extrudeLinear(face, Vector(0, 0, -distance))
        return Solid.extrudeLinear(face, Vector(0, 0, distance))

    return _fuse([one(r) for r in regions])


# ── revolve ──────────────────────────────────────────────────────────────
def _revolve(regions: list[Region], axis_start: Vector, axis_end: Vector,
             angle: float | None, sketch_id: str) -> Solid:
    if (axis_start - axis_end).Length < _TOL:
        raise BuildError("revolve: axis endpoints coincide")
    ang = 360.0 if not angle else float(angle)
    if ang <= 0 or ang > 360:
        raise BuildError("revolve: angle must be in (0, 360]")

    def one(r: Region) -> Solid:
        try:
            return Solid.revolve(r.outer, r.holes, ang, axis_start, axis_end)
        except Exception as exc:
            raise BuildError(
                f"sketch {sketch_id}: revolve failed — the profile likely crosses the axis ({exc})"
            ) from exc

    return _fuse([one(r) for r in regions])


# ── fillet (first selector-consuming, target-scoped operation) ───────────
def _fillet(shape, selector: str, radius: float | None, feat_id: str):
    if not radius or radius <= 0:
        raise BuildError(f"feature {feat_id}: fillet radius must be > 0")
    idxs = resolve_edges(selector, _edges(shape))
    if not idxs:
        raise BuildError(f"feature {feat_id}: fillet selector '{selector}' matched no edges")
    all_edges = shape.Edges()
    picked = [all_edges[i] for i in idxs]
    try:
        return shape.fillet(radius, picked)
    except Exception as exc:
        raise BuildError(f"feature {feat_id}: fillet failed ({exc})") from exc


def _chamfer(shape, selector: str, distance: float | None, feat_id: str):
    if not distance or distance <= 0:
        raise BuildError(f"feature {feat_id}: chamfer distance must be > 0")
    idxs = resolve_edges(selector, _edges(shape))
    if not idxs:
        raise BuildError(f"feature {feat_id}: chamfer selector '{selector}' matched no edges")
    all_edges = shape.Edges()
    picked = [all_edges[i] for i in idxs]
    try:
        return shape.chamfer(distance, None, picked)
    except Exception as exc:
        raise BuildError(f"feature {feat_id}: chamfer failed ({exc})") from exc


# ── base-plane placement ─────────────────────────────────────────────────
# The 2D→wire code always builds on XY (extruding +Z). To sit a sketch on
# another base plane, build as usual then rigidly reorient the solid: XZ swings
# +Z to +Y, YZ swings +Z to +X. Keeps every wire builder untouched.
def _place(solid, plane: str | None):
    if not plane or plane.upper() == "XY":
        return solid
    p = plane.upper()
    if p == "XZ":
        return solid.rotate((0, 0, 0), (1, 0, 0), -90)
    if p == "YZ":
        return solid.rotate((0, 0, 0), (0, 1, 0), 90)
    raise BuildError(f"unknown plane '{plane}' (use XY, XZ, or YZ)")


# ── mesh + STEP ──────────────────────────────────────────────────────────
def _tessellate(shape, tolerance: float) -> tuple[list[float], list[float], int]:
    verts, tris = shape.tessellate(tolerance)
    positions: list[float] = []
    normals: list[float] = []
    for a, b, c in tris:
        va, vb, vc = verts[a], verts[b], verts[c]
        n = (vb - va).cross(vc - va)
        ln = n.Length
        nx, ny, nz = (n.x / ln, n.y / ln, n.z / ln) if ln > 1e-12 else (0.0, 0.0, 1.0)
        for v in (va, vb, vc):
            positions.extend((v.x, v.y, v.z))
            normals.extend((nx, ny, nz))
    return positions, normals, len(tris)


def _faces(shape) -> list[dict]:
    """Inventory v0: each face classified with coarse descriptors + orientation tags."""
    out = []
    for i, f in enumerate(shape.Faces()):
        c = f.Center()
        n = f.normalAt()
        kind = f.geomType().lower()
        tags: list[str] = []
        if kind == "plane":
            if n.z > 0.9:
                tags.append("top")
            elif n.z < -0.9:
                tags.append("bottom")
            else:
                tags.append("vertical")
        out.append({
            "index": i,
            "kind": kind,
            "area": f.Area(),
            "center": [c.x, c.y, c.z],
            "normal": [n.x, n.y, n.z],
            "tags": tags,
        })
    return out


def _edges(shape) -> list[dict]:
    """Inventory v0: each edge classified with coarse descriptors."""
    out = []
    for i, e in enumerate(shape.Edges()):
        c = e.Center()
        try:
            s, en = e.startPoint(), e.endPoint()
            start, end = [s.x, s.y, s.z], [en.x, en.y, en.z]
        except Exception:  # closed curves (full circle) have no distinct ends
            start = end = [c.x, c.y, c.z]
        out.append({
            "index": i,
            "kind": e.geomType().lower(),
            "length": e.Length(),
            "center": [c.x, c.y, c.z],
            "start": start,
            "end": end,
        })
    return out


def _metrics(shape) -> dict:
    bb = shape.BoundingBox()
    c = shape.Center()
    return {
        "volume": shape.Volume(),
        "area": shape.Area(),
        "bbox_min": [bb.xmin, bb.ymin, bb.zmin],
        "bbox_max": [bb.xmax, bb.ymax, bb.zmax],
        "center": [c.x, c.y, c.z],
    }


def _export_step(shape) -> str:
    wp = cq.Workplane(obj=shape)
    with tempfile.NamedTemporaryFile(suffix=".step", mode="r+", delete=True) as fh:
        cq.exporters.export(wp, fh.name, exportType="STEP")
        fh.seek(0)
        return fh.read()


# ── entry point ──────────────────────────────────────────────────────────
def build(req: BuildRequest) -> BuildResult:
    warnings: list[str] = []
    sketches = {s.id: s for s in req.sketches}

    result = None
    for feat in req.features:
        if feat.type == "fillet":
            if result is None:
                raise BuildError(f"feature {feat.id}: fillet needs existing geometry")
            result = _fillet(result, feat.edges or "all", feat.radius, feat.id)
            continue
        if feat.type == "chamfer":
            if result is None:
                raise BuildError(f"feature {feat.id}: chamfer needs existing geometry")
            result = _chamfer(result, feat.edges or "all", feat.distance, feat.id)
            continue

        sketch = sketches.get(feat.sketchId)
        if sketch is None:
            raise BuildError(f"feature {feat.id}: sketch '{feat.sketchId}' not in request")

        if feat.type == "extrude":
            regions = _loops_to_regions(_sketch_to_loops(sketch, warnings), sketch.id)
            solid = _extrude(regions, feat.distance, feat.direction, sketch.id)
        elif feat.type == "revolve":
            if feat.axis is None:
                raise BuildError(f"feature {feat.id}: revolve needs an axis")
            regions = _loops_to_regions(_sketch_to_loops(sketch, warnings), sketch.id)
            ax_start = _v(feat.axis.start.x, feat.axis.start.y)
            ax_end = _v(feat.axis.end.x, feat.axis.end.y)
            solid = _revolve(regions, ax_start, ax_end, feat.angle, sketch.id)
        else:
            warnings.append(f"feature {feat.id}: type '{feat.type}' not supported yet — skipped")
            continue

        solid = _place(solid, feat.plane)

        if result is None:
            result = solid
        elif feat.operation == "remove":
            result = result.cut(solid)
        else:
            result = result.fuse(solid)

    if result is None:
        raise BuildError("no feature produced geometry")

    positions, normals, tri_count = _tessellate(result, req.tolerance)
    step = _export_step(result)
    metrics = _metrics(result)
    faces = _faces(result)
    edges = _edges(result)
    # de-duplicate warnings while preserving order
    seen: dict[str, None] = {}
    for w in warnings:
        seen.setdefault(w, None)
    return BuildResult(
        positions=positions,
        normals=normals,
        triangle_count=tri_count,
        step=step,
        metrics=metrics,
        faces=faces,
        edges=edges,
        warnings=list(seen),
    )
