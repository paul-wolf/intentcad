"""sketch(name): a sketch drawn on a part face, as planar faces to extrude.

The frontend stores each face sketch's closed loops (its "profile") with the
sketch, in sketch coordinates on the sketch's plane:

    {"plane": {"origin": [x,y,z], "normal": [x,y,z], "xAxis": [x,y,z]},
     "loops": [[segment, ...], ...],
     "points": [[x,y], ...],          (its point entities: where sketch_points() puts holes)
     "lines": {id: [[x,y], [x,y]]}}   (its straight construction / reference lines and
                                       built-in axes: what sketch_line() turns into a revolve axis)

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

A sketch drawn on a construction plane carries the plane's name instead:

    "planeRef": "Lid"

and sketch() takes the plane from the script's PLANES (modeling/planes.py)
when its line runs, so the sketch follows the plane (see on_plane()).
"""

from __future__ import annotations

from build123d import Compound, Edge, Face, GeomType, Plane, Vector, Wire

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
    """The profile's loops as faces (holes cut out) on its plane. Shapes that
    cross each other go by regions: the default ones (see profile_regions)."""
    pl = _plane(profile.get("plane") or {})
    loops = profile.get("loops") or []
    if not loops:
        raise SketchError(f"sketch {name!r} has no closed shapes to extrude")
    if len(loops) > 1 and _nesting(_fills(profile, name)[1])[1]:
        return picked_faces(profile, name, [r.point for r in profile_regions(profile, name) if r.default])
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
        if not holes:
            pieces = [fills[i]]
        else:
            try:
                pieces = [Face(w, holes)]
            except Exception:  # noqa: BLE001 - a hole touches the outline (a wall along a plate edge)
                cut = fills[i].cut(*[fills[k] for k in range(len(wires)) if parent[k] == i and depth[k] == depth[i] + 1])
                pieces = cut.faces()
        for f in pieces:
            if f.normal_at().dot(normal) < 0:
                f = -f
            faces.append(f)
    return faces


# --- Regions: closed shapes that overlap split the sketch into regions (a
#     square with a rectangle across its edge: the square without it, the
#     overlap, and the part outside). An extrude may pick some of them:
#         sketch("Plate", regions=[(x, y), ...])
#     each (x, y) a point inside a picked region, in sketch coordinates; with no
#     regions it takes what profile_faces() makes (the default: shapes that
#     overlap add up, a shape fully inside another is a hole in it).

def _faces(shape) -> list[Face]:
    if shape is None:
        return []
    found = [f for s in shape for f in s.faces()] if isinstance(shape, list) else shape.faces()
    return [f for f in found if f.area > 1e-9]


def _inner_point(f: Face) -> Vector:
    """A point well inside face `f`: of its centre and the centres of its
    triangles, the one furthest from its edges."""
    verts, tris = f.tessellate(0.05, 0.2)
    candidates = [f.center()] + [(verts[a] + verts[b] + verts[c]) / 3 for a, b, c in tris]
    edges = f.edges()
    best, room = candidates[0], -1.0
    for p in candidates:
        if f.distance_to(p) > 1e-7:
            continue
        r = min(e.distance_to(p) for e in edges)
        if r > room:
            best, room = p, r
    return best


def _sketch_xy(pl: Plane, v: Vector) -> list[float]:
    u = pl.to_local_coords(v)
    return [round(u.X, 4) + 0.0, round(-u.Y, 4) + 0.0]      # no -0.0


class Region:
    """One region of a sketch: its `face` on the sketch's plane, a `point`
    inside it (sketch x, y) and whether the default extrude takes it."""

    def __init__(self, face: Face, point: list[float], default: bool):
        self.face, self.point, self.default = face, point, default


