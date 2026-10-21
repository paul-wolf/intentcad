"""organic: sculpted, load-path-shaped geometry that stays exact and parametric.

Injected into the script namespace (like auto_round), all exact build123d
B-rep — no meshes, no voxels:

    spoke(a, b, w0, w1, t0, ...)        a tapered, optionally bowed member a→b
    frame(nodes, members, ...)          hubs at nodes joined by spokes, one solid
    window(part, face, outline, r, ...) a rounded pocket / through-cut in a face
    truss_windows(part, face, rim, rib, anchors, corner_r, ...)
                                        automatic lightening of a planar plate

Every dimension is an argument, so a script that takes them from P keeps its
drag handles. Protected faces (a keep list, hole walls — auto_round's rules)
are never cut into: window() refuses, truss_windows() keeps keep_clear away.
auto_round() goes last to blend it all.

Printability: each call warns (never fails) when a member or wall is thinner
than min_wall (the engine passes P.get("min_wall", 2.0)) or a spoke that isn't
flat-bottomed overhangs more than 50° from vertical. Warnings and the other
per-call facts go to the `report` callback; the engine merges them into
result["organic"] next to auto_round's report.

Sketch-plane coordinates (window outlines, 2D anchors) are the world
coordinates projected onto the face's plane: (X, Y) on a face facing ±Z,
(X, Z) on one facing ±Y, (Y, Z) on one facing ±X.
"""

from __future__ import annotations

import math

from build123d import (Box, Compound, Cylinder, Edge, Face, Part, Plane, Polyline, Pos,
                       RectangleRounded, Shape, Solid, Sphere, Vector, Wire, extrude, loft, make_face)
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.BRepOffset import BRepOffset_Analyse
from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeOffset
from OCP.ChFiDS import ChFiDS_Concave
from OCP.GeomAbs import GeomAbs_Arc
from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TopAbs import TopAbs_IN, TopAbs_ON, TopAbs_WIRE
from OCP.TopExp import TopExp_Explorer
from OCP.TopTools import TopTools_ListOfShape
from OCP.TopoDS import TopoDS
from OCP.gp import gp_Dir, gp_Lin, gp_Pnt

from modeling.auto_round import _bed_faces, _is_hole_wall, _keep_faces, _solids_of

__all__ = ["spoke", "frame", "window", "truss_windows"]

_FUZZY = 1e-4          # fuzzy boolean tolerance for frame unions
_STATIONS = 7          # loft cross-sections per spoke
_MAX_OVERHANG = 50.0   # degrees from vertical before a spoke's underside warns
_MIN_WALL = 2.0        # default min_wall when the engine doesn't pass P's


# ── small helpers ────────────────────────────────────────────────────────────

def _v(p) -> Vector:
    """A point as a 3D Vector (2D tuples get Z=0)."""
    if isinstance(p, Vector):
        return p
    p = tuple(float(c) for c in p)
    return Vector(*p) if len(p) == 3 else Vector(p[0], p[1], 0.0)


def _pt(v: Vector) -> list[float]:
    return [round(v.X, 3), round(v.Y, 3), round(v.Z, 3)]


def _warn(rep: dict, kind: str, message: str, at: Vector | None = None):
    rep.setdefault("warnings", []).append(
        {"kind": kind, "message": message, "at": _pt(at) if at is not None else []})


def _is_valid(shape) -> bool:
    try:
        return BRepCheck_Analyzer(shape).IsValid()
    except Exception:
        return False


def _one_solid(shape) -> Solid | None:
    """The shape as a single valid Solid, or None."""
    if shape is None or shape.IsNull() or not _is_valid(shape):
        return None
    solids = _solids_of(shape)
    return Solid(solids[0]) if len(solids) == 1 else None


def _same_kind(part, solids: list):
    """`solids` returned as the kind of shape `part` was."""
    if isinstance(part, Solid) and len(solids) == 1:
        return solids[0]
    if isinstance(part, Part):
        return Part(Compound(solids).wrapped)
    return Compound(solids)


def _resolve_face(part, face) -> Face:
    if callable(face) and not isinstance(face, Shape):
        face = face(part)
    if not isinstance(face, Face):
        faces = list(face) if face is not None else []
        if len(faces) != 1:
            raise ValueError(f"expected one face, got {len(faces)}")
        face = faces[0]
    if face.geom_type.name != "PLANE":
        raise ValueError(f"needs a planar face, got a {face.geom_type.name.lower()} face")
    return face


# ── spoke ────────────────────────────────────────────────────────────────────

def _section(p: Vector, tan: Vector, w: float, t: float, section: str) -> Face:
    """A w × t cross-section centred on p, perpendicular to tan: w across
    (horizontal), t up."""
    tan = tan.normalized()
    side = Vector(0, 0, 1).cross(tan)
    if side.length < 1e-6:                      # a vertical member
        side = Vector(0, 1, 0).cross(tan)
    pl = Plane(origin=p, x_dir=side.normalized(), z_dir=tan)
    if section == "ellipse":
        return Face(Wire([Edge.make_ellipse(w / 2, t / 2, pl)]))
    if section == "rounded_rect":
        return pl.location * RectangleRounded(w, t, 0.3 * min(w, t)).face()
    raise ValueError(f"section must be 'ellipse' or 'rounded_rect', not {section!r}")


