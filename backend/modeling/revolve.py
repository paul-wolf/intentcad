"""revolve(): the editor's Revolve — a sketch profile turned around an axis.

    part += revolve(sketch("Knob"), axis=sketch_line("Knob", "axis-v"), angle=360)
    part -= revolve(sketch("Groove"), axis=face_ref({...}), angle=P["groove_arc"])

The axis is any of:
  sketch_line(sketch, id)   a straight line of the same sketch — a built-in
                            axis, a construction or a reference line — on the
                            sketch's (rebound) plane, so it follows the sketch;
  edge_ref({...})           a straight part edge;
  face_ref({...})           a cylindrical (or conical) face: its centre axis;
  "X" / "Y" / "Z"           a base axis through the origin.

The axis must lie in the sketch's plane and the profile must stay on one side
of it (touching is fine). `angle` is (0, 360]; the profile first turns out of
the side its plane faces (a face sketch: out of the part) — `flip` turns it
the other way — and `both=True` spreads the angle evenly either side of the
sketch plane.

Called with a build123d Axis (build123d's own revolve(profiles, axis,
revolution_arc)) or inside a builder, it is build123d's revolve unchanged.

Each call is reported (bind's `report` → result["revolves"]) with the axis,
the profile's reach and side, so the editor can draw the preview's rotation
handle and mark a crossing.
"""

from __future__ import annotations

import math

from build123d import Axis, Compound, Edge, Face, GeomType, Part, Solid, Vector
from build123d import revolve as _b3d_revolve

from modeling import pattern
from modeling.edge_ref import _script_line
from modeling.sketch_profile import SketchLine

AXES = {"X": Vector(1, 0, 0), "Y": Vector(0, 1, 0), "Z": Vector(0, 0, 1)}
TILT = 1e-6        # |sin| of the angle between the axis and the plane counted as "in it"
OFF = 1e-4         # mm off the plane counted as "in it"
TOUCH = 1e-5       # mm either side of the axis counted as touching it
SAMPLES = 64       # points looked at along each profile edge for a crossing


class RevolveError(ValueError):
    pass


def _faces(profile) -> list[Face]:
    faces = profile.faces() if hasattr(profile, "faces") else []
    if not faces:
        raise RevolveError("revolve needs a closed profile (a sketch's closed shapes, or a face); "
                           f"got {type(profile).__name__}")
    for f in faces:
        if f.geom_type != GeomType.PLANE:
            raise RevolveError("revolve needs a flat profile (a sketch's closed shapes)")
    return faces


def _toward(v: Vector) -> str:
    """The base direction `v` mostly points along: "+Z", "-X"…"""
    k = max(range(3), key=lambda i: abs(v.to_tuple()[i]))
    return ("+" if v.to_tuple()[k] >= 0 else "-") + "XYZ"[k]


def _axis(axis) -> tuple[Vector, Vector, str]:
    """(a point on the axis, its unit direction, how to name it)."""
    if isinstance(axis, SketchLine):
        return axis.origin, axis.direction, axis.label
    if isinstance(axis, str):
        key = axis.strip().upper()
        if key not in AXES:
            raise RevolveError(f"a revolve axis is a sketch line, a straight edge, a cylindrical face "
                               f"or \"X\" / \"Y\" / \"Z\", not {axis!r}")
        return Vector(0, 0, 0), AXES[key], f"the {key} axis"
    if isinstance(axis, Edge):
        if axis.geom_type != GeomType.LINE:
            raise RevolveError(f"a revolve axis along an edge needs a straight edge "
                               f"(this one is a {axis.geom_type.name.lower()})")
        return axis.position_at(0), axis.tangent_at(0).normalized(), "the picked edge"
    if isinstance(axis, Face):
        ax = pattern._cyl_axis(axis)
        if ax is None:
            raise RevolveError(f"a revolve axis from a face needs a cylindrical face, its centre "
                               f"line (this one is a {axis.geom_type.name.lower()})")
        return ax[0], ax[1], "the picked cylinder's axis"
    raise RevolveError("a revolve axis is sketch_line(...), an edge (edge_ref), a cylindrical face "
                       f"(face_ref) or \"X\" / \"Y\" / \"Z\", not {type(axis).__name__}")


def _in_plane(o: Vector, d: Vector, c: Vector, n: Vector, label: str) -> None:
    """Raise unless the axis (o, d) lies in the plane through c with normal n."""
    tilt = abs(d.dot(n))
    if tilt > TILT:
        deg = math.degrees(math.asin(min(1.0, tilt)))
        if deg > 89.9:
            raise RevolveError(f"{label} runs straight out of the sketch plane (along its normal, "
                               f"{_toward(n)}), so the profile can't turn around it: pick an axis "
                               "lying in the sketch plane")
        raise RevolveError(f"{label} is tilted {deg:.1f}° out of the sketch plane: pick an axis "
                           "lying in the sketch plane (a line of the sketch, or an edge or a "
                           "cylinder parallel to it)")
    off = (o - c).dot(n)
    if abs(off) > OFF:
        side = "in front of it (the side the sketch faces" if off > 0 else "behind it (the side away from the sketch's face"
        raise RevolveError(f"{label} is {abs(off):.4g} mm off the sketch plane, {side}, "
                           f"toward {_toward(n * (1 if off > 0 else -1))}): pick an axis lying in "
                           "the sketch plane, or sketch on a plane through the axis")