def _fills(profile: dict, name: str) -> tuple[Plane, list[Face]]:
    pl = _plane(profile.get("plane") or {})
    loops = profile.get("loops") or []
    if not loops:
        raise SketchError(f"sketch {name!r} has no closed shapes to extrude")
    fills = []
    for loop in loops:
        try:
            fills.append(Face(Wire(_edges(pl, loop))))
        except Exception as exc:  # noqa: BLE001 - OCCT raises plain Standard_Failure
            raise SketchError(f"sketch {name!r}: a closed shape could not be built ({exc})") from exc
    return pl, fills


def _nesting(fills: list[Face]) -> tuple[list[int], bool]:
    """How many shapes fully enclose each shape, and whether any two shapes
    cross (overlap without one holding the other)."""
    boxes = [f.bounding_box() for f in fills]
    depth, crossing = [0] * len(fills), False
    for i in range(len(fills)):
        for j in range(i + 1, len(fills)):
            a, b = boxes[i], boxes[j]
            if (a.min.X > b.max.X or b.min.X > a.max.X or a.min.Y > b.max.Y or b.min.Y > a.max.Y
                    or a.min.Z > b.max.Z or b.min.Z > a.max.Z):
                continue
            small, big = (i, j) if fills[i].area <= fills[j].area else (j, i)
            if not _faces(fills[small].cut(fills[big])):
                depth[small] += 1
            elif _faces(fills[small].intersect(fills[big])):
                crossing = True
    return depth, crossing


def profile_regions(profile: dict, name: str = "sketch") -> list[Region]:
    """The regions the profile's closed shapes split its plane into, in a
    steady order (by their points). The default takes a region when the
    innermost shapes holding it are outlines: shapes that cross add up, a
    shape fully inside another is a hole in it (one inside that hole an
    island again)."""
    pl, fills = _fills(profile, name)
    depth, _ = _nesting(fills)
    pieces: list[Face] = []
    for f in fills:          # split what is there by each shape, and add what of it is new
        nxt = []
        for p in pieces:
            nxt += _faces(p.intersect(f)) + _faces(p.cut(f))
        nxt += _faces(f.cut(*pieces)) if pieces else [f]
        pieces = nxt
    out = []
    for f in pieces:
        p = _inner_point(f)
        held = [depth[i] for i, g in enumerate(fills) if g.distance_to(p) < 1e-6]
        out.append(Region(f, _sketch_xy(pl, p), bool(held) and max(held) % 2 == 0))
    return sorted(out, key=lambda r: (r.point[1], r.point[0]))


def picked_faces(profile: dict, name: str, points) -> list[Face]:
    """The regions holding `points` (sketch x, y), joined into faces facing
    the plane's normal. A point in no region (an edit took its region away)
    is an error: the step is flagged, nothing is guessed."""
    pl = _plane(profile.get("plane") or {})
    regions = profile_regions(profile, name)
    picked: list[Face] = []
    for xy in points:
        try:
            x, y = (float(c) for c in xy)
        except (TypeError, ValueError) as exc:
            raise SketchError(f"sketch {name!r}: regions must be (x, y) points") from exc
        at = pl.from_local_coords((x, -y))
        hit = next((r.face for r in regions if r.face.distance_to(at) < 1e-6), None)
        if hit is None:
            raise SketchError(f"sketch {name!r} changed: a region picked for this step is gone. "
                              "Reopen the step and pick its regions again")
        if all(hit is not f for f in picked):
            picked.append(hit)
    if not picked:
        raise SketchError(f"sketch {name!r}: no regions picked")
    joined = picked[0].fuse(*picked[1:]).clean() if len(picked) > 1 else picked[0]
    out = []
    for f in _faces(joined):
        out.append(-f if f.normal_at().dot(pl.z_dir) < 0 else f)
    return out


