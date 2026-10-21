"""linear(), circular(), pattern_body() and patterned(): the part editor's
Pattern operations.

    part = pattern_body(part, linear("X", 4, spacing=P["foot_pitch"]), join=True)
    part -= patterned(extrude(sketch("Vent"), amount=-P["vent_depth"]),
                      linear("X", P["vent_count"], spacing=P["vent_pitch"], dir2="Y", count2=3, spacing2=8,
                             skip=[9, 14]))  # pattern of line 7
    part = holes(part, at=patterned(sketch_points("Boss"), circular(face_ref({...}), 6)), ...)  # pattern of line 8
    part = fillet(part, patterned(edges_ref([...]), linear("Y", 3, extent=40)), radius=P["fillet_r"])  # pattern of line 9

A pattern is a list of instances, each a rigid motion of the original;
instance 0 is the original itself (no motion), and `skip` leaves instances
out (never 0). Their order, which `skip` numbers:

  linear, one direction: i·spacing for i = 0 .. count-1; symmetric adds
    -1 .. -(count-1) after them (count each way, the original shared);
  linear, two directions: i + j·n1, n1 the number along the first;
  circular: k·step, step = 360/count round a full circle (angle 360: no
    copy on top of the original; symmetric does nothing), else
    angle/(count-1); symmetric adds -1 .. -(count-1) after them.

`extent` instead of `spacing` fits the count evenly within that distance
(each way, when symmetric); `angle` is the span (each way, when symmetric).
`flip` reverses a direction (or the way round).

A direction (linear) or axis (circular) is "X" / "Y" / "Z" (through the
origin), a straight edge (edge_ref: its direction; for circular, the edge as
the axis), a circular edge or a cylindrical face (its centre axis: bolt
circles round a hole) or a flat face (its normal through its centre). They
are found on the part as it is when the line runs, so a pattern follows the
part. count, spacing, extent and angle may be numbers or P expressions.

pattern_body() copies the whole part: join=True fuses the copies with it in
one boolean, join=False keeps each as a separate body.

patterned() copies one step's input, without the original (that is the step
itself): a solid (an extrude; `part -= patterned(...)` cuts every copy in
one boolean), sketch_points() and face / edge references (moved, then found
again on the part as it is when the line runs).

A copy the editor writes carries a link comment, `# pattern of line N`,
naming the step it copies (modeling/paramedit.py keeps it in step).
"""

from __future__ import annotations

import math

from build123d import Axis, Compound, Edge, Face, GeomType, Location, Part, Plane, Shape, ShapeList, Vector
from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

from modeling import edge_ref as edge_ref_mod
from modeling import face_ref as face_ref_mod
from modeling.edge_ref import _script_line
from modeling.mirror import Refs, _r, _vec, map_edge, map_face
from modeling.planes import _adjacent
from modeling.sketch_profile import Points
from modeling.until import UntilExtrude

# the most instances a pattern makes (a typo'd count shouldn't hang the build)
MAX_INSTANCES = 1000
AXES = {"X": Vector(1, 0, 0), "Y": Vector(0, 1, 0), "Z": Vector(0, 0, 1)}


class PatternError(ValueError):
    pass


def _canon(d: Vector) -> Vector:
    """`d` (a unit vector) pointing the way its largest component is positive,
    so an edge's direction doesn't turn round with the edge's orientation."""
    big = max((d.X, d.Y, d.Z), key=abs)
    return d * (-1.0 if big < 0 else 1.0)