def _up(tan: Vector) -> Vector:
    """The section's 'up' axis for a path tangent (see _section)."""
    tan = tan.normalized()
    side = Vector(0, 0, 1).cross(tan)
    if side.length < 1e-6:
        side = Vector(0, 1, 0).cross(tan)
    return tan.cross(side.normalized())


def _above(shape: Shape, z: float) -> Solid:
    """The part of `shape` above the plane Z=z, which becomes an exact planar face."""
    bb = shape.bounding_box()
    if bb.max.Z <= z + 1e-6:
        raise ValueError(f"flat_bottom_z={z:g} is above the whole spoke")
    if bb.min.Z >= z - 1e-6:
        return shape
    size = (bb.max.X - bb.min.X + 2, bb.max.Y - bb.min.Y + 2, bb.max.Z - z + 1)
    box = Pos((bb.min.X + bb.max.X) / 2, (bb.min.Y + bb.max.Y) / 2, z + size[2] / 2) * Box(*size)
    out = _one_solid((shape & box).wrapped)
    if out is None:
        raise ValueError(f"flat_bottom_z={z:g} cuts the spoke apart")
    return out


def _path(a: Vector, b: Vector, bow, bow_dir, overlap):
    """A member's centreline a→b: at(u) → (point, tangent), u in [0, 1] on a
    quadratic Bézier whose midpoint is bowed `bow` mm toward bow_dir (default:
    in the XY plane, to the left of a→b), straight on beyond the ends; and the
    u range [-e0, 1 + e1] that adds `overlap` mm at each end."""
    chord = b - a
    d = None
    if bow:
        d = _v(bow_dir) if bow_dir is not None else Vector(0, 0, 1).cross(chord)
        d = d - chord.normalized() * d.dot(chord.normalized())   # sideways only
        if d.length < 1e-9:
            raise ValueError("bow_dir is along the member")
        d = d.normalized()
    # a quadratic Bézier: its midpoint is the chord's midpoint + bow·d
    ctrl = (a + b) * 0.5 + (d * (2 * float(bow)) if d is not None else Vector(0, 0, 0))

    def at(u: float) -> tuple[Vector, Vector]:
        if u < 0:
            tan = (ctrl - a) * 2
            return a + tan * u, tan
        if u > 1:
            tan = (b - ctrl) * 2
            return b + tan * (u - 1), tan
        p = a * ((1 - u) ** 2) + ctrl * (2 * u * (1 - u)) + b * (u * u)
        return p, (ctrl - a) * (2 * (1 - u)) + (b - ctrl) * (2 * u)

    return at, float(overlap) / ((ctrl - a) * 2).length, float(overlap) / ((b - ctrl) * 2).length


def spoke(a, b, w0, w1, t0, t1=None, bow=0.0, bow_dir=None, section="ellipse",
          flat_bottom_z=None, overlap=1.0, min_wall=None, report=None) -> Solid:
    """A member from point a to point b: width tapering w0→w1 (across, kept
    horizontal), thickness t0→t1 (up; t1 defaults to t0). Straight, or a
    smooth arc whose midpoint is bowed `bow` mm toward bow_dir (default: in
    the XY plane, to the left of a→b). A loft through 7 cross-sections
    ("ellipse", or "rounded_rect" with corners 0.3 × the smaller side), made
    `overlap` mm longer at both ends so unions with hubs leave no slivers.

    flat_bottom_z clips it at that Z: an exact planar underside, so a spoke on
    the bed prints without supports. The clip takes away what's below — a
    spoke centred on the bed plane keeps the upper half of its section (a
    dome t/2 high)."""
    rep: dict = {"warnings": []}
    a, b = _v(a), _v(b)
    w0, w1, t0 = float(w0), float(w1), float(t0)
    t1 = t0 if t1 is None else float(t1)
    if (b - a).length < 1e-6:
        raise ValueError("spoke: a and b are the same point")
    if min(w0, w1, t0, t1) <= 0:
        raise ValueError("spoke: widths and thicknesses must be > 0")

    at, e0, e1 = _path(a, b, bow, bow_dir, overlap)
    sections, stations = [], []
    for k in range(_STATIONS):
        u = -e0 + (1 + e0 + e1) * k / (_STATIONS - 1)
        p, tan = at(u)
        f = min(1.0, max(0.0, u))
        w, t = w0 + (w1 - w0) * f, t0 + (t1 - t0) * f
        sections.append(_section(p, tan, w, t, section))
        stations.append((p, tan, w, t))
    try:
        body = _one_solid(loft(sections).wrapped)
    except Exception as exc:
        raise ValueError(f"spoke: loft failed ({exc})") from exc
    if body is None:
        raise ValueError("spoke: loft gave an invalid solid")
    if flat_bottom_z is not None:
        body = _above(body, float(flat_bottom_z))

    # printability
    mw = _MIN_WALL if min_wall is None else float(min_wall)
    mid = at(0.5)[0]
    heights = []
    for p, tan, _, t in stations:
        up = _up(tan)
        top, bot = p.Z + abs(up.Z) * t / 2, p.Z - abs(up.Z) * t / 2
        if flat_bottom_z is not None:
            bot = max(bot, float(flat_bottom_z))
        heights.append(top - bot)
    thinnest = min(min(w0, w1), min(heights) if flat_bottom_z is not None else min(t0, t1))
    if thinnest < mw - 1e-9:
        _warn(rep, "thin", f"spoke {thinnest:.2g} mm thick/wide, under min_wall {mw:g} mm", mid)
    if flat_bottom_z is None:
        rise = min(math.degrees(math.asin(min(1.0, abs(tan.normalized().Z)))) for _, tan, _, _ in stations)
        if 90 - rise > _MAX_OVERHANG:
            _warn(rep, "overhang", f"spoke underside overhangs {90 - rise:.0f}° from vertical "
                  f"(max {_MAX_OVERHANG:.0f}°): give it flat_bottom_z or support it", mid)
    else:
        fb = float(flat_bottom_z)
        if any(p.Z - abs(_up(tan).Z) * t / 2 > fb + 1e-6 for p, tan, _, t in stations):
            _warn(rep, "overhang", f"spoke lifts off flat_bottom_z={fb:g}; that part of its "
                  "underside overhangs", mid)
    if report is not None:
        report(rep)
    return body