def region_view(profile: dict, name: str = "sketch") -> list[dict]:
    """The regions for the Extrude dialog, in sketch coordinates: each one's
    point, whether the default takes it, its area, its triangles (to fill) and
    its edges as polylines (to outline)."""
    flat = {**profile, "plane": {"origin": [0, 0, 0], "normal": [0, 0, 1], "xAxis": [1, 0, 0]}}
    pl = _plane(flat["plane"])
    out = []
    for r in profile_regions(flat, name):
        verts, tris = r.face.tessellate(0.05, 0.2)
        xy = [_sketch_xy(pl, v) for v in verts]
        edges = []
        for e in r.face.edges():
            n = 2 if e.geom_type == GeomType.LINE else 24
            edges.append([_sketch_xy(pl, v) for v in e.positions([i / (n - 1) for i in range(n)])])
        out.append({"point": r.point, "default": r.default, "area": round(r.face.area, 3),
                    "tris": [[xy[a], xy[b], xy[c]] for a, b, c in tris], "edges": edges})
    return out


class Points(list):
    """sketch_points(): Vectors on a sketch's plane, with that plane's
    `normal` (out of the face the sketch was drawn on)."""

    def __init__(self, points, normal: Vector, name: str = ""):
        super().__init__(points)
        self.normal = normal
        self.name = name


def profile_points(profile: dict, name: str = "sketch") -> Points:
    """The profile's points and the centres of its circles, in 3D on its
    plane, each place once."""
    pl = _plane(profile.get("plane") or {})
    flat = [tuple(p) for p in profile.get("points") or []]
    flat += [tuple(seg["c"]) for loop in profile.get("loops") or [] for seg in loop if seg.get("t") == "circle"]
    out: list[Vector] = []
    for x, y in flat:
        v = pl.from_local_coords((float(x), -float(y)))
        if all((v - o).length > 1e-6 for o in out):
            out.append(v)
    return Points(out, pl.z_dir, name)


def _vec(v) -> Vector:
    return Vector(float(v[0]), float(v[1]), float(v[2]))


def _plane_spec(spec: dict, origin: Vector | None = None) -> dict:
    out = {"origin": list(spec["origin"]), "normal": list(spec["normal"]), "xAxis": list(spec["xAxis"])}
    if origin is not None:
        out["origin"] = [round(origin.X, 9), round(origin.Y, 9), round(origin.Z, 9)]
    return out


def _xy(pl: Plane, p) -> list[float]:
    """A point as sketch (x, y) on `pl`: (u, -v)."""
    q = pl.to_local_coords(p)
    return [round(q.X, 6), round(-q.Y, 6)]


def face_outline(face: Face, pl: Plane) -> list[dict]:
    """The face's edges in the sketch coordinates of plane `pl` (y flipped,
    as the profile): {"t": "line", "p": [a, b]}, {"t": "circle", "c", "r"},
    {"t": "arc", "c", "r", "p": [start, mid, end]}, anything else as
    {"t": "poly", "p": [points along it]}."""
    out = []
    for e in face.edges():
        if e.geom_type == GeomType.LINE:
            out.append({"t": "line", "p": [_xy(pl, e @ 0), _xy(pl, e @ 1)]})
        elif e.geom_type == GeomType.CIRCLE:
            c, r = _xy(pl, e.arc_center), round(e.radius, 6)
            if e.is_closed:
                out.append({"t": "circle", "c": c, "r": r})
            else:
                out.append({"t": "arc", "c": c, "r": r, "p": [_xy(pl, e @ k) for k in (0, 0.5, 1)]})
        else:
            out.append({"t": "poly", "p": [_xy(pl, e @ (k / 16)) for k in range(17)]})
    return out


# A face no part of whose outline box covers the old one's (seen along the
# normal) and whose area is under half or over twice the old is another face,
# not this one moved: the bracket's upright lowered into the base leaves the
# base's 5 mm end strip as the only face facing the same way, and a sketch of
# the upright's face put there would be a silent jump.
UNLIKE_AREA = 2.0


def _unlike(face: dict, found, pl) -> bool:
    box0 = face.get("box")
    if not box0:
        return False
    try:
        ov = face_ref.overlap(box0, face_ref.box(found, pl))
        ratio = found.area / float(face["area"])
    except Exception:  # noqa: BLE001 - nothing to compare: keep the match
        return False
    return ov <= 0 and not (1 / UNLIKE_AREA <= ratio <= UNLIKE_AREA)


