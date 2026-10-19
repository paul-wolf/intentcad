"""sketch(name): a sketch drawn on a part face, as planar faces to extrude.

The frontend stores each face sketch's closed loops (its "profile") with the
sketch, in sketch coordinates on the sketch's plane:

    {"plane": {"origin": [x,y,z], "normal": [x,y,z], "xAxis": [x,y,z]},
     "loops": [[segment, ...], ...]}

    segment = {"t": "line",   "p": [[x,y], [x,y]]}
            | {"t": "arc",    "p": [[x,y], mid, [x,y]]}      (three-point arc)
            | {"t": "circle", "c": [x,y], "r": r}
            | {"t": "bezier", "p": [p0, p1, p2, p3]}

Sketch y points down the screen, so sketch (x, y) is plane (u, v) = (x, -y)
with u along xAxis and v = normal × xAxis.

Loops nest by containment: a loop inside an even number of others is an
outline, one inside an odd number is a hole in its innermost container. Every
face is oriented so its normal is the plane normal — extrude(f, amount=d)
grows d out of the face, a negative amount goes into the part.

A sketch drawn on a part face also carries the face it was drawn on:

    "face": {"center": [x,y,z], "normal": [x,y,z], "area": a,
             "box": [umin, vmin, umax, vmax],   (its outline, in plane (u, v))
             "perimeter": p, "edges": n, "hint": "top face"}

(older sketches have only center, normal and area). When sketch() is called
the face is looked for again in the `part` built so far, and the sketch moves
along its normal onto it — a hole on the top face stays on the top face when
the plate gets thicker (see rebind()).
"""

from __future__ import annotations

import math

from build123d import Compound, Edge, Face, GeomType, Plane, Vector, Wire


class SketchError(ValueError):
    pass


def _plane(spec: dict) -> Plane:
    try:
        return Plane(origin=tuple(spec["origin"]), x_dir=tuple(spec["xAxis"]), z_dir=tuple(spec["normal"]))
    except (KeyError, TypeError) as exc:
        raise SketchError("sketch has no plane (draw it on a part face)") from exc


def _edges(pl: Plane, loop: list[dict]) -> list[Edge]:
    def at(p) -> Vector:
        return pl.from_local_coords((float(p[0]), -float(p[1])))

    out = []
    for seg in loop:
        t = seg.get("t")
        if t == "line":
            a, b = (at(p) for p in seg["p"])
            if (a - b).length > 1e-9:
                out.append(Edge.make_line(a, b))
        elif t == "arc":
            out.append(Edge.make_three_point_arc(*(at(p) for p in seg["p"])))
        elif t == "circle":
            c = at(seg["c"])
            out.append(Edge.make_circle(float(seg["r"]), Plane(origin=c, x_dir=pl.x_dir, z_dir=pl.z_dir)))
        elif t == "bezier":
            out.append(Edge.make_bezier(*(at(p) for p in seg["p"])))
        else:
            raise SketchError(f"unknown sketch segment {t!r}")
    return out


def profile_faces(profile: dict, name: str = "sketch") -> list[Face]:
    """The profile's loops as faces (holes cut out) on its plane."""
    pl = _plane(profile.get("plane") or {})
    loops = profile.get("loops") or []
    if not loops:
        raise SketchError(f"sketch {name!r} has no closed shapes to extrude")
    wires: list[Wire] = []
    for loop in loops:
        try:
            wires.append(Wire(_edges(pl, loop)))
        except Exception as exc:  # noqa: BLE001 - OCCT raises plain Standard_Failure
            raise SketchError(f"sketch {name!r}: a closed shape could not be built ({exc})") from exc
    fills = [Face(w) for w in wires]
    areas = [f.area for f in fills]

    # containers of each loop: larger loops that hold a point of it
    def inside(i: int, j: int) -> bool:
        return areas[j] > areas[i] and fills[j].distance_to(wires[i].position_at(0)) < 1e-6

    containers = [[j for j in range(len(wires)) if j != i and inside(i, j)] for i in range(len(wires))]
    depth = [len(c) for c in containers]
    parent = [min(c, key=lambda j: areas[j]) if c else None for c in containers]

    normal = pl.z_dir
    faces = []
    for i, w in enumerate(wires):
        if depth[i] % 2:
            continue
        holes = [wires[k] for k in range(len(wires)) if parent[k] == i and depth[k] == depth[i] + 1]
        f = Face(w, holes) if holes else fills[i]
        if f.normal_at().dot(normal) < 0:
            f = -f
        faces.append(f)
    return faces


# a candidate face is on the sketch's plane direction when its normal is this close
SAME_NORMAL = 0.999
# the runner-up scoring within this fraction of the best makes the match ambiguous
AMBIGUOUS = 0.10
# distance along the normal counts this much against a face (per face size):
# faces do move that way when the part changes, but a parallel face far off
# (a case's opposite wall, inside face) should lose to the one that moved less
ALONG = 0.5


