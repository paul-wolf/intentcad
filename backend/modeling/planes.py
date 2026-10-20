"""Construction planes: named planes defined by the part's geometry, that
follow it when parameters change.

The script defines them in order, before anything that uses them:

    PLANES["Lid"] = offset_plane(face_ref({...}), distance=P["lid_gap"])
    PLANES["Mid"] = offset_plane(face_ref({...}), distance=-P["width"] / 2)
    PLANES["Top 30"] = offset_plane("XY", distance=30)
    PLANES["Cam tilt"] = edge_plane(edge_ref({...}), angle=P["cam_tilt"],
                                    from_face=face_ref({...}))

PLANES is a dict in the script namespace; each value is a build123d Plane.
A sketch drawn on a construction plane stores the plane's name (planeRef),
and sketch() takes the plane from PLANES when its line runs.

offset_plane(base, distance): parallel to the face (or base plane "XY",
"XZ", "YZ") at `distance` along its outward normal (negative: into the
part). Its x axis and origin are a face sketch's on that face (the
frontend's planeForFace: x is screen-right when looking at the face, the
origin is the world origin projected onto the plane), so a sketch on it
lines up with one on the face.

edge_plane(edge, angle, from_face): contains the straight edge. At angle 0
it is the plane of `from_face` (one of the edge's two faces; default the
first); positive angles rotate it about the edge away from the material (the
half of the plane over the face lifts out of the part). Its x axis runs along
the edge, oriented so the plane's y axis points across the face at angle 0
(the face lies "up" from the edge in a sketch on the plane); its origin is
the world origin projected onto the edge's line.

Each plane's status and geometry go into the build result as
result["planes"][name] = {"status": same|moved|ambiguous, "origin",
"normal", "xAxis", "kind", "line"}. A reference that isn't found raises in
face_ref()/edge_ref(), so it is an error on the plane's own line.
"""

from __future__ import annotations

import math

from build123d import Edge, Face, GeomType, Plane, Vector

BASES = {"XY": (0.0, 0.0, 1.0), "XZ": (0.0, -1.0, 0.0), "YZ": (1.0, 0.0, 0.0)}
RANK = {"same": 0, "moved": 1, "ambiguous": 2}


class PlaneError(ValueError):
    pass


class Planes(dict):
    """PLANES: a dict that says which plane is missing, by name."""

    def __missing__(self, name):
        known = ", ".join(repr(k) for k in self) or "none are defined"
        raise PlaneError(f"no construction plane named {name!r} (defined so far: {known}); "
                         "it must be defined by a PLANES[...] line before the line that uses it")


def face_x(n: Vector) -> Vector:
    """A face sketch's x axis on a face with normal n (frontend lookFrom: the
    screen-right of the view looking at the face, world Z up on walls, Y up
    on top and bottom faces)."""
    n = n.normalized()
    if abs(n.Z) > 0.999:
        up = Vector(0, math.copysign(1.0, n.Z), 0)
    else:
        up = (Vector(0, 0, 1) - n * n.Z).normalized()
    return up.cross(n).normalized()


def _status(obj) -> str:
    return getattr(obj, "_ref_status", None) or "same"


def _worst(*statuses: str) -> str:
    return max(statuses, key=lambda s: RANK.get(s, 0))


def _tag(pl: Plane, kind: str, status: str) -> Plane:
    from modeling.edge_ref import _script_line
    pl._plane_ref = {"kind": kind, "status": status, "line": _script_line()}
    return pl


def _num(v, what: str) -> float:
    try:
        return float(v)
    except (TypeError, ValueError) as exc:
        raise PlaneError(f"{what} must be a number, not {v!r}") from exc