def rebind(profile: dict, part) -> dict:
    """Where the sketch goes on `part` (the part built so far):
    {status, moved_by, plane, outline}.

    The face it was drawn on is looked for among part's planar faces facing
    the same way (face_ref.find: centre across and along the normal, area,
    outline box overlap), and one with no overlap and a very different area
    isn't taken (_unlike). The best wins and the plane moves along its normal onto it, keeping its in-plane origin and
    x axis (so the sketch's coordinates still mean the same place).

    status: "same" (not moved), "moved", "ambiguous" (another face scored
    within 10% — the best is used), "not_found" (the stored plane, though
    bind()'s sketch() then stops the build there rather than draw it on
    nothing: lost_face()).
    outline: the matched face's edges in the sketch's own coordinates on the
    new plane (face_outline), so the sketch's reference outline can follow
    the face; only when a face was matched."""
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
    if m["face"] is None or _unlike(face, m["face"], pl):
        return {**keep, "status": "not_found"}
    offset = (m["center"] - pl.origin).dot(n)
    moved = round(offset, 6)
    status = "moved" if abs(moved) > 1e-6 else "same"
    if m["status"] == "ambiguous":
        status = "ambiguous"
    plane = _plane_spec(spec, pl.origin + n * offset)
    try:
        outline = face_outline(m["face"], _plane(plane))
    except Exception:  # noqa: BLE001 - an edge OCCT can't sample: no outline, the sketch keeps its own
        outline = None
    return {"status": status, "moved_by": moved if status != "same" else 0.0, "plane": plane,
            **({"outline": outline} if outline else {})}


def on_plane(profile: dict, name: str, ns: dict | None) -> dict | None:
    """Where a sketch on a construction plane goes: the plane named by its
    planeRef, from the script's PLANES as it is when the line runs
    ({status, moved_by, plane} as rebind()); None for any other sketch."""
    ref = profile.get("planeRef")
    if not ref:
        return None
    planes = (ns or {}).get("PLANES")
    if not isinstance(planes, dict) or ref not in planes:
        raise SketchError(f"sketch {name!r} is on the construction plane {ref!r}, which isn't defined "
                          "before this line (a PLANES[...] line deleted, switched off or renamed?)")
    pl = planes[ref]
    spec = {"origin": list(pl.origin.to_tuple()), "normal": list(pl.z_dir.to_tuple()),
            "xAxis": list(pl.x_dir.to_tuple())}
    old = profile.get("plane") or {}
    try:
        moved = round((pl.origin - _vec(old["origin"])).length, 6)
        turned = 1 - abs(pl.z_dir.dot(_vec(old["normal"]).normalized()))
    except (KeyError, TypeError, ValueError):
        moved, turned = 0.0, 0.0
    status = "moved" if moved > 1e-6 or turned > 1e-9 else "same"
    meta = getattr(pl, "_plane_ref", None) or {}
    if meta.get("status") == "ambiguous":
        status = "ambiguous"
    return {"status": status, "moved_by": moved if status != "same" else 0.0, "plane": spec, "planeRef": ref}


def lost_face(name: str, profile: dict) -> str:
    """What the step says when the face a sketch was drawn on isn't in the
    part any more: the plain words, then how to put it on another face."""
    face = profile.get("face") or {}
    hint = face.get("hint") or "face"
    return (f"Sketch {name!r} lost its face ({hint}) — pick a new one: select the face it "
            f"belongs on, press K and choose Move {name!r} here")


