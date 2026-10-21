"""face_ref(ref): a face of the part named by what it looks like, found again
on the part as it is when the line runs.

Face indices change whenever the part does, so a script line that works on
particular faces (shell(part, remove=[...]), a sketch drawn on a face) stores
the face's look instead:

    {"center": [x,y,z], "normal": [x,y,z], "area": a,
     "box": [umin, vmin, umax, vmax],   its outline, in basis(normal)'s (u, v)
     "kind": "cylinder",                 (only for curved faces; "normal" is then the axis)
     "hint": "top face"}                 (what to call it in a message)

find() scores the part's faces of the same kind facing the same way on how far
the centre is across the normal (scaled by the face's size), how different the
area is, how little the outline box overlaps and, at half weight, how far the
centre is along the normal — that is how a face moves when the part gets
thicker, but of two otherwise alike faces the nearer one is the same face.
The sketch rebinding (sketch_profile.rebind) uses the same matching.
"""

from __future__ import annotations

import math

from build123d import Face, GeomType, Plane, Vector

# a candidate faces the same way when its normal (axis) is this close
SAME_NORMAL = 0.999
# the runner-up scoring within this fraction of the best makes the match ambiguous
AMBIGUOUS = 0.10
# distance along the normal counts this much against a face (per face size)
ALONG = 0.5
# a curved face that moved further than its size is still the one when it is
# the only face of its kind whose area is within this fraction (a hole moved)
SAME_AREA = 0.02


class FaceRefError(ValueError):
    pass


def vec(v) -> Vector:
    if isinstance(v, Vector):
        return Vector(v)
    return Vector(float(v[0]), float(v[1]), float(v[2]))


def basis(normal) -> Plane:
    """The plane through the origin facing `normal` that a reference's box is
    measured in: u = Z × n, or Y × n for a face facing (nearly) up or down."""
    n = vec(normal).normalized()
    up = Vector(0, 0, 1) if abs(n.Z) < 0.9 else Vector(0, 1, 0)
    return Plane(origin=(0, 0, 0), x_dir=up.cross(n).normalized(), z_dir=n)


def box(face: Face, pl: Plane) -> tuple[float, float, float, float]:
    """The face's outline as a box in the plane's (u, v)."""
    us, vs = [], []
    for e in face.edges():
        n = 2 if e.geom_type == GeomType.LINE else 17
        for k in range(n):
            p = pl.to_local_coords(e @ (k / (n - 1)))
            us.append(p.X)
            vs.append(p.Y)
    return min(us), min(vs), max(us), max(vs)


