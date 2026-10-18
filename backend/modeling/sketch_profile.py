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
"""

from __future__ import annotations

from build123d import Compound, Edge, Face, Plane, Vector, Wire


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


def bind(profiles: dict) -> dict:
    """The script-namespace sketch(): looks names up in `profiles`
    ({name: profile}, sent by the engine with the build)."""
    def sketch(name: str):
        """The face sketch `name` as a Face (or a Compound of faces) on its plane."""
        if name not in profiles:
            raise SketchError(f"no sketch named {name!r} in this part")
        faces = profile_faces(profiles[name], name)
        return faces[0] if len(faces) == 1 else Compound(faces)
    return {"sketch": sketch}