def _cyl_axis(face: Face) -> tuple[Vector, Vector] | None:
    """(a point on the axis level with the face's centre, axis) of a
    cylindrical or conical face, else None."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder

    s = BRepAdaptor_Surface(face.wrapped)
    t = s.GetType()
    if t not in (GeomAbs_Cylinder, GeomAbs_Cone):
        return None
    ax = (s.Cylinder() if t == GeomAbs_Cylinder else s.Cone()).Axis()
    p, d = ax.Location(), ax.Direction()
    o, n = Vector(p.X(), p.Y(), p.Z()), Vector(d.X(), d.Y(), d.Z()).normalized()
    c = face.center()
    return o + n * (c - o).dot(n), _canon(n)


def resolve_axis(ref, what: str = "direction") -> tuple[Vector, Vector]:
    """(origin, unit direction) of a pattern's direction or axis: "X" / "Y" /
    "Z", a straight edge, a circular edge, a cylindrical face, a flat face,
    a Plane (its normal) or an Axis."""
    if isinstance(ref, str):
        key = ref.strip().upper()
        if key not in AXES:
            raise PatternError(f"a pattern {what} is X, Y, Z, an edge or a face, not {ref!r}")
        return Vector(0, 0, 0), AXES[key]
    if isinstance(ref, Axis):
        return Vector(ref.position), Vector(ref.direction).normalized()
    if isinstance(ref, Plane):
        return Vector(ref.origin), Vector(ref.z_dir).normalized()
    if isinstance(ref, Edge):
        if ref.geom_type == GeomType.LINE:
            return ref.position_at(0), _canon(ref.tangent_at(0).normalized())
        if ref.geom_type == GeomType.CIRCLE:
            return Vector(ref.arc_center), _canon(Vector(ref.normal()).normalized())
        raise PatternError(f"a pattern {what} along an edge needs a straight or circular edge "
                           f"(this one is a {ref.geom_type.name.lower()})")
    if isinstance(ref, Face):
        if ref.geom_type == GeomType.PLANE:
            c = ref.center()
            return c, ref.normal_at(c).normalized()
        ax = _cyl_axis(ref)
        if ax is not None:
            return ax
        raise PatternError(f"a pattern {what} from a face needs a flat or a cylindrical face "
                           f"(this one is a {ref.geom_type.name.lower()})")
    raise PatternError(f"a pattern {what} is X, Y, Z, an edge (edge_ref) or a face (face_ref), "
                       f"not {type(ref).__name__}")


def _count(v, what: str) -> int:
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        raise PatternError(f"the {what} must be a number (got {v!r})") from None
    if n < 1:
        raise PatternError(f"the {what} must be at least 1 (got {n})")
    return n


def _steps(count: int, symmetric: bool) -> list[int]:
    """The multiples of the spacing (or step angle) of one direction's
    instances, in index order: 0, 1 .. count-1 (then -1 .. -(count-1))."""
    out = list(range(count))
    if symmetric:
        out += [-k for k in range(1, count)]
    return out


def _pitch(count: int, spacing, extent, what: str) -> float:
    """The spacing of one direction: given, or `extent` shared out evenly."""
    if spacing is not None and extent is not None:
        raise PatternError(f"give the {what} spacing or its extent, not both")
    if extent is not None:
        return float(extent) / (count - 1) if count > 1 else 0.0
    if spacing is None:
        if count > 1:
            raise PatternError(f"give the {what} spacing (or its extent)")
        return 0.0
    return float(spacing)


class Pattern:
    """A pattern's instances: [(index, gp_Trsf)] in index order, the first
    the original (identity); `skip` the indices left out. `info` describes it
    for the editor's preview (directions, spacings, the axis)."""

    def __init__(self, kind: str, motions: list[gp_Trsf], skip, info: dict):
        if len(motions) > MAX_INSTANCES:
            raise PatternError(f"a pattern of {len(motions)} instances is too many (at most {MAX_INSTANCES})")
        self.kind, self.motions, self.info = kind, motions, info
        bad = [s for s in skip or () if not isinstance(s, (int, float)) or isinstance(s, bool)]
        if bad:
            raise PatternError(f"skip lists instance numbers, not {bad[0]!r}")
        self.skip = sorted({int(s) for s in skip or ()})
        if 0 in self.skip:
            raise PatternError("instance 0 is the original: it can't be skipped")

    def copies(self) -> list[tuple[int, gp_Trsf]]:
        """The instances made, without the original."""
        skip = set(self.skip)
        return [(i, t) for i, t in enumerate(self.motions) if i and i not in skip]

    def __len__(self) -> int:
        return len(self.motions)

    def __repr__(self) -> str:
        return f"<{self.kind} pattern of {len(self.motions)}, skip {self.skip}>"


def _move(v: Vector) -> gp_Trsf:
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(v.X, v.Y, v.Z))
    return t


