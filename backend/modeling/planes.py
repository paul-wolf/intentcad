"""Construction planes: named planes defined by the part's geometry, that
follow it when parameters change.

The script defines them in order, before anything that uses them:

    PLANES["Lid"] = offset_plane(face_ref({...}), distance=P["lid_gap"])
    PLANES["Mid"] = offset_plane(face_ref({...}), distance=-P["width"] / 2)
    PLANES["Top 30"] = offset_plane("XY", distance=30)
    PLANES["Cam tilt"] = edge_plane(edge_ref({...}), angle=P["cam_tilt"],
                                    from_face=face_ref({...}))
    PLANES["Set screw"] = tangent_plane(face_ref({...}), angle=P["screw_angle"], ref="X")

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

tangent_plane(face, angle, ref): touches the cylindrical `face` along the
line at `angle` degrees round its axis, its normal pointing away from the
material (outward on a boss, toward the axis on a bore), so a cut from a
sketch on it goes into the material. The angle is measured from `ref`: "X",
"Y" or "Z" (that direction across the axis), a flat face (from the axis
toward it), default the base axis most nearly square to the cylinder's.
Positive turns right-handed about the axis as the face's reference stores it.
Its x axis runs along the cylinder's axis, the origin at the face's end where
x is least, so a sketch on it measures from that end and round the
circumference (y 0 on the tangent line).

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


AXES = {"X": (1.0, 0.0, 0.0), "Y": (0.0, 1.0, 0.0), "Z": (0.0, 0.0, 1.0)}
# a reference closer to the axis than this (sine of the angle) can't set 0°
PARALLEL = 1e-3


def _cylinder(face: Face) -> tuple[Vector, Vector, float]:
    """(a point on the axis, the axis, the radius) of a cylindrical face."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    cyl = BRepAdaptor_Surface(face.wrapped).Cylinder()
    p, d = cyl.Axis().Location(), cyl.Axis().Direction()
    return Vector(p.X(), p.Y(), p.Z()), Vector(d.X(), d.Y(), d.Z()), float(cyl.Radius())


def _across(v: Vector, a: Vector) -> Vector | None:
    """v with its part along the axis a taken out, unit; None when v is (nearly) along a."""
    v = v.normalized()
    w = v - a * v.dot(a)
    return w.normalized() if w.length > PARALLEL else None


def tangent_zero(axis: Vector, ref=None, *, center: Vector | None = None) -> Vector:
    """The direction across `axis` that is 0°: `ref` "X" / "Y" / "Z", a flat
    face (from the axis at `center` toward the face), or None, the base axis
    most nearly square to `axis`."""
    a = axis.normalized()
    if ref is None or (isinstance(ref, str) and ref.strip().lower() == "auto"):
        key = min("XYZ", key=lambda k: round(abs(Vector(*AXES[k]).dot(a)), 9))    # X first on a tie
        return _across(Vector(*AXES[key]), a)
    if isinstance(ref, str):
        key = ref.strip().upper()
        if key not in AXES:
            raise PlaneError(f"tangent_plane: ref must be \"X\", \"Y\", \"Z\" or a flat face, not {ref!r}")
        w = _across(Vector(*AXES[key]), a)
        if w is None:
            raise PlaneError(f"tangent_plane: the reference {key} runs along the cylinder's axis, so it "
                             "can't say where 0° is; pick another axis or a flat face")
        return w
    if isinstance(ref, Face):
        if ref.geom_type != GeomType.PLANE:
            raise PlaneError("tangent_plane: the reference face must be flat (this one is curved)")
        c = ref.center()
        w = _across(ref.normal_at(c), a)
        if w is None:
            raise PlaneError("tangent_plane: the reference face is square to the cylinder's axis, so it "
                             "can't say where 0° is; pick a face along the axis, or X, Y or Z")
        # toward the face: a flat on a shaft faces out, one in a D-shaped bore faces in
        if center is not None:
            toward = c - center
            toward = toward - a * toward.dot(a)
            if toward.length > 1e-6 and toward.dot(w) < 0:
                w = -w
        return w
    raise PlaneError(f"tangent_plane: ref must be \"X\", \"Y\", \"Z\" or a flat face, not {type(ref).__name__}")


def tangent_plane(face, angle=0.0, ref=None) -> Plane:
    """The plane touching the cylindrical `face` along the line `angle`
    degrees round its axis from `ref` ("X" / "Y" / "Z", a flat face, or None:
    the base axis most nearly square to the axis), facing away from the
    material. x runs along the axis from the face's end."""
    t = math.radians(_num(angle, "tangent_plane angle"))
    if not isinstance(face, Face):
        raise PlaneError(f"tangent_plane needs a face (face_ref(...)), not {type(face).__name__}")
    if face.geom_type != GeomType.CYLINDER:
        kind = "flat" if face.geom_type == GeomType.PLANE else str(face.geom_type).split(".")[-1].lower()
        raise PlaneError(f"tangent_plane needs a cylindrical face; this face is {kind}")
    p0, a, radius = _cylinder(face)
    a = a.normalized()
    stored = getattr(face, "_ref_normal", None)
    if stored is not None and a.dot(stored) < 0:
        a = -a
    # where the face starts and ends along the axis (its edges' points)
    ts = []
    for e in face.edges():
        n = 2 if e.geom_type == GeomType.LINE else 17
        ts += [(e @ (k / (n - 1)) - p0).dot(a) for k in range(n)]
    t0, t1 = min(ts), max(ts)
    zero = tangent_zero(a, ref, center=p0)
    radial = zero * math.cos(t) + a.cross(zero) * math.sin(t)
    origin = p0 + a * t0 + radial * radius
    # away from the material: the face's own normal on the line
    inward = face.normal_at(origin + a * ((t1 - t0) / 2)).dot(radial) < 0
    normal = -radial if inward else radial
    status = _worst(_status(face), _status(ref)) if isinstance(ref, Face) else _status(face)
    pl = _tag(Plane(origin=origin, x_dir=a, z_dir=normal), "tangent", status)
    centre = p0 + a * t0
    pl._plane_ref["cylinder"] = {"center": _r(centre), "axis": _r(a), "radius": round(radius, 9),
                                 "zero": _r(zero), "length": round(t1 - t0, 9), "inward": inward}
    return pl


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
    """The script-namespace PLANES, offset_plane(), edge_plane() and tangent_plane();
    edge_plane finds an edge's faces on the script's `part` as it is when
    the line runs."""
    def _edge_plane(edge, angle=0.0, from_face=None) -> Plane:
        return edge_plane(edge, angle, from_face, part=ns.get("part"))
    _edge_plane.__doc__ = edge_plane.__doc__
    return {"PLANES": Planes(), "offset_plane": offset_plane, "edge_plane": _edge_plane,
            "tangent_plane": tangent_plane}