# ── frame ────────────────────────────────────────────────────────────────────

def _fuse(a, b):
    """a ∪ b with a fuzzy boolean, as one valid solid, else None."""
    return _one_solid(_fuse_shapes(a, b))


def _band(a: Vector, b: Vector, w0: float, w1: float, bow: float, overlap: float) -> Face:
    """A member's plan outline on Z=0: the band w0→w1 wide along its (bowed)
    centreline, `overlap` mm longer at both ends — exact B-spline sides."""
    at, e0, e1 = _path(a, b, bow, None, overlap)
    left, right = [], []
    n = 4 * (_STATIONS - 1)
    for k in range(n + 1):
        u = -e0 + (1 + e0 + e1) * k / n
        p, tan = at(u)
        f = min(1.0, max(0.0, u))
        side = Vector(-tan.Y, tan.X, 0).normalized() * ((w0 + (w1 - w0) * f) / 2)
        left.append(p + side)
        right.append(p - side)
    # counter-clockwise (facing +Z, like the hubs): out along the right side, back along the left
    return Face(Wire([Edge.make_spline(right), Edge.make_line(right[-1], left[-1]),
                      Edge.make_spline(left[::-1]), Edge.make_line(left[0], right[0])]))


def _fuse2d(a: Face, b: Face) -> Face | None:
    """a ∪ b as one valid face (fuzzy boolean, coplanar pieces merged), else None."""
    shape = _fuse_shapes(a.wrapped, b.wrapped)
    if shape is None:
        return None
    faces = Compound(shape).faces()
    return faces[0] if len(faces) == 1 and _is_valid(faces[0].wrapped) else None


def _fuse_shapes(a, b):
    op = BRepAlgoAPI_Fuse()
    args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
    args.Append(a)
    tools.Append(b)
    op.SetArguments(args)
    op.SetTools(tools)
    op.SetFuzzyValue(_FUZZY)
    op.SetRunParallel(False)
    try:
        op.Build()
    except Exception:
        return None
    if not op.IsDone():
        return None
    unify = ShapeUpgrade_UnifySameDomain(op.Shape(), True, True, True)
    unify.Build()
    return unify.Shape()


def _blend_joints(body: Solid, r: float, rep: dict) -> Solid:
    """Fillet the vertical inside corners of an extruded plan (where members
    meet hubs and each other) to r: all at once, else one at a time; a corner
    that won't take it stays sharp, with a warning."""
    analyse = BRepOffset_Analyse(body.wrapped, 0.01)
    corners = []
    for e in body.edges():
        if e.geom_type.name != "LINE":
            continue
        d = e @ 1 - e @ 0
        if abs(d.Z) < 1e-6 or Vector(d.X, d.Y, 0).length > 1e-6 * d.length:
            continue                                  # not vertical
        if {iv.Type() for iv in analyse.Type(e.wrapped)} == {ChFiDS_Concave}:
            corners.append(e)
    if not corners or r <= 0:
        return body

    def fillet(shape, edges, radius):
        try:
            mk = BRepFilletAPI_MakeFillet(shape.wrapped)
            for e in edges:
                mk.Add(radius, e.wrapped)
            mk.Build()
            return _one_solid(mk.Shape()) if mk.IsDone() else None
        except Exception:
            return None

    out = fillet(body, corners, r)
    if out is not None:
        return out
    # one at a time; where two members crowd a hub there may be no room for
    # r, so what's left gets half of it
    left = corners
    for radius in (r, r / 2):
        still = []
        for c in left:
            mid = c @ 0.5
            # the corner in the current body (earlier fillets made new edges)
            now = [e for e in body.edges() if e.geom_type.name == "LINE" and (e @ 0.5 - mid).length < 1e-6]
            new = fillet(body, now, radius) if now else None
            if new is None:
                still.append(c)
            else:
                body = new
        if len(still) < len(left) and radius < r:
            _warn(rep, "blend", f"{len(left) - len(still)} crowded joint corner"
                  f"{'s' if len(left) - len(still) > 1 else ''} blended to {radius:g} mm, not {r:g}")
        left = still
    for c in left:
        _warn(rep, "blend", f"a joint corner wouldn't take a {r / 2:g} mm blend; left sharp", c @ 0.5)
    return body