def linear(dir, count, spacing=None, extent=None, symmetric: bool = False, flip: bool = False,
           dir2=None, count2=1, spacing2=None, extent2=None, flip2: bool = False, skip=()) -> Pattern:
    """`count` instances along `dir`, `spacing` apart (or fitted evenly within
    `extent`); symmetric: as many again the other way. With `dir2`, a grid:
    `count2` rows of them along it."""
    n1 = _count(count, "count")
    _, d1 = resolve_axis(dir)
    d1 = d1 * (-1.0 if flip else 1.0)
    s1 = _pitch(n1, spacing, extent, "first direction's")
    a = _steps(n1, symmetric)
    if dir2 is not None:
        n2 = _count(count2, "second count")
        _, d2 = resolve_axis(dir2, "second direction")
        d2 = d2 * (-1.0 if flip2 else 1.0)
        if abs(d1.dot(d2)) > 0.999:
            raise PatternError("the two pattern directions are the same: pick a second direction across the first")
        s2 = _pitch(n2, spacing2, extent2, "second direction's")
        b = _steps(n2, symmetric)
    else:
        n2, d2, s2, b = 1, None, 0.0, [0]
    if len(a) * len(b) > MAX_INSTANCES:
        raise PatternError(f"a pattern of {len(a) * len(b)} instances is too many (at most {MAX_INSTANCES})")
    motions = [_move(d1 * (i * s1) + (d2 * (j * s2) if d2 is not None else Vector())) for j in b for i in a]
    info = {"dir": _r(d1, 4), "spacing": s1, "count": n1, "n1": len(a), "symmetric": bool(symmetric)}
    if d2 is not None:
        info.update({"dir2": _r(d2, 4), "spacing2": s2, "count2": n2})
    return Pattern("linear", motions, skip, info)


def circular(axis, count, angle=360, symmetric: bool = False, flip: bool = False, skip=()) -> Pattern:
    """`count` instances round `axis`: spread evenly round the full circle
    (angle 360), else spanning `angle` (each way, when symmetric)."""
    n = _count(count, "count")
    o, d = resolve_axis(axis, "axis")
    d = d * (-1.0 if flip else 1.0)
    span = float(angle)
    full = abs(abs(span) - 360) < 1e-9
    if full:
        step, ks = 360.0 / n, list(range(n))
    else:
        step, ks = (span / (n - 1) if n > 1 else 0.0), _steps(n, symmetric)
    ax = gp_Ax1(gp_Pnt(o.X, o.Y, o.Z), gp_Dir(d.X, d.Y, d.Z))
    motions = []
    for k in ks:
        t = gp_Trsf()
        t.SetRotation(ax, math.radians(k * step))
        motions.append(t)
    info = {"origin": _r(o), "axis": _r(d, 4), "step": step, "count": n, "angle": span,
            "full": full, "symmetric": bool(symmetric) and not full}
    return Pattern("circular", motions, skip, info)


def _p(t: gp_Trsf, v: Vector) -> Vector:
    p = gp_Pnt(v.X, v.Y, v.Z).Transformed(t)
    return Vector(p.X(), p.Y(), p.Z())


def _d(t: gp_Trsf, v: Vector) -> Vector:
    p = gp_Vec(v.X, v.Y, v.Z).Transformed(t)
    return Vector(p.X(), p.Y(), p.Z())


def _corners(lo: Vector, hi: Vector) -> list[Vector]:
    return [Vector(x, y, z) for x in (lo.X, hi.X) for y in (lo.Y, hi.Y) for z in (lo.Z, hi.Z)]


