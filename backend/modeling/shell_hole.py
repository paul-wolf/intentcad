"""shell() and holes(): the part editor's Shell and Hole operations as script
functions. Each is one readable script line written by the editor's dialogs
(paramedit.add_shell / add_holes) and read back by them to edit it
(paramedit.op_at_line).

    part = shell(part, remove=[face_ref({...})], thickness=P["wall"], inside=True)
    part = holes(part, at=sketch_points("Standoffs"), kind="insert", size="M3",
                 depth=P["insert_depth"], standoff=dict(h=P["standoff_h"], d=P["standoff_d"], fillet=1))

Hole sizes come from modeling/hole_presets.py; P["hole_comp"] (default 0) is
added to every hole diameter, for printers whose holes come out small.
"""

from __future__ import annotations

import math

from build123d import Align, Cone, Cylinder, Face, GeomType, Kind, Plane, Vector, offset

from modeling import hole_presets


class ShellError(ValueError):
    pass


class HoleError(ValueError):
    pass


def _faces(remove) -> list[Face]:
    if remove is None:
        return []
    if isinstance(remove, Face):
        return [remove]
    out = []
    for f in remove:
        out.extend(_faces(f) if not isinstance(f, Face) else [f])
    return out


def shell(part, remove=(), thickness: float = 2.0, inside: bool = True):
    """Hollow `part` out to walls `thickness` thick, open where the `remove`
    faces were. inside=True keeps the outside where it is (the walls grow
    in); inside=False keeps the inside (the walls grow out, corners sharp).

    A thickness the part can't take raises SizeError with the largest that
    works, measured."""
    from modeling._engine_runner import _largest_ok, _size_error

    if part is None or not hasattr(part, "faces"):
        raise ShellError("shell(): there is no part to shell yet")
    t = float(thickness)
    if t <= 0:
        raise ShellError(f"shell(): the wall thickness must be more than 0 (got {thickness:g})")
    openings = _faces(remove)
    vol = float(part.volume)
    closed = None

    def attempt(th: float):
        nonlocal closed
        r = offset(part, amount=-th if inside else th, openings=openings, kind=Kind.INTERSECTION)
        if not r.is_valid or r.volume <= 1e-9:
            raise ShellError("the shell is not a valid solid")
        if inside:
            # too thick, OCCT gives the part back unhollowed
            if vol - r.volume <= 1e-3 * vol:
                raise ShellError("the walls fill the part")
        else:
            outer = offset(part, amount=th, kind=Kind.INTERSECTION).volume
            if r.volume > outer - 0.5 * vol:
                raise ShellError("the part was not hollowed")
        return r

    try:
        return attempt(t)
    except Exception as exc:  # noqa: BLE001 - OCCT raises plain Standard_Failure
        mx = _largest_ok(attempt, t)
        n = len(openings)
        what = "this part" + (f" with {n} face{'s' if n > 1 else ''} open" if n else "")
        raise _size_error(exc, "shell", what, t, mx) from exc


# --- holes -----------------------------------------------------------------

_MIN = (Align.CENTER, Align.CENTER, Align.MIN)
_MAX = (Align.CENTER, Align.CENTER, Align.MAX)
# hole tools start this far outside the face, so no face of the cut lies on it
_EPS = 0.01


def _places(at) -> list[tuple[Vector, Vector]]:
    """(point, outward normal) of each hole: a flat Face (its centre), a
    sketch_points() list (its points, its plane's normal), (point, normal)
    pairs, or a list of any of these."""
    if isinstance(at, Face):
        if at.geom_type != GeomType.PLANE:
            raise HoleError("holes go on a flat face; this one is curved")
        c = at.center()
        return [(c, at.normal_at(c).normalized())]
    normal = getattr(at, "normal", None)
    if normal is not None:
        if not len(at):
            raise HoleError(f"sketch {getattr(at, 'name', '')!r} has no points or circles to put holes at")
        n = Vector(normal).normalized()
        return [(Vector(p), n) for p in at]
    if isinstance(at, (tuple, list)) and len(at) == 2 and _is_xyz(at[0]) and _is_xyz(at[1]):
        return [(Vector(*at[0]), Vector(*at[1]).normalized())]
    if _is_xyz(at):
        raise HoleError(f"holes(at=...): the point {tuple(at)} needs its outward normal — "
                        "give (point, normal) pairs, e.g. [((x, y, z), (0, 0, 1)), …]")
    if isinstance(at, (list, tuple)):
        out = []
        for a in at:
            out.extend(_places(a))
        return out
    raise HoleError("holes(at=...): give a face, sketch_points(\"name\") or (point, normal) "
                    "pairs, e.g. [((x, y, z), (0, 0, 1)), …]")


def _is_xyz(v) -> bool:
    """A 3D point or direction: a Vector or three numbers."""
    if isinstance(v, Vector):
        return True
    return (isinstance(v, (tuple, list)) and len(v) == 3
            and all(isinstance(c, (int, float)) and not isinstance(c, bool) for c in v))