def bind(profiles: dict, ns: dict | None = None, report: dict | None = None) -> dict:
    """The script-namespace sketch(): looks names up in `profiles`
    ({name: profile}, sent by the engine with the build). A face sketch is
    rebound onto the script's `part` as it is when sketch() is called (`ns`
    is the script namespace); where each went is recorded in `report`. A
    sketch whose face isn't found stops the build at its line (lost_face()):
    the step shows as broken instead of the sketch landing where the face
    used to be."""
    def placed(name: str) -> tuple[dict, dict]:
        if name not in profiles:
            raise SketchError(f"no sketch named {name!r} in this part")
        profile = profiles[name]
        where = on_plane(profile, name, ns) or rebind(profile, (ns or {}).get("part"))
        if report is not None:
            report[name] = where
        if where["status"] == "not_found":
            raise SketchError(lost_face(name, profile))
        return profile, where

    def sketch(name: str, regions=None):
        """The face sketch `name` as a Face (or a Compound of faces) on its
        plane; with `regions` ((x, y) points), only the regions holding them."""
        profile, where = placed(name)
        if where["plane"]:
            profile = {**profile, "plane": where["plane"]}
        faces = picked_faces(profile, name, regions) if regions is not None else profile_faces(profile, name)
        out = faces[0] if len(faces) == 1 else Compound(faces)
        out._sketch_name = name        # how an until extrude's message names it
        return out

    def sketch_points(name: str) -> Points:
        """The face sketch `name`'s points and circle centres, on its plane
        as rebound onto `part` (a list of Vectors; .normal points out of the
        face it was drawn on)."""
        profile, where = placed(name)
        return profile_points({**profile, "plane": where["plane"] or profile.get("plane")}, name)

    def sketch_line(name: str, line: str) -> SketchLine:
        """A straight line of the face sketch `name` (a built-in axis "axis-h"
        / "axis-v", a construction or a reference line, by entity id) as an
        axis on the sketch's plane as rebound onto `part`: what revolve()
        turns a profile around."""
        profile, where = placed(name)
        return profile_line({**profile, "plane": where["plane"] or profile.get("plane")}, name, line)
    return {"sketch": sketch, "sketch_points": sketch_points, "sketch_line": sketch_line}


_AXIS_LABELS = {"axis-h": "H axis", "axis-v": "V axis", "axis-fh": "face H axis", "axis-fv": "face V axis"}


class SketchLine:
    """A sketch line in 3D: a point on it, its unit direction, the normal of
    the sketch's plane and how to name it in a message ("the V axis of
    'Knob'")."""

    def __init__(self, origin: Vector, direction: Vector, normal: Vector, label: str, sketch: str, line: str):
        self.origin, self.direction, self.normal = origin, direction, normal
        self.label, self.sketch, self.line = label, sketch, line

    def __repr__(self) -> str:
        return f"sketch_line({self.sketch!r}, {self.line!r})"


def profile_line(profile: dict, name: str, line: str) -> SketchLine:
    """Line `line` of a sketch's profile on its plane. The built-in axes are
    worked out from the plane when the profile doesn't list them (an older
    saved profile): H along the sketch x, V along its y, through the world
    origin projected onto a face sketch's plane, else the plane's origin."""
    pl = _plane(profile.get("plane") or {})
    label = f"the {_AXIS_LABELS[line]} of {name!r}" if line in _AXIS_LABELS else f"line {line!r} of {name!r}"
    pts = (profile.get("lines") or {}).get(line)
    if pts is None and line in ("axis-h", "axis-v"):
        o = pl.origin
        if profile.get("face"):
            o = pl.z_dir * o.dot(pl.z_dir)     # the world origin, projected onto the plane
        d = pl.x_dir if line == "axis-h" else pl.y_dir
        return SketchLine(o, d.normalized(), pl.z_dir, label, name, line)
    if pts is None:
        raise SketchError(f"sketch {name!r} has no straight line {line!r} to revolve about "
                          "(deleted, curved, or not a construction / reference line?)")
    try:
        a, b = (pl.from_local_coords((float(p[0]), -float(p[1]))) for p in pts)
    except (TypeError, ValueError, IndexError) as exc:
        raise SketchError(f"sketch {name!r}: line {line!r} is not a straight line") from exc
    if (b - a).length < 1e-9:
        raise SketchError(f"{label} has no length, so it has no direction to revolve about")
    return SketchLine(a, (b - a).normalized(), pl.z_dir, label, name, line)