def offset_plane(base, distance=0.0) -> Plane:
    """The plane parallel to `base` (a planar face, or "XY" / "XZ" / "YZ") at
    `distance` along its outward normal (negative: into the part)."""
    d = _num(distance, "offset_plane distance")
    if isinstance(base, str):
        key = base.upper()
        if key not in BASES:
            raise PlaneError(f"offset_plane: base must be a face or one of XY, XZ, YZ, not {base!r}")
        n = Vector(*BASES[key])
        origin = Vector(0, 0, 0)
        status = "same"
    elif isinstance(base, Face):
        if base.geom_type != GeomType.PLANE:
            raise PlaneError("offset_plane needs a flat face (this one is curved)")
        c = base.center()
        n = base.normal_at(c).normalized()
        origin = n * c.dot(n)
        status = _status(base)
    else:
        raise PlaneError(f"offset_plane: base must be a face or one of XY, XZ, YZ, not {type(base).__name__}")
    return _tag(Plane(origin=origin + n * d, x_dir=face_x(n), z_dir=n), "offset", status)


def _adjacent(part, edge: Edge) -> list[Face]:
    if part is None or not hasattr(part, "faces"):
        return []
    return [f for f in part.faces() if any(e.wrapped.IsSame(edge.wrapped) for e in f.edges())]


def edge_plane(edge, angle=0.0, from_face=None, *, part=None) -> Plane:
    """The plane through the straight `edge`: at angle 0 the plane of
    `from_face` (one of the edge's faces; default the first), rotated about
    the edge by `angle` degrees, positive away from the material."""
    a = math.radians(_num(angle, "edge_plane angle"))
    if not isinstance(edge, Edge):
        raise PlaneError(f"edge_plane needs an edge (edge_ref(...)), not {type(edge).__name__}")
    if edge.geom_type != GeomType.LINE:
        kind = str(edge.geom_type).split(".")[-1].lower()
        raise PlaneError(f"edge_plane needs a straight edge; this edge is curved ({kind})")
    face = from_face
    if face is None:
        pair = getattr(edge, "_ref_faces", None) or _adjacent(part, edge)
        if not pair:
            raise PlaneError("edge_plane: say which face is 0° (from_face=face_ref(...))")
        face = pair[0]
    if not isinstance(face, Face):
        raise PlaneError(f"edge_plane: from_face must be a face, not {type(face).__name__}")
    p0, p1 = edge @ 0, edge @ 1
    mid = edge @ 0.5
    d = (p1 - p0).normalized()
    reach = max(1e-3, 1e-3 * float(edge.length))
    if face.distance_to(mid) > reach:
        raise PlaneError("edge_plane: from_face isn't one of the edge's two faces")
    n = face.normal_at(mid).normalized()
    n = (n - d * n.dot(d)).normalized()
    w = n.cross(d)                       # across the edge, in the face's plane
    # w must point onto the face (where the material is under it): flip the
    # edge direction when it points off the face
    if face.distance_to(mid + w * reach) > face.distance_to(mid - w * reach):
        d, w = -d, -w
    normal = n * math.cos(a) - w * math.sin(a)
    origin = p0 - d * p0.dot(d)          # the world origin projected onto the edge's line
    status = _worst(_status(edge), _status(face))
    return _tag(Plane(origin=origin, x_dir=d, z_dir=normal), "edge", status)


def _r(v: Vector) -> list[float]:
    return [round(v.X, 9) + 0.0, round(v.Y, 9) + 0.0, round(v.Z, 9) + 0.0]


def report(planes) -> dict:
    """result["planes"]: each Plane in PLANES with its status and geometry."""
    out: dict = {}
    if not isinstance(planes, dict):
        return out
    for name, pl in planes.items():
        if not isinstance(name, str) or not isinstance(pl, Plane):
            continue
        meta = getattr(pl, "_plane_ref", None) or {"kind": "script", "status": "same", "line": None}
        out[name] = {**meta, "origin": _r(pl.origin), "normal": _r(pl.z_dir), "xAxis": _r(pl.x_dir)}
    return out


def bind(ns: dict) -> dict:
    """The script-namespace PLANES, offset_plane() and edge_plane();
    edge_plane finds an edge's faces on the script's `part` as it is when
    the line runs."""
    def _edge_plane(edge, angle=0.0, from_face=None) -> Plane:
        return edge_plane(edge, angle, from_face, part=ns.get("part"))
    _edge_plane.__doc__ = edge_plane.__doc__
    return {"PLANES": Planes(), "offset_plane": offset_plane, "edge_plane": _edge_plane}