def _side(faces: list[Face], o: Vector, d: Vector, n: Vector) -> tuple[float, float, list[Vector]]:
    """(least, greatest signed distance of the profile from the axis across
    the plane, points where the profile crosses the axis)."""
    across = n.cross(d).normalized()
    lo, hi, cross, ends = math.inf, -math.inf, [], []
    for f in faces:
        for e in f.edges():
            last = None          # the last sample off the axis: (point, distance)
            on = None            # the first sample on the axis since then
            for k in range(SAMPLES + 1):
                p = e.position_at(k / SAMPLES)
                s = (p - o).dot(across)
                lo, hi = min(lo, s), max(hi, s)
                if abs(s) <= TOUCH:
                    on = on or p
                    if k in (0, SAMPLES):
                        ends.append(p)
                    continue
                if last is not None and (last[1] < 0) != (s < 0):
                    cross.append(on if on is not None else last[0] + (p - last[0]) * (last[1] / (last[1] - s)))
                last, on = (p, s), None
    if lo < -TOUCH and hi > TOUCH and not cross:
        cross = ends or [o]      # it crosses where one edge ends on the axis and the next goes on
    out: list[Vector] = []
    for p in cross:
        if all((p - q).length > 1e-3 for q in out):
            out.append(p)
    return lo, hi, out


def _angle(v) -> float:
    try:
        a = float(v)
    except (TypeError, ValueError):
        raise RevolveError(f"a revolve angle is a number of degrees (got {v!r})") from None
    if not 0 < a <= 360 + 1e-9:
        raise RevolveError(f"a revolve angle is more than 0° and at most 360° (got {a:g}°)")
    return min(a, 360.0)


def make(profile, axis, angle=360, both=False, flip=False, report: list | None = None):
    faces = _faces(profile)
    a = _angle(angle)
    o, d, label = _axis(axis)
    n = faces[0].normal_at().normalized()
    c = faces[0].center()
    entry = {"line": _script_line(), "label": label, "origin": list(o.to_tuple()), "normal": list(n.to_tuple()),
             "angle": a, "both": bool(both), "flip": bool(flip)}
    try:
        _in_plane(o, d, c, n, label)
    except RevolveError as exc:
        if report is not None:
            report.append({**entry, "axis": list(d.to_tuple()), "error": str(exc)})
        raise
    lo, hi, cross = _side(faces, o, d, n)
    if cross or (lo < -TOUCH and hi > TOUCH):
        msg = (f"the profile crosses the revolve axis ({label}): a revolve would run through itself. "
               "Move the profile to one side of the axis (it may touch it) or pick another axis")
        if report is not None:
            report.append({**entry, "axis": list(d.to_tuple()), "error": msg,
                           "crossings": [list(p.to_tuple()) for p in cross]})
        raise RevolveError(msg)
    if hi <= TOUCH and lo >= -TOUCH:
        raise RevolveError(f"the profile lies along the revolve axis ({label}): it has no width to turn")
    # turn so the profile first moves toward +n (out of the face it was drawn on)
    across = n.cross(d).normalized()
    side = 1.0 if hi > TOUCH else -1.0       # which side of the axis the profile is on
    # a point at +across moves along d × across = n when turned about +d
    if side < 0:
        d = d * -1.0
    if flip:
        d = d * -1.0
    ax = Axis(o, d)
    if both:
        faces = [f.rotate(ax, -a / 2) for f in faces]
    solids = [Solid.revolve(f, a, ax) for f in faces]
    if report is not None:
        reach = max(abs(lo), abs(hi))
        arm = across * side
        report.append({**entry, "axis": list(d.to_tuple()), "arm": list(arm.to_tuple()), "radius": reach,
                       "center": list(c.to_tuple())})
    part = Part(Compound(solids).wrapped)
    return part


def bind(report: list | None = None) -> dict:
    """The script-namespace revolve(), put back after `from build123d import
    *` (which would replace it with build123d's)."""
    def revolve(profiles=None, axis=None, angle=360, both=False, flip=False, **kw):
        if profiles is None or axis is None or isinstance(axis, Axis) or kw:
            if "revolution_arc" not in kw and angle != 360:
                kw["revolution_arc"] = angle
            return _b3d_revolve(profiles, axis if axis is not None else Axis.Z, **kw)
        return make(profiles, axis, angle=angle, both=both, flip=flip, report=report)
    revolve.__doc__ = make.__doc__
    return {"revolve": revolve}