def frame(nodes, members, flat_bottom_z=None, blend=None, section="ellipse", overlap=1.0,
          min_wall=None, report=None) -> Solid:
    """Hubs at `nodes` joined by spokes along `members`, as one solid.

    nodes: {name: (x, y, z, r)} — r the hub radius at that joint.
    members: [(node_a, node_b, w0, w1, t, bow), ...] — width tapering w0 at a
    to w1 at b, thickness t, bowed `bow` mm to the left of a→b (0: straight).

    flat_bottom_z: a frame printed flat on that plane (the nodes' z is
    ignored). It's laid out in plan: each member a tapered, bowed band,
    each hub a circle, joined one at a time; every inside corner where they
    meet is blended to `blend` (default: half the narrowest member width),
    and the outline is extruded up — members their own t high, hubs as high
    as their thickest member. auto_round() then softens the top.
    Otherwise hubs are spheres of radius r at the nodes and members lofted
    spokes (see spoke) centre to centre, `section` across.

    Members are added one at a time (fuzzy boolean, the result checked each
    step); one that fails is reported and left out, never fatal."""
    rep: dict = {"members": 0, "failed": [], "warnings": []}
    sink = lambda r: rep["warnings"].extend(r.get("warnings", []))  # noqa: E731
    nodes = {str(k): tuple(float(c) for c in v) for k, v in dict(nodes).items()}
    if not nodes:
        raise ValueError("frame needs at least one node")
    for k, v in nodes.items():
        if len(v) != 4 or v[3] <= 0:
            raise ValueError(f"frame: node {k!r} must be (x, y, z, r) with r > 0")
    fb = None if flat_bottom_z is None else float(flat_bottom_z)
    mw = _MIN_WALL if min_wall is None else float(min_wall)

    mems = []
    for m in members:
        m = tuple(m)
        a, b = str(m[0]), str(m[1])
        w0, w1, t = (float(x) for x in m[2:5])
        bow = float(m[5]) if len(m) > 5 else 0.0
        mems.append((a, b, w0, w1, t, bow))

    def label(m):
        return f"{m[0]}–{m[1]}"

    def check(m):
        a, b, w0, w1, t, _ = m
        if a not in nodes or b not in nodes:
            raise ValueError(f"no node {a if a not in nodes else b!r}")
        if min(w0, w1, t) <= 0:
            raise ValueError("widths and thickness must be > 0")
        pa, pb = _v(nodes[a][:3]), _v(nodes[b][:3])
        if fb is not None:
            pa, pb = Vector(pa.X, pa.Y, 0), Vector(pb.X, pb.Y, 0)
        if (pb - pa).length < 1e-6:
            raise ValueError("its nodes are at the same place")
        return pa, pb

    # the members in the order they join on: breadth-first from the first node
    first = next(iter(nodes))
    order, attached, pending = [], {first}, []
    for m in mems:
        try:
            check(m)
            pending.append(m)
        except ValueError as exc:
            rep["failed"].append(f"{label(m)}: {exc}")
    progress = True
    while pending and progress:
        progress = False
        for m in list(pending):
            if m[0] in attached or m[1] in attached:
                pending.remove(m)
                order.append(m)
                attached |= {m[0], m[1]}
                progress = True
    for m in pending:
        rep["failed"].append(f"{label(m)}: not connected to the rest of the frame")

    if fb is None:
        out = _frame_3d(nodes, order, first, section, overlap, mw, sink, rep, label)
    else:
        out = _frame_flat(nodes, order, first, fb, blend, overlap, mw, rep, label, check)
    if report is not None:
        report(rep)
    return out


def _frame_3d(nodes, order, first, section, overlap, mw, sink, rep, label) -> Solid:
    def hub(name):
        x, y, z, r = nodes[name]
        return (Pos(x, y, z) * Sphere(r)).wrapped

    body = _one_solid(hub(first))
    if body is None:
        raise ValueError(f"frame: hub {first!r} is not a valid solid")
    body, have = body.wrapped, {first}
    for m in order:
        a, b, w0, w1, t, bow = m
        try:
            s = spoke(nodes[a][:3], nodes[b][:3], w0, w1, t, bow=bow, section=section,
                      overlap=overlap, min_wall=mw, report=sink)
        except Exception as exc:
            rep["failed"].append(f"{label(m)}: {exc}")
            continue
        new = _fuse(body, s.wrapped)
        if new is None:
            rep["failed"].append(f"{label(m)}: the union failed")
            continue
        body = new.wrapped
        rep["members"] += 1
        for n in (a, b):
            if n in have:
                continue
            with_hub = _fuse(body, hub(n))
            if with_hub is None:
                rep["failed"].append(f"hub {n}: the union failed")
            else:
                body = with_hub.wrapped
            have.add(n)
    unify = ShapeUpgrade_UnifySameDomain(body, True, True, True)
    unify.Build()
    return _one_solid(unify.Shape()) or Solid(_solids_of(body)[0])