def overlap(a, b) -> float:
    """Intersection over union of two (umin, vmin, umax, vmax) boxes."""
    iw = min(a[2], b[2]) - max(a[0], b[0])
    ih = min(a[3], b[3]) - max(a[1], b[1])
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _axis(face: Face) -> Vector | None:
    """A cylindrical/conical face's axis direction, else None."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder

    try:
        s = BRepAdaptor_Surface(face.wrapped)
        t = s.GetType()
        ax = s.Cylinder().Axis() if t == GeomAbs_Cylinder else s.Cone().Axis() if t == GeomAbs_Cone else None
        if ax is None:
            return None
        d = ax.Direction()
        return Vector(d.X(), d.Y(), d.Z())
    except Exception:  # noqa: BLE001
        return None


def direction(face: Face) -> Vector:
    """What a reference calls the face's "normal": the normal of a plane, the
    axis of a cylinder or cone (either way along it), else the normal at its
    centre."""
    if face.geom_type != GeomType.PLANE:
        a = _axis(face)
        if a is not None:
            return a
    return face.normal_at(face.center())


def _kind(face: Face) -> str:
    return face.geom_type.name.lower()


def describe(face: Face, points=None, hint: str | None = None) -> dict:
    """The reference for `face`. Its box is taken from `points` (e.g. the
    face's mesh vertices) when given, else from its edges."""
    n = direction(face)
    pl = basis(n)
    if points:
        loc = [pl.to_local_coords(Vector(*p) if not isinstance(p, Vector) else p) for p in points]
        b = (min(p.X for p in loc), min(p.Y for p in loc), max(p.X for p in loc), max(p.Y for p in loc))
    else:
        b = box(face, pl)
    c = face.center()
    ref = {"center": [round(c.X, 3), round(c.Y, 3), round(c.Z, 3)],
           "normal": [round(n.X, 4), round(n.Y, 4), round(n.Z, 4)],
           "area": round(float(face.area), 2),
           "box": [round(x, 3) for x in b]}
    kind = _kind(face)
    if kind != "plane":
        ref["kind"] = kind
    if hint:
        ref["hint"] = hint
    return ref


def find(part, ref: dict, pl: Plane | None = None) -> dict:
    """The face of `part` that `ref` names:
    {"status", "face", "center", "across", "along"}.

    `pl` is the plane ref's box is measured in (default basis(ref normal));
    the sketch rebinding passes the sketch's plane. status is "found",
    "ambiguous" (another face scored within 10% — the best is still given) or
    "not_found" (face None). Raises on a reference it can't read."""
    size, scored = rank(part, ref, pl)
    none = {"status": "not_found", "face": None, "center": None, "across": None, "along": None}
    if not scored:
        return none
    score, across, along, ov, c, f = scored[0]
    if not ov and across > size and not _only_one_like(ref, scored):
        return none
    status = "found"
    if len(scored) > 1 and scored[1][0] <= score * (1 + AMBIGUOUS) + 1e-9:
        status = "ambiguous"
    return {"status": status, "face": f, "center": c, "across": across, "along": along}


def _only_one_like(ref: dict, scored: list[tuple]) -> bool:
    """A curved face (a hole's cylinder, say) is the only one of its kind and
    size, so the best candidate is it however far it moved."""
    if ref.get("kind", "plane") == "plane":
        return False
    area0 = float(ref["area"])
    like = [t for t in scored if abs(t[5].area / area0 - 1) <= SAME_AREA]
    return len(like) == 1 and like[0] is scored[0]


def rank(part, ref: dict, pl: Plane | None = None) -> tuple[float, list[tuple]]:
    """The face's size (sqrt of its area) and the part's faces that could be
    the one `ref` names, best first, as (score, across, along, overlap,
    center, face). find() takes the first; edge_ref tries the first few of
    each of an edge's two faces."""
    n = vec(ref["normal"]).normalized()
    c0 = vec(ref["center"])
    area0 = float(ref["area"])
    box0 = ref.get("box")
    kind = ref.get("kind", "plane")
    if pl is None:
        pl = basis(n)
    size = math.sqrt(area0) if area0 > 0 else 1.0
    scored = []
    for f in part.faces():
        if _kind(f) != kind or f.area <= 0:
            continue
        c = f.center()
        if kind == "plane":
            if f.normal_at(c).dot(n) < SAME_NORMAL:
                continue
        elif abs(direction(f).normalized().dot(n)) < SAME_NORMAL:
            continue
        d = c - c0
        along = d.dot(n)
        across = (d - n * along).length
        ov = overlap(box0, box(f, pl)) if box0 else None
        score = ((across + ALONG * abs(along)) / size + abs(math.log(f.area / area0))
                 + (1 - ov if ov is not None else 0))
        scored.append((score, across, along, ov, c, f))
    scored.sort(key=lambda t: t[0])
    return size, scored


def _moved_status(status: str, moved_by: float) -> str:
    """same / moved / ambiguous, as a construction plane reports it."""
    if status == "ambiguous":
        return "ambiguous"
    return "moved" if abs(moved_by or 0.0) > 1e-6 else "same"


def bind(ns: dict, report: list | None = None) -> dict:
    """The script-namespace face_ref(): resolves against the script's `part`
    as it is when the line runs (or `on=`). Each lookup is recorded in
    `report` as {"hint", "status", "moved_by", "line"}; a face that isn't there any
    more raises, naming it."""
    def face_ref(ref: dict, on=None) -> Face:
        """The face of the part that `ref` describes (see modeling/face_ref.py)."""
        part = on if on is not None else ns.get("part")
        hint = (ref or {}).get("hint") or "face"
        if part is None or not hasattr(part, "faces"):
            raise FaceRefError(f"face_ref({hint!r}): there is no part yet to find it on")
        try:
            m = find(part, ref)
        except (KeyError, TypeError, ValueError, IndexError) as exc:
            raise FaceRefError(f"face_ref: can't read the reference to the {hint} ({exc})") from exc
        from modeling.edge_ref import _script_line
        entry = {"hint": hint, "status": m["status"],
                 "moved_by": round(float(m["along"]), 6) if m["along"] is not None else 0.0,
                 "line": _script_line()}
        if report is not None:
            report.append(entry)
        if m["face"] is None:
            raise FaceRefError(f"the {hint} this line refers to is no longer on the part "
                               "(the part changed too much for it to be found again): "
                               "reopen the step and pick the face again")
        # what a construction plane on it reports (modeling/planes.py)
        m["face"]._ref_status = _moved_status(m["status"], entry["moved_by"])
        # the axis (a curved face's "normal") the way the reference has it:
        # a tangent plane's angle turns about it (OCC may flip it on a rebuild)
        m["face"]._ref_normal = vec(ref["normal"])
        return m["face"]
    return {"face_ref": face_ref}
