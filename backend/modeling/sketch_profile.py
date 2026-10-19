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

from build123d import Compound, Edge, Face, Plane, Vector, Wire

from modeling import face_ref


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


def _vec(v) -> Vector:
    return Vector(float(v[0]), float(v[1]), float(v[2]))


def _plane_spec(spec: dict, origin: Vector | None = None) -> dict:
    out = {"origin": list(spec["origin"]), "normal": list(spec["normal"]), "xAxis": list(spec["xAxis"])}
    if origin is not None:
        out["origin"] = [round(origin.X, 9), round(origin.Y, 9), round(origin.Z, 9)]
    return out


def rebind(profile: dict, part) -> dict:
    """Where the sketch goes on `part` (the part built so far):
    {status, moved_by, plane}.

    The face it was drawn on is looked for among part's planar faces facing
    the same way (face_ref.find: centre across and along the normal, area,
    outline box overlap). The best wins and the plane moves along its normal onto it, keeping its in-plane origin and
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
        m = face_ref.find(part, {"center": face["center"], "normal": n.to_tuple(),
                                 "area": face["area"], "box": face.get("box")}, pl)
    except Exception:  # noqa: BLE001 - a part we can't read: leave the sketch where it was
        return keep
    if m["face"] is None:
        return {**keep, "status": "not_found"}
    offset = (m["center"] - pl.origin).dot(n)
    moved = round(offset, 6)
    status = "moved" if abs(moved) > 1e-6 else "same"
    if m["status"] == "ambiguous":
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