def _frame_flat(nodes, order, first, fb, blend, overlap, mw, rep, label, check) -> Solid:
    def disk(name):
        x, y, _, r = nodes[name]
        return Pos(x, y) * Face(Wire([Edge.make_circle(r)]))

    # join the plan outline one member at a time, checking each step
    plan, have, joined = disk(first), {first}, []
    for m in order:
        a, b, w0, w1, t, bow = m
        try:
            pa, pb = check(m)
            piece = _band(pa, pb, w0, w1, bow, overlap)
        except Exception as exc:
            rep["failed"].append(f"{label(m)}: {exc}")
            continue
        new = _fuse2d(plan, piece)
        for n in (a, b):
            if new is not None and n not in have:
                new = _fuse2d(new, disk(n))
        if new is None:
            rep["failed"].append(f"{label(m)}: the union failed")
            continue
        plan = new
        have |= {a, b}
        joined.append((m, piece))
        rep["members"] += 1
        if min(w0, w1, t) < mw - 1e-9:
            mid = (pa + pb) * 0.5
            _warn(rep, "thin", f"member {label(m)} {min(w0, w1, t):.2g} mm thick/wide, "
                  f"under min_wall {mw:g} mm", Vector(mid.X, mid.Y, fb + t / 2))

    widths = [w for (m, _) in joined for w in m[2:4]]
    r = (min(widths) / 2 if widths else 0.0) if blend is None else float(blend)

    # heights: a member its own t, a hub its thickest member's (a lone hub: r)
    hub_h = {n: 0.0 for n in have}
    for (a, b, _, _, t, _), _ in joined:
        hub_h[a], hub_h[b] = max(hub_h[a], t), max(hub_h[b], t)
    if not joined:
        hub_h[first] = nodes[first][3]
    levels = sorted(set(hub_h.values()) | {m[4] for m, _ in joined})
    # one prism per height: the whole plan up to the lowest, then what's at
    # least each higher level high (terraces), each with its joints blended
    body = _blend_joints(_prism(plan, fb, levels[0]), r, rep)
    for h in levels[1:]:
        parts = [p for m, p in joined if m[4] >= h - 1e-9] + [disk(n) for n, hh in hub_h.items() if hh >= h - 1e-9]
        acc = parts[0]
        for p in parts[1:]:
            acc = _fuse2d(acc, p) or acc
        new = _fuse(body.wrapped, _blend_joints(_prism(acc, fb, h), r, rep).wrapped)
        if new is None:
            _warn(rep, "blend", f"couldn't raise the {h:g} mm high members; left at {levels[0]:g} mm")
        else:
            body = new
    return body


def _prism(face: Face, z: float, h: float) -> Solid:
    """face (on Z=0) extruded from Z=z up h, coplanar faces merged."""
    body = extrude(Pos(0, 0, z) * face, h)
    unify = ShapeUpgrade_UnifySameDomain(body.wrapped, True, True, True)
    unify.Build()
    return _one_solid(unify.Shape()) or Solid(_solids_of(body.wrapped)[0])


# ── 2D on a face's plane ─────────────────────────────────────────────────────

def _plane_of(face: Face) -> Plane:
    """The sketch plane of a planar face (see the module doc for its axes)."""
    n = face.normal_at(face.center())
    comps = (abs(n.X), abs(n.Y), abs(n.Z))
    ax = comps.index(max(comps))
    cz, cx = {2: ((0, 0, 1), (1, 0, 0)), 1: ((0, -1, 0), (1, 0, 0)), 0: ((1, 0, 0), (0, 1, 0))}[ax]
    z = n if n.dot(Vector(*cz)) > 0 else -n
    x = Vector(*cx)
    x = (x - z * x.dot(z)).normalized()
    return Plane(origin=z * face.center().dot(z), x_dir=x, z_dir=z)


def _flat(face: Face) -> Face:
    """A local-coordinates face moved onto Z=0."""
    return Pos(0, 0, -face.center().Z) * face


def _local(pl: Plane, shape):
    return pl.to_local_coords(shape)


def _wires(shape) -> list[Wire]:
    out, ex = [], TopExp_Explorer(shape, TopAbs_WIRE)
    while ex.More():
        out.append(Wire(TopoDS.Wire_s(ex.Current())))
        ex.Next()
    return out


def _inside(face: Face, p: Vector) -> bool:
    return BRepClass_FaceClassifier(face.wrapped, gp_Pnt(p.X, p.Y, p.Z), 1e-7).State() in (TopAbs_IN, TopAbs_ON)


def _offset(face: Face, d: float) -> list[Face]:
    """A planar face offset by d (arc joins; d < 0 shrinks the material, so
    holes grow). Whatever's left as faces — none when it vanishes, several
    when a narrow neck pinches off."""
    try:
        mk = BRepOffsetAPI_MakeOffset(face.wrapped, GeomAbs_Arc)
        mk.Perform(d)
        if not mk.IsDone():
            return []
        shape = mk.Shape()
    except Exception:
        return []
    faces = []
    for w in _wires(shape):
        try:
            f = make_face(w).faces()[0]
        except Exception:
            continue
        if f.area > 1e-9:
            faces.append(f)
    # nest them: a wire inside a bigger one is a hole in it
    faces.sort(key=lambda f: -f.area)
    outers: list[list] = []
    for f in faces:
        q = f.outer_wire().edges()[0] @ 0.5
        host = next((o for o in outers if _inside(o[0], q)), None)
        if host is None:
            outers.append([f, []])
        else:
            host[1].append(f)
    out = []
    for o, holes in outers:
        out += (o - holes).faces() if holes else [o]
    return out


def _union2d(faces: list[Face]):
    """The union of 2D faces, or None for none."""
    if not faces:
        return None
    acc = faces[0]
    for f in faces[1:]:
        acc = acc + f
    return acc