def _tool(kind: str, v: dict, depth: float):
    """The cutter for one hole, its entry at the origin, going down -Z."""
    r = v["d"] / 2
    tool = Plane.XY.offset(_EPS) * Cylinder(r, depth + _EPS, align=_MAX)
    if kind == "counterbore":
        tool += Plane.XY.offset(_EPS) * Cylinder(v["cbore_d"] / 2, v["cbore_depth"] + _EPS, align=_MAX)
    elif kind == "countersink":
        rt = v["csk_d"] / 2
        if rt > r:
            h = (rt - r) / math.tan(math.radians(v["angle"]) / 2)
            grow = _EPS * math.tan(math.radians(v["angle"]) / 2)
            tool += Plane.XY.offset(_EPS) * Cone(r, rt + grow, h + _EPS, align=_MAX)
    return tool


def holes(part, at, kind: str = "clearance", size: str = "M3", depth="through",
          fit: str = "normal", standoff: dict | None = None, d: float | None = None,
          cbore_d: float | None = None, cbore_depth: float | None = None,
          csk_d: float | None = None, angle: float | None = None, comp: float = 0.0):
    """Holes into `part` at each place of `at`, along the face's normal into
    the part. kind: clearance (fit close/normal), tapped, insert (heat-set),
    counterbore, countersink; size M2..M5. Sizes come from hole_presets;
    d/cbore_d/cbore_depth/csk_d/angle override them. depth: a number (from
    the face, or from a standoff's top) or "through". `comp` is added to
    every hole diameter (the script's P["hole_comp"]).

    standoff=dict(h, d, fillet): first a boss h high and d across grows out
    of the face at each place, its foot rounded by `fillet`; the hole goes
    into its top."""
    from build123d import fillet as _fillet

    from modeling._engine_runner import _largest_ok, _size_error

    if part is None or not hasattr(part, "faces"):
        raise HoleError("holes(): there is no part to put holes in yet")
    try:
        v = hole_presets.preset(kind, size, fit)
    except ValueError as exc:
        raise HoleError(f"holes(): {exc}") from None
    for k, x in (("d", d), ("cbore_d", cbore_d), ("cbore_depth", cbore_depth),
                 ("csk_d", csk_d), ("angle", angle)):
        if x is not None:
            v[k] = float(x)
    comp = float(comp or 0)
    for k in ("d", "cbore_d", "csk_d"):
        if k in v:
            v[k] += comp
    if v["d"] <= 0:
        raise HoleError(f"holes(): the hole diameter must be more than 0 (got {v['d']:g})")
    through = isinstance(depth, str)
    if through and depth != "through":
        raise HoleError(f"holes(): depth is a number or \"through\" (got {depth!r})")
    if not through and float(depth) <= 0:
        raise HoleError(f"holes(): the depth must be more than 0 (got {depth:g})")
    places = _places(at)
    bb = part.bounding_box()
    reach = 2 * bb.diagonal + 2 * max(bb.min.length, bb.max.length)

    lift = 0.0
    if standoff:
        sh, sd = float(standoff.get("h", hole_presets.STANDOFF_HEIGHT)), float(standoff.get("d", v["standoff_d"]))
        sf = float(standoff.get("fillet", hole_presets.STANDOFF_FILLET) or 0)
        if sh <= 0 or sd <= v["d"]:
            raise HoleError(f"holes(): a standoff needs a height above 0 and a diameter more than the "
                            f"hole's {v['d']:g} (got h={sh:g}, d={sd:g})")
        for p, n in places:
            part = part + Plane(origin=p, z_dir=n) * Cylinder(sd / 2, sh, align=_MIN)
        if sf > 0:
            feet = [e for e in part.edges() if e.geom_type == GeomType.CIRCLE
                    and abs(e.radius - sd / 2) < 1e-6
                    and any((e.arc_center - p).length < 1e-6 for p, _ in places)]
            if feet:
                base = part
                try:
                    part = _fillet(feet, sf)
                except Exception as exc:  # noqa: BLE001 - OCCT raises plain Standard_Failure
                    mx = _largest_ok(lambda r: _fillet(feet, r), sf)
                    raise _size_error(exc, "fillet", "the foot of the standoffs", sf, mx) from exc
                if not part.is_valid:
                    part = base
        lift = sh
        reach += sh

    length = reach if through else float(depth)
    tool = _tool(kind, v, length)
    cut = None
    for p, n in places:
        t = Plane(origin=p + n * lift, z_dir=n) * tool
        cut = t if cut is None else cut + t
    return part - cut


def bind(ns: dict | None = None) -> dict:
    def holes_p(part, at, *args, **kwargs):
        p = (ns or {}).get("P")
        if "comp" not in kwargs and isinstance(p, dict):
            kwargs["comp"] = p.get("hole_comp", 0)
        return holes(part, at, *args, **kwargs)
    holes_p.__doc__ = holes.__doc__
    return {"shell": shell, "holes": holes_p}