def _seed_box(obj, part) -> tuple[Vector, Vector] | None:
    """Roughly where the thing patterned is, as a box (the preview draws one
    per instance); None when it can't tell."""
    pad = Vector(0.5, 0.5, 0.5)
    pts: list[Vector] = []
    if isinstance(obj, Refs):
        refs = obj.data if obj.kind == "edges" else [obj.data]
        for r in refs or []:
            if not isinstance(r, dict):
                continue
            if r.get("kind") == "circle" and r.get("center") and r.get("radius"):
                c, rad = _vec(r["center"]), float(r["radius"])
                pts += [c - Vector(rad, rad, rad), c + Vector(rad, rad, rad)]
            elif r.get("midpoint"):
                m = _vec(r["midpoint"])
                half = _vec(r["direction"]) * (float(r.get("length") or 0) / 2) if r.get("direction") else Vector()
                pts += [m - half, m + half]
            elif r.get("center"):
                pts.append(_vec(r["center"]))
        pad = Vector(1, 1, 1)
    elif isinstance(obj, Points):
        pts = [Vector(p) for p in obj]
        pad = Vector(1.5, 1.5, 1.5)
    elif isinstance(obj, Shape):
        bb = obj.bounding_box()
        return Vector(bb.min), Vector(bb.max)
    elif isinstance(obj, (list, tuple)) and obj and all(isinstance(x, Shape) for x in obj):
        bb = Compound(list(obj)).bounding_box()
        return Vector(bb.min), Vector(bb.max)
    if not pts:
        return None
    lo = Vector(min(p.X for p in pts), min(p.Y for p in pts), min(p.Z for p in pts)) - pad
    hi = Vector(max(p.X for p in pts), max(p.Y for p in pts), max(p.Z for p in pts)) + pad
    return lo, hi


def _report(report: list | None, pat: Pattern, box, what: str) -> None:
    """result["patterns"]: each pattern as the line made it, for the preview:
    {"line", "what" (body / solid / points / edges / faces), "kind", ...info,
    "skip", "instances": [{"index", "skip", "center", "corners" (the box's 8,
    moved)}]}."""
    if report is None:
        return
    skip = set(pat.skip)
    inst = []
    for i, t in enumerate(pat.motions):
        row = {"index": i, "skip": i in skip}
        if box is not None:
            cs = [_p(t, c) for c in _corners(*box)]
            row["corners"] = [_r(c) for c in cs]
            row["center"] = _r(_p(t, (box[0] + box[1]) * 0.5))
        inst.append(row)
    report.append({"line": _script_line(), "what": what, "kind": pat.kind, **pat.info,
                   "skip": pat.skip, "instances": inst})


def _need(pat) -> Pattern:
    if not isinstance(pat, Pattern):
        raise PatternError("give a pattern: linear(...) or circular(...), "
                           f"not {type(pat).__name__}")
    return pat


def _whole(out) -> Part:
    return out if isinstance(out, Part) else Part(Compound([out]).wrapped)