def _strip(p: Vector, q: Vector, width: float) -> Face | None:
    d = q - p
    if d.length < 1e-6:
        return None
    s = Vector(-d.Y, d.X, 0).normalized() * (width / 2)
    return make_face(Polyline(p + s, q + s, q - s, p - s, close=True)).faces()[0]


def _round_corners(face: Face, r: float) -> list[Face]:
    """The face with its convex corners rounded to r (offset in, then out):
    nothing if it's nowhere 2r wide."""
    out = []
    for inner in _offset(face, -r):
        out += _offset(inner, r)
    return out


def _thickness_at(part, pl: Plane, face: Face, pts2d: list[Vector]) -> float:
    """Material depth under the face (against its outward normal) — the
    median over the sample points that lie on it."""
    n = face.normal_at(face.center())
    hits = IntCurvesFace_ShapeIntersector()
    hits.Load(part.wrapped, 1e-7)
    depths = []
    for q in pts2d:
        p = pl.from_local_coords(Vector(q.X, q.Y, 0))
        if not _inside(face, p):
            continue
        start = p - n * 1e-4
        hits.Perform(gp_Lin(gp_Pnt(start.X, start.Y, start.Z), gp_Dir(-n.X, -n.Y, -n.Z)), 1e-6, 1e12)
        ws = [hits.WParameter(i) for i in range(1, hits.NbPnt() + 1)]
        if ws:
            depths.append(min(ws) + 1e-4)
    if not depths:
        raise ValueError("couldn't measure the material under the face")
    depths.sort()
    return depths[len(depths) // 2]


def _grid(face2d: Face, n: int = 7) -> list[Vector]:
    bb = face2d.bounding_box()
    pts = [face2d.center()]
    for i in range(1, n):
        for j in range(1, n):
            pts.append(Vector(bb.min.X + (bb.max.X - bb.min.X) * i / n,
                              bb.min.Y + (bb.max.Y - bb.min.Y) * j / n, 0))
    return pts


def _protected(part, keep, keep_bed: bool, protect_holes: bool, hole_max_r: float,
               bed=None) -> list[Face]:
    """auto_round's protected faces: keep, the bed, small hole walls."""
    prot = list(_keep_faces(part, keep))
    if keep_bed:
        prot += _bed_faces(part, bed)
    if protect_holes:
        prot += [f for f in part.faces() if _is_hole_wall(f, hole_max_r)]
    return prot


def _cut(part_shape, tools: list, guard: list):
    """part − tools as one boolean; the result's solids, unless it fails or
    changes a guard face (then None)."""
    op = BRepAlgoAPI_Cut()
    args, tl = TopTools_ListOfShape(), TopTools_ListOfShape()
    args.Append(part_shape)
    for t in tools:
        tl.Append(t)
    op.SetArguments(args)
    op.SetTools(tl)
    op.SetRunParallel(False)
    try:
        op.Build()
    except Exception:
        return None, "failed"
    if not op.IsDone():
        return None, "failed"
    for f in guard:
        if op.IsDeleted(f.wrapped) or op.Modified(f.wrapped).Extent() > 0:
            return None, "protected"
    shape = op.Shape()
    if not _is_valid(shape) or not _solids_of(shape):
        return None, "failed"
    return shape, None


def _tool(pl: Plane, f2d: Face, n: Vector, start: float, length: float):
    """The 2D face f2d swept from `start` mm outside the face plane, `length`
    mm into the material (against the outward normal n)."""
    f3d = pl.location * f2d
    f3d = Pos(*(n * start)) * f3d
    return extrude(f3d, amount=length, dir=-n).wrapped


# ── window ───────────────────────────────────────────────────────────────────

def window(part, face, outline, corner_r, depth=None, keep=(), protect_holes=True,
           hole_max_r=6.0, min_wall=None, report=None):
    """Cut a window in a planar face: `outline` (2D points in the face's sketch
    plane — see the module doc) with its corners rounded to corner_r, as a
    pocket `depth` deep, or through the part when depth is None. Refuses to
    cut into a protected face (keep, small hole walls)."""
    rep: dict = {"windows": 0, "warnings": []}
    face = _resolve_face(part, face)
    pl = _plane_of(face)
    n = face.normal_at(face.center())
    pts = [Vector(float(p[0]), float(p[1]), 0) for p in outline]
    if len(pts) < 3:
        raise ValueError("window: the outline needs at least 3 points")
    shape2d = make_face(Polyline(*pts, close=True)).faces()[0]
    r = float(corner_r)
    rounded = None
    if r > 0:
        try:
            rounded = [shape2d.fillet_2d(r, shape2d.vertices())]
        except Exception:
            rounded = _round_corners(shape2d, r)
        if not rounded:
            raise ValueError(f"window: the outline is nowhere {2 * r:g} mm wide (corner_r={r:g})")
    else:
        rounded = [shape2d]

    bb = part.bounding_box()
    extent = (bb.max - bb.min).length + 2
    length = extent if depth is None else float(depth) + 1.0
    tools = [_tool(pl, f, n, 1.0, length) for f in rounded]
    guard = [f for f in _protected(part, keep, False, protect_holes, hole_max_r)
             if not f.wrapped.IsSame(face.wrapped)]
    if any(f.wrapped.IsSame(face.wrapped) for f in _keep_faces(part, keep)):
        raise ValueError("window: that face is protected (in keep)")
    shape, why = _cut(part.wrapped, tools, guard)
    if shape is None:
        raise ValueError("window: it would cut into a protected face" if why == "protected"
                         else "window: the cut failed")
    rep["windows"] = len(rounded)
    if depth is not None:
        mw = _MIN_WALL if min_wall is None else float(min_wall)
        try:
            t = _thickness_at(part, pl, face, [rounded[0].center()])
            floor = t - float(depth)
            if 0 < floor < mw - 1e-9:
                _warn(rep, "thin", f"window floor {floor:.2g} mm, under min_wall {mw:g} mm",
                      pl.from_local_coords(rounded[0].center()))
        except ValueError:
            pass
    if report is not None:
        report(rep)
    return _same_kind(part, [Solid(s) for s in _solids_of(shape)])


# ── truss_windows ────────────────────────────────────────────────────────────

def _delaunay_edges(pts: list[Vector]) -> list[tuple[int, int]]:
    from scipy.spatial import Delaunay
    tri = Delaunay([(p.X, p.Y) for p in pts])
    edges = set()
    for s in tri.simplices:
        for i in range(3):
            a, b = int(s[i]), int(s[(i + 1) % 3])
            edges.add((min(a, b), max(a, b)))
    return sorted(edges)


def _hull_face(pts: list[Vector], grow: float) -> list[Face]:
    """The convex hull of 2D points grown by `grow` (a strip or a disk when
    they're collinear or one point)."""
    from scipy.spatial import ConvexHull
    uniq = []
    for p in pts:
        if all((p - q).length > 1e-6 for q in uniq):
            uniq.append(p)
    if len(uniq) >= 3:
        try:
            h = ConvexHull([(p.X, p.Y) for p in uniq])
            ring = [uniq[i] for i in h.vertices]
            base = make_face(Polyline(*ring, close=True)).faces()[0]
            return _offset(base, grow)
        except Exception:
            pass
    # degenerate: the longest segment through them, or a point
    far = max(((p, q) for p in uniq for q in uniq), key=lambda pq: (pq[0] - pq[1]).length)
    s = _strip(far[0], far[1], 1e-3)
    if s is None:
        from build123d import Circle
        return [Pos(uniq[0].X, uniq[0].Y) * Circle(grow).face()]
    return _offset(s, grow)


def _footprints(part, pl: Plane, T: float) -> list[Face]:
    """2D outlines of whatever material touches the plate from outside: thin
    slabs just above its face and just below its far side, intersected with
    the part. The plate itself isn't in them."""
    loc = _local(pl, part)
    bb = loc.bounding_box()
    out = []
    for z0, z1 in ((0.02, 0.6), (-T - 0.6, -T - 0.02)):
        sx, sy = bb.max.X - bb.min.X + 2, bb.max.Y - bb.min.Y + 2
        slab = Pos((bb.min.X + bb.max.X) / 2, (bb.min.Y + bb.max.Y) / 2, (z0 + z1) / 2) * Box(sx, sy, z1 - z0)
        try:
            hit = loc & slab
        except Exception:
            continue
        for f in hit.faces():
            if f.geom_type.name == "PLANE" and abs(abs(f.normal_at(f.center()).Z) - 1) < 1e-6 \
                    and abs(f.center().Z - z0) < 1e-6:
                out.append(_flat(f))
    return out


def truss_windows(part, face, rim, rib, anchors, corner_r, keep_clear=3.0, pattern="fan",
                  max_span=None, keep=(), keep_bed=True, protect_holes=True, hole_max_r=6.0,
                  min_wall=None, report=None, bed=None):
    """Lighten a planar plate: windows through it, separated by ribs.

    The window area is the face's outline inset by `rim`, minus rib strips
    `rib` wide — "fan": from each anchor to every outline vertex;
    "triangulate": the Delaunay edges over anchors + outline vertices — minus
    everything within keep_clear of a protected face (keep, the bed, small
    hole walls — auto_round's rules), a hole in the face, or material standing
    on the plate (a boss, a tab, a wall); holes keep at least `rim` around
    them. Window corners are rounded to corner_r, and windows narrower than
    2·corner_r are dropped. anchors: 2D sketch-plane points or 3D points.
    max_span: outline edges longer than this get extra rib ends spaced along
    them, so no window spans much more than that along the rim.

    Windows go through the plate only (its thickness under the face), not
    through what's beyond it. Reports windows cut, those dropped and why,
    and the volume removed in %."""
    rep: dict = {"windows": 0, "dropped": [], "removed_pct": 0.0, "warnings": []}
    face = _resolve_face(part, face)
    pl = _plane_of(face)
    n = face.normal_at(face.center())
    rim, rib, r, clear = float(rim), float(rib), float(corner_r), float(keep_clear)
    if pattern not in ("fan", "triangulate"):
        raise ValueError(f"pattern must be 'fan' or 'triangulate', not {pattern!r}")

    f2d = _flat(_local(pl, face))
    outer = make_face(f2d.outer_wire()).faces()[0]
    holes = [make_face(w).faces()[0] for w in f2d.inner_wires()]
    T = _thickness_at(part, pl, face, _grid(f2d))

    # where windows may go
    region = _offset(outer, -rim)
    blocked: list[Face] = []
    for h in holes:
        blocked += _offset(h, max(rim, clear))
    for fp in _footprints(part, pl, T):
        blocked += _offset(fp, clear)
    for pf in _protected(part, keep, keep_bed, protect_holes, hole_max_r, bed):
        pts = [pl.to_local_coords(v.center()) for v in pf.vertices()]
        for e in pf.edges():
            pts += [pl.to_local_coords(e @ (i / 6)) for i in range(7)]
        zs = [p.Z for p in pts]
        if max(zs) < -T - clear or min(zs) > clear:
            continue                                  # nowhere near the plate
        flat = pf.geom_type.name == "PLANE" \
            and abs(abs(pf.normal_at(pf.center()).dot(pl.z_dir)) - 1) < 1e-6
        if flat and (max(abs(z) for z in zs) < 1e-6 or max(abs(z + T) for z in zs) < 1e-6):
            continue                                  # the plate's own face / far side
        blocked += _hull_face([Vector(p.X, p.Y, 0) for p in pts], clear)

    # ribs
    verts = [Vector(v.X, v.Y, 0) for v in outer.vertices()]
    if max_span:                                      # more rib ends along long edges
        for e in outer.edges():
            k = int(e.length // float(max_span))
            verts += [Vector((e @ (i / (k + 1))).X, (e @ (i / (k + 1))).Y, 0) for i in range(1, k + 1)]
    anc = []
    for a in anchors:
        a = tuple(float(c) for c in a)
        p = pl.to_local_coords(Vector(*a)) if len(a) == 3 else Vector(a[0], a[1], 0)
        anc.append(Vector(p.X, p.Y, 0))
    if pattern == "fan":
        segs = [(p, q) for p in anc for q in verts]
    else:
        pts = anc + verts
        segs = [(pts[i], pts[j]) for i, j in _delaunay_edges(pts)]
    blocked += [s for s in (_strip(p, q, rib) for p, q in segs) if s is not None]

    # the windows: what's left, corners rounded, too-narrow ones dropped
    cuts = _union2d(blocked)
    windows: list[Face] = []
    for reg in region:
        left = (reg - cuts).faces() if cuts is not None else [reg]
        for w in left:
            if w.area < 1e-2:
                continue                              # a sliver where ribs meet the rim
            rounded = _round_corners(w, r) if r > 0 else [w]
            if not rounded:
                rep["dropped"].append({"reason": "small", "at": _pt(pl.from_local_coords(w.center()))})
            windows += rounded

    # cut them, all at once, else one by one
    guard = [f for f in _protected(part, keep, False, protect_holes, hole_max_r)]
    v0 = part.volume
    tools = [_tool(pl, w, n, 0.5, T + 1.0) for w in windows]
    shape = None
    if tools:
        shape, _ = _cut(part.wrapped, tools, guard)
    if shape is not None:
        rep["windows"] = len(windows)
    else:
        shape = part.wrapped
        for w, t in zip(windows, tools):
            new, why = _cut(shape, [t], guard)
            if new is None:
                rep["dropped"].append({"reason": why, "at": _pt(pl.from_local_coords(w.center()))})
            else:
                shape = new
                rep["windows"] += 1
    out = _same_kind(part, [Solid(s) for s in _solids_of(shape)])
    rep["removed_pct"] = round(100 * (1 - out.volume / v0), 2) if v0 > 0 else 0.0

    mw = _MIN_WALL if min_wall is None else float(min_wall)
    for name, val in (("rib", rib), ("rim", rim), ("plate", T)):
        if val < mw - 1e-9:
            _warn(rep, "thin", f"{name} {val:.2g} mm, under min_wall {mw:g} mm",
                  pl.from_local_coords(f2d.center()))
    if report is not None:
        report(rep)
    return out


# ── engine hook ──────────────────────────────────────────────────────────────

def bind(sink, min_wall, bed=None) -> dict:
    """The script-namespace versions: every call reports to `sink`, and
    min_wall comes from min_wall() (the script's P) unless passed; `bed`
    (the print bed face's outward normal) is truss_windows' bed unless passed."""
    from modeling.edge_ref import _script_line

    def wrap(fn):
        def call(*args, **kwargs):
            kwargs.pop("report", None)
            kwargs.setdefault("min_wall", min_wall())
            if fn is truss_windows and bed is not None:
                kwargs.setdefault("bed", bed)
            line = _script_line()
            return fn(*args, report=lambda r: sink({"op": fn.__name__, "line": line, **r}), **kwargs)
        call.__name__ = fn.__name__
        call.__doc__ = fn.__doc__
        return call
    return {f.__name__: wrap(f) for f in (spoke, frame, window, truss_windows)}


def merge(events: list[dict]) -> dict:
    """One report for a script's organic calls."""
    out = {"members": 0, "failed_members": [], "windows": 0, "dropped": [],
           "removed_pct": None, "warnings": []}
    keep = 1.0
    seen = set()
    for e in events:
        out["members"] += e.get("members", 0)
        out["failed_members"] += e.get("failed", [])
        out["windows"] += e.get("windows", 0)
        out["dropped"] += e.get("dropped", [])
        if e.get("op") == "truss_windows":
            keep *= 1 - e.get("removed_pct", 0.0) / 100
            out["removed_pct"] = round(100 * (1 - keep), 2)
        for w in e.get("warnings", []):
            key = (w["kind"], w["message"])
            if key not in seen:
                seen.add(key)
                out["warnings"].append({**w, "line": e.get("line")})
    return out