def _vec(v) -> Vector:
    return Vector(float(v[0]), float(v[1]), float(v[2]))


def _box(face: Face, pl: Plane) -> tuple[float, float, float, float]:
    """The face's outline as a box in the plane's (u, v)."""
    us, vs = [], []
    for e in face.edges():
        n = 2 if e.geom_type == GeomType.LINE else 17
        for k in range(n):
            p = pl.to_local_coords(e @ (k / (n - 1)))
            us.append(p.X)
            vs.append(p.Y)
    return min(us), min(vs), max(us), max(vs)


def _overlap(a, b) -> float:
    """Intersection over union of two (umin, vmin, umax, vmax) boxes."""
    iw = min(a[2], b[2]) - max(a[0], b[0])
    ih = min(a[3], b[3]) - max(a[1], b[1])
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _plane_spec(spec: dict, origin: Vector | None = None) -> dict:
    out = {"origin": list(spec["origin"]), "normal": list(spec["normal"]), "xAxis": list(spec["xAxis"])}
    if origin is not None:
        out["origin"] = [round(origin.X, 9), round(origin.Y, 9), round(origin.Z, 9)]
    return out


def rebind(profile: dict, part) -> dict:
    """Where the sketch goes on `part` (the part built so far):
    {status, moved_by, plane}.

    The face it was drawn on is looked for among part's planar faces facing
    the same way, scored on how far its centre is across the plane (scaled by
    the face's size), how different its area is, how little its outline box
    overlaps the stored one and, at half weight, how far it is along the
    normal — that is what changes when the part gets thicker, but of two
    otherwise alike faces the nearer one is the same face. The best wins and
    the plane moves along its normal onto it, keeping its in-plane origin and
    x axis (so the sketch's coordinates still mean the same place).

    status: "same" (not moved), "moved", "ambiguous" (another face scored
    within 10% — the best is used), "not_found" (the stored plane is used)."""
    spec = profile.get("plane") or {}
    face = profile.get("face")
    keep = {"status": "same", "moved_by": 0.0, "plane": _plane_spec(spec) if spec else spec}
    if not spec or not isinstance(face, dict) or part is None or not hasattr(part, "faces"):
        return keep
    try:
        pl = _plane(spec)
        n = pl.z_dir
        c0 = _vec(face["center"])
        area0 = float(face["area"])
        box0 = face.get("box")
        size = math.sqrt(area0) if area0 > 0 else 1.0
        scored = []
        for f in part.faces():
            if f.geom_type != GeomType.PLANE:
                continue
            c = f.center()
            if f.normal_at(c).dot(n) < SAME_NORMAL or f.area <= 0:
                continue
            d = c - c0
            along = d.dot(n)
            across = (d - n * along).length
            ov = _overlap(box0, _box(f, pl)) if box0 else None
            score = ((across + ALONG * abs(along)) / size + abs(math.log(f.area / area0))
                     + (1 - ov if ov is not None else 0))
            scored.append((score, across, ov, c))
    except Exception:  # noqa: BLE001 - a part we can't read: leave the sketch where it was
        return keep
    if not scored:
        return {**keep, "status": "not_found"}
    scored.sort(key=lambda t: t[0])
    score, across, ov, c = scored[0]
    if not ov and across > size:
        return {**keep, "status": "not_found"}
    offset = (c - pl.origin).dot(n)
    moved = round(offset, 6)
    status = "moved" if abs(moved) > 1e-6 else "same"
    if len(scored) > 1 and scored[1][0] <= score * (1 + AMBIGUOUS) + 1e-9:
        status = "ambiguous"
    return {"status": status, "moved_by": moved if status != "same" else 0.0,
            "plane": _plane_spec(spec, pl.origin + n * offset)}


def bind(profiles: dict, ns: dict | None = None, report: dict | None = None) -> dict:
    """The script-namespace sketch(): looks names up in `profiles`
    ({name: profile}, sent by the engine with the build). A face sketch is
    rebound onto the script's `part` as it is when sketch() is called (`ns`
    is the script namespace); where each went is recorded in `report`."""
    def sketch(name: str):
        """The face sketch `name` as a Face (or a Compound of faces) on its plane."""
        if name not in profiles:
            raise SketchError(f"no sketch named {name!r} in this part")
        profile = profiles[name]
        where = rebind(profile, (ns or {}).get("part"))
        if report is not None:
            report[name] = where
        if where["plane"]:
            profile = {**profile, "plane": where["plane"]}
        faces = profile_faces(profile, name)
        return faces[0] if len(faces) == 1 else Compound(faces)
    return {"sketch": sketch}