def bind(ns: dict, report: list | None = None) -> dict:
    """The script-namespace linear(), circular(), pattern_body() and
    patterned(); patterned references are found again on the script's `part`
    as it is when the line runs, with the script's own face_ref / edge_ref.
    Each pattern used is recorded in `report` (see _report)."""

    def find_edge(edge: Edge, t: gp_Trsf, i: int) -> Edge:
        faces = list(getattr(edge, "_ref_faces", None) or _adjacent(ns.get("part"), edge))[:2]
        if len(faces) < 2:
            raise PatternError("patterned(): can't tell which faces this edge lies between, to find its copies")
        loc = Location(t)
        frefs = [face_ref_mod.describe(f.moved(loc)) for f in faces]
        ref = edge_ref_mod.describe(edge.moved(loc), frefs)
        ref["hint"] = f"copy {i} of the {ref['hint']}"
        return ns["edge_ref"](ref)

    def find_face(face: Face, t: gp_Trsf, i: int) -> Face:
        ref = face_ref_mod.describe(face.moved(Location(t)))
        ref["hint"] = f"copy {i} of the {edge_ref_mod.face_hint(ref)}"
        return ns["face_ref"](ref)

    def pattern_body(part, pattern, join: bool = True):
        """`part` and its copies: fused into one (join=True, one boolean) or
        each a separate body (join=False)."""
        pat = _need(pattern)
        if part is None or not hasattr(part, "solids"):
            raise PatternError("pattern_body(): there is no part to pattern yet")
        bb = part.bounding_box()
        _report(report, pat, (Vector(bb.min), Vector(bb.max)), "body")
        copies = [part.moved(Location(t)) for _, t in pat.copies()]
        if not copies:
            return part
        if join:
            return _whole(part.fuse(*copies))
        return Part(Compound(list(part.solids()) + [s for c in copies for s in c.solids()]).wrapped)

    def patterned(obj, pattern):
        """The copies of `obj` (not the original): a solid's (a list, for one
        boolean), sketch_points()'s, or face / edge references' (found again
        on the part where each copy is)."""
        pat = _need(pattern)
        copies = pat.copies()
        if isinstance(obj, Refs):
            _report(report, pat, _seed_box(obj, None), "faces" if obj.kind == "face" else "edges")
            on = {"on": obj.on} if obj.on is not None else {}
            if obj.kind == "face":
                # where a copy of the face's hole goes: its centre and normal, moved
                f = ns["face_ref"](obj.data, **on)
                c = f.center()
                n = f.normal_at(c).normalized() if f.geom_type == GeomType.PLANE else face_ref_mod.direction(f)
                return [(_p(t, c), _d(t, n).normalized()) for _, t in copies]
            refs = obj.data if obj.kind == "edges" else [obj.data]
            moved = []
            for i, t in copies:
                for r in refs or []:
                    m = map_edge(r, lambda p, t=t: _p(t, p), lambda d, t=t: _d(t, d))
                    m["hint"] = f"copy {i} of the {m['hint']}"
                    moved.append(m)
            return ns["edges_ref"](moved, **on)
        if isinstance(obj, UntilExtrude):
            # each copy's sketch and way, run again: "next" is each copy's own
            _report(report, pat, _seed_box(Compound([f for f, _ in obj.pieces]), None), "solid")
            out = []
            for i, t in copies:
                target = obj.target
                if isinstance(target, Refs):
                    m = map_face(target.data, lambda p, t=t: _p(t, p), lambda d, t=t: _d(t, d))
                    m["hint"] = f"copy {i} of the {edge_ref_mod.face_hint(m)}"
                    target = ns["face_ref"](m, **({"on": target.on} if target.on is not None else {}))
                elif isinstance(target, Face):
                    target = find_face(target, t, i) if hasattr(target, "_ref_status") else target.moved(Location(t))
                loc = Location(t)
                out.append(obj.copy([(f.moved(loc), _d(t, d)) for f, d in obj.pieces], target).build(ns.get("part")))
            return out
        if isinstance(obj, Points):
            _report(report, pat, _seed_box(obj, None), "points")
            n0 = Vector(obj.normal)
            sets = [Points([_p(t, Vector(p)) for p in obj], _d(t, n0), obj.name) for _, t in copies]
            if all(abs(Vector(s.normal).dot(n0) - 1) < 1e-9 for s in sets):
                return Points([p for s in sets for p in s], n0, obj.name)
            return sets
        if isinstance(obj, Edge) and hasattr(obj, "_ref_status"):
            _report(report, pat, None, "edges")
            return ShapeList([find_edge(obj, t, i) for i, t in copies])
        if isinstance(obj, (list, tuple, ShapeList)) and obj and all(
                isinstance(x, Edge) and hasattr(x, "_ref_status") for x in obj):
            _report(report, pat, None, "edges")
            return ShapeList([find_edge(x, t, i) for i, t in copies for x in obj])
        if isinstance(obj, Shape):
            _report(report, pat, _seed_box(obj, None), "solid")
            return [obj.moved(Location(t)) for _, t in copies]
        if isinstance(obj, (list, tuple)) and obj and all(isinstance(x, Shape) for x in obj):
            _report(report, pat, _seed_box(obj, None), "solid")
            return [x.moved(Location(t)) for _, t in copies for x in obj]
        raise PatternError("patterned() copies a solid (an extrude), sketch_points(), face_ref() or edges_ref(), "
                           f"not {type(obj).__name__}")

    def pattern_copy(part, pattern, join: bool = True):
        """pattern_body()'s copies alone, as one compound (the editor's
        preview draws them in their own colour); `join` is taken and ignored."""
        pat = _need(pattern)
        copies = [part.moved(Location(t)) for _, t in pat.copies()]
        return Part(Compound([s for c in copies for s in c.solids()]).wrapped) if copies else None

    return {"linear": linear, "circular": circular, "pattern_body": pattern_body, "patterned": patterned,
            "_pattern_copy": pattern_copy}
