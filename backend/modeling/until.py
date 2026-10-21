"""extrude(..., until=...): the part editor's Up to face and Up to next.

    part += extrude(sketch("Boss"), until="next", dir=-1)
    part -= extrude(sketch("Set screw"), until="next")
    part += extrude(sketch("Rib"), until=face_ref({...}), offset=P["rib_gap"])

`dir` is +1 along the sketch's normal (the way extrude(amount=+d) goes) or -1
against it; paramedit.add_extrude writes it with the same sign logic as an
amount.

Up to face: the extrude runs from the sketch to the face's surface, extended
past the face's own edges (a plane as far as needed, a cylinder all the way
round), so the end is shaped like the face: slanted for a slanted wall, curved
for a tube. offset > 0 goes that far past the surface, < 0 stops short of it.
When the face isn't that way it tries the other way (the face decides where
the extrude goes); a face it can't reach either way is an error naming it.
Up to next does the same when it meets nothing at all that way (a sketch on
a tangent plane faces out of the hub: the set screw still goes in), so `dir`
says which way to look first.

Up to next: each ray from the sketch stops at the first face of the part it
meets. A join grows through empty space until it meets material (a standoff
from a lid down to the floor); a cut (`part -= ...`: the engine tags the call
with _cut=True, see tag_cuts) runs through empty space and then material until
it first breaks out into empty space again (a set screw through the hub wall
into the bore, not out of the far side).

How it is built (build123d's extrude(until=Until.NEXT) picks one surface for
the whole profile, by distance, and so can't stop each region at its own face
or tell a cut starting on the surface from one that ends there):

  1. each face of the sketch is extruded far enough to pass the part (T);
  2. Up to next: T is cut into pieces of empty space (T - part) and of
     material (T & part); a piece is "lit" when the way back from it to the
     sketch crosses no material (sampled from just inside each of its faces).
     A join keeps the lit empty pieces, a cut the lit empty and lit material
     pieces. Each region stops at its own face this way, and a step under one
     region is filled exactly;
  3. Up to face: T is split by the (offset, extended) surface and the pieces
     touching the sketch are kept.

Limits (each a clear error, never a wrong shape): a piece that is partly lit
and partly in the shadow of something above it (a join reaching under an
overhang, a cut whose profile is half over a bridge); a join that doesn't meet
the part everywhere (part of the profile hanging past it); a join that starts
inside material; a face it never reaches.

mirrored() / patterned() of an until extrude (a Mirror / Pattern copy) don't
move the solid the original made: they move the sketch and its direction (and
the until face, found again on the part where the copy goes) and run the
extrude again, so "next" is evaluated for each copy.
"""

from __future__ import annotations

import ast
import math

import build123d as bd
from build123d import Compound, Edge, Face, GeomType, Location, Part, Solid, Vector
from OCP.BRep import BRep_Tool
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Splitter
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.BRepTools import BRepTools
from OCP.Geom import Geom_OffsetSurface
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCP.GeomLProp import GeomLProp_SLProps
from OCP.gp import gp_Pnt
from OCP.TopTools import TopTools_ListOfShape

TOL = 1e-4      # lengths below this are touching, not crossing (mm)
NUDGE = 1e-2    # how far inside a piece its sample points are (mm)


class UntilError(ValueError):
    pass


def _going(d: Vector) -> str:
    """The way `d` points, in words ("down", "toward +X")."""
    axes = [("X", d.X), ("Y", d.Y), ("Z", d.Z)]
    name, v = max(axes, key=lambda a: abs(a[1]))
    if name == "Z":
        return "up" if v > 0 else "down"
    return f"toward {'+' if v > 0 else '-'}{name}"


def _solids(shape) -> list[Solid]:
    return list(shape.solids()) if shape is not None else []


def _faces(obj) -> list[Face]:
    if isinstance(obj, Face):
        return [obj]
    if isinstance(obj, (list, tuple)):
        return [f for x in obj for f in _faces(x)]
    if hasattr(obj, "faces"):
        return list(obj.faces())
    raise UntilError(f"extrude(until=...) extrudes a sketch (sketch(\"name\")), not {type(obj).__name__}")


def _samples(face: Face, n: int) -> list[Vector]:
    """Up to `n` points on `face` (its largest triangles' centres)."""
    try:
        verts, tris = face.tessellate(0.05, 0.3)
    except Exception:  # noqa: BLE001
        return [face.center()]
    pts = []
    for a, b, c in tris:
        pa, pb, pc = verts[a], verts[b], verts[c]
        pts.append(((pb - pa).cross(pc - pa).length, (pa + pb + pc) / 3))
    pts.sort(key=lambda x: -x[0])
    return [p for _, p in pts[:n]] or [face.center()]


def _inside_points(cell: Solid, per_face: int = 1, limit: int = 24) -> list[Vector]:
    """Points just inside `cell`, one by each of its faces (its biggest first)."""
    out = []
    for f in sorted(cell.faces(), key=lambda f: -f.area)[:limit]:
        for p in _samples(f, per_face):
            try:
                n = f.normal_at(p)
            except Exception:  # noqa: BLE001
                continue
            for q in (p - n * NUDGE, p + n * NUDGE):
                if cell.is_inside(q, TOL / 10):
                    out.append(q)
                    break
    return out


def _span(part, at: Vector, d: Vector) -> float:
    """How far along `d` from `at` the part's box reaches."""
    bb = part.bounding_box()
    lo, hi = Vector(bb.min), Vector(bb.max)
    far = max((Vector(x, y, z) - at).dot(d) for x in (lo.X, hi.X) for y in (lo.Y, hi.Y) for z in (lo.Z, hi.Z))
    return far


def _common_edges(part, a: Vector, b: Vector) -> list[Edge]:
    seg = Edge.make_line(a, b)
    op = BRepAlgoAPI_Common(part.wrapped, seg.wrapped)
    op.Build()
    if not op.IsDone():
        return []
    return list(Compound(op.Shape()).edges())


def _shadowed(part, q: Vector, d: Vector, origin: Vector, normal: Vector, in_material: bool) -> bool:
    """Whether the way back from `q` (against `d`) to the sketch's plane
    crosses material (other than the material `q` is in)."""
    t = (q - origin).dot(normal) / d.dot(normal)
    if t <= TOL:
        return False
    for e in _common_edges(part, q, q - d * t):
        if e.length < TOL * 10:
            continue
        if in_material and min((e @ 0 - q).length, (e @ 1 - q).length) < TOL * 10:
            continue
        return True
    return False


def _touches(cell: Solid, face: Face) -> bool:
    return cell.distance_to(face) < TOL * 10


def _split(solid: Solid, tool: Face) -> list[Solid]:
    sp = BRepAlgoAPI_Splitter()
    args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
    args.Append(solid.wrapped)
    tools.Append(tool.wrapped)
    sp.SetArguments(args)
    sp.SetTools(tools)
    sp.Build()
    if not sp.IsDone():
        raise UntilError("the extrude couldn't be split by the face it goes up to")
    return list(Compound(sp.Shape()).solids())


def _surface(face: Face, offset: float, d: Vector, near: Vector, size: float, hint: str) -> Face:
    """`face`'s surface, offset `offset` past it (along `d`), as a face
    reaching well past its own edges."""
    surf = BRep_Tool.Surface_s(face.wrapped)
    proj = GeomAPI_ProjectPointOnSurf(gp_Pnt(near.X, near.Y, near.Z), surf)
    if proj.NbPoints() == 0:
        raise UntilError(f"can't find where the {hint} is from the sketch")
    u0, v0 = proj.LowerDistanceParameters()
    props = GeomLProp_SLProps(surf, u0, v0, 1, 1e-9)
    if not props.IsNormalDefined():
        raise UntilError(f"the {hint} has no clear direction at the sketch")
    n = props.Normal()
    if offset:
        dist = offset if Vector(n.X(), n.Y(), n.Z()).dot(d) > 0 else -offset
        if face.geom_type in (GeomType.CYLINDER, GeomType.SPHERE) and face.radius + dist <= TOL:
            raise UntilError(f"offset {offset:g}: that is past the middle of the {hint} (its radius is {face.radius:g})")
        off = Geom_OffsetSurface(surf, dist)
        plain = off.Surface()  # a plane / cylinder again where there is one
        surf = off if plain is None else plain
    ul, uh, vl, vh = surf.Bounds()
    if face.geom_type == GeomType.PLANE:
        ul, uh, vl, vh = u0 - size, u0 + size, v0 - size, v0 + size
    elif face.geom_type in (GeomType.CYLINDER, GeomType.CONE):
        vl, vh = v0 - size, v0 + size
    elif face.geom_type not in (GeomType.SPHERE, GeomType.TORUS):
        ul, uh, vl, vh = BRepTools.UVBounds_s(face.wrapped)
    mk = BRepBuilderAPI_MakeFace(surf, ul, uh, vl, vh, 1e-6)
    if not mk.IsDone():
        raise UntilError(f"can't extend the {hint}'s surface to stop the extrude on")
    return Face(mk.Face())


class UntilExtrude:
    """An until extrude, before it is built: each face of the sketch and the
    way it goes, what it goes up to ("next", or a face) and how."""

    def __init__(self, pieces: list[tuple[Face, Vector]], target, offset: float, cut: bool, name: str):
        self.pieces, self.target, self.offset, self.cut, self.name = pieces, target, offset, cut, name

    def copy(self, pieces, target) -> UntilExtrude:
        return UntilExtrude(pieces, target, self.offset, self.cut, self.name)

    def __repr__(self) -> str:
        return f"extrude({self.name}, until={self.target!r})"

    def build(self, part) -> Part:
        if part is None or not hasattr(part, "faces") or not part.solids():
            raise UntilError(f"extrude {self.name} up to {'the next face' if self.target == 'next' else 'a face'}: "
                             "there is no part yet for it to meet (the first body needs a distance)")
        if self.target == "next":
            if self.offset:
                raise UntilError("offset= goes with until=a face (face_ref(...)), not until=\"next\"")
            out = [s for f, d in self.pieces for s in self._next(part, f, d)]
        elif isinstance(self.target, Face):
            out = [s for f, d in self.pieces for s in self._face(part, f, d, self.target)]
        else:
            raise UntilError(f'extrude(until=...) is "next" or a face (face_ref(...)), not {self.target!r}')
        return Part(Compound(out).wrapped)

    # -- up to next

    def _next(self, part, face: Face, d: Vector) -> list[Solid]:
        first = None
        for way in (d, -d):
            try:
                return self._first(part, face, way)
            except _Miss as miss:
                first = first or miss
        raise UntilError(str(first))

    def _first(self, part, face: Face, d: Vector) -> list[Solid]:
        o, n = face.center(), face.normal_at()
        reach = _span(part, o, d)
        if reach <= TOL:
            raise _Miss(f"{self.name} never meets the part going {_going(d)}: the part is all behind the sketch "
                             "(flip the direction)")
        length = reach + 1.0
        tool = Solid.extrude(face, d * length)
        far = face.moved(Location(d * length))
        mat = _solids(tool.intersect(part))
        if not mat:
            raise _Miss(f"{self.name} never meets the part going {_going(d)}")
        # a cut takes the material it reaches first (cutting empty space does
        # nothing); a join, the empty space before the material it meets
        cells = mat if self.cut else _solids(tool.cut(part))
        kept = []
        for c in cells:
            if c.volume < TOL:
                continue
            shade = {_shadowed(part, q, d, o, n, self.cut) for q in _inside_points(c)}
            if False not in shade:
                continue
            if not self.cut and _touches(c, far):
                raise UntilError(f"part of {self.name} never meets the part going {_going(d)}: it would grow on "
                                 "past it (keep the sketch over the part, or use a distance)")
            if True in shade:
                raise UntilError(
                    f"{self.name} can't stop at the next face here: part of it is under something it reaches "
                    "first (an overhang or a bridge above the rest). Up to face, a distance, or splitting the "
                    "sketch into separate shapes for each part works")
            kept.append(c)
        if not kept and self.cut:
            raise _Miss(f"{self.name} doesn't reach the part going {_going(d)}, so there is nothing to cut")
        if not kept:
            raise UntilError(f"{self.name} starts inside the part going {_going(d)}: Up to next grows it from the "
                             "sketch to the first face it meets, through empty space (flip the direction)")
        return kept

    # -- up to face

    def _face(self, part, face: Face, d: Vector, target: Face) -> list[Solid]:
        hint = getattr(target, "_ref_hint", None) or "face"
        first = None
        for way in (d, -d):
            try:
                return self._to(part, face, way, target, hint)
            except _Miss as miss:
                first = first or miss
        raise UntilError(str(first))

    def _to(self, part, face: Face, d: Vector, target: Face, hint: str) -> list[Solid]:
        o = face.center()
        boxes = Compound([part, target]) if part is not None else target
        length = max(_span(boxes, o, d), 0.0) + abs(self.offset) + 0.25 * boxes.bounding_box().diagonal + 1.0
        tool = Solid.extrude(face, d * length)
        size = 2 * (Compound([boxes, tool]).bounding_box().diagonal + length)
        stop = _surface(target, self.offset, d, o, size, hint)
        far = face.moved(Location(d * length))
        starts = [p + d * NUDGE for p in _samples(face, 16)]
        kept = [c for c in _split(tool, stop) if any(c.is_inside(p, TOL / 10) for p in starts)]
        if not kept or all(_touches(c, far) for c in kept) and abs(sum(c.volume for c in kept) - tool.volume) < 1e-6 * tool.volume + TOL:
            raise _Miss(f"{self.name} never reaches the {hint}")
        if any(_touches(c, far) for c in kept):
            raise UntilError(f"part of {self.name} never reaches the {hint} going {_going(d)}: the face's surface "
                             "doesn't cover all of the sketch (keep the sketch in front of it)")
        return kept


class _Miss(UntilError):
    pass


def _ours(until) -> bool:
    return isinstance(until, (str, Face)) or (hasattr(until, "kind") and hasattr(until, "data"))


def bind(ns: dict) -> dict:
    """The script-namespace extrude(): build123d's, plus until="next" /
    until=a face (with offset= and dir=); and _extrude_recipe(), the same
    arguments not yet built, for mirrored() / patterned() to move."""

    def recipe(to_extrude=None, amount=None, dir=None, until=None, target=None, offset=None,  # noqa: A002
               _cut: bool = False) -> UntilExtrude:
        if amount is not None:
            raise UntilError("extrude(): until= goes instead of amount=, not with it")
        if isinstance(until, str) and until != "next":
            raise UntilError(f'extrude(until={until!r}): until is "next" or a face (face_ref(...))')
        if dir not in (None, 1, -1):
            raise UntilError(f"extrude(until=...): dir is 1 (along the sketch's normal) or -1 (against it), not {dir!r}")
        sign = -1 if dir == -1 else 1
        name = getattr(to_extrude, "_sketch_name", None)
        label = f"“{name}”" if name else "the sketch"
        pieces = [(f, f.normal_at() * sign) for f in _faces(to_extrude)]
        if not pieces:
            raise UntilError(f"{label} has no closed shapes to extrude")
        return UntilExtrude(pieces, until, float(offset or 0.0), bool(_cut), label)

    def extrude(to_extrude=None, amount=None, dir=None, until=None, target=None, both=False, taper=0.0,  # noqa: A002
                clean=True, mode=bd.Mode.ADD, offset=None, _cut: bool = False):
        """build123d's extrude(), plus until="next" or until=a face (Up to
        next / Up to face, modeling/until.py)."""
        if not _ours(until):
            if offset is not None:
                raise UntilError("extrude(): offset= goes with until=a face (face_ref(...))")
            return bd.extrude(to_extrude, amount, dir, until, target, both, taper, clean, mode)
        if both:
            raise UntilError("extrude(until=...) goes one way: both=True is for a distance")
        return recipe(to_extrude, amount, dir, until, target, offset, _cut).build(ns.get("part"))

    return {"extrude": extrude, "_extrude_recipe": recipe}


EXTRUDES = ("extrude", "_extrude_recipe")


def _until_calls(node) -> list[ast.Call]:
    return [n for n in ast.walk(node) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
            and n.func.id in EXTRUDES and any(k.arg == "until" for k in n.keywords)]


class _Tag(ast.NodeTransformer):
    def visit_AugAssign(self, node):
        if isinstance(node.op, ast.Sub):
            _mark(node.value)
        return node

    def visit_BinOp(self, node):
        self.generic_visit(node)
        if isinstance(node.op, ast.Sub):
            _mark(node.right)
        return node


def _mark(node) -> None:
    for c in _until_calls(node):
        if not any(k.arg == "_cut" for k in c.keywords):
            c.keywords.append(ast.keyword(arg="_cut", value=ast.Constant(True)))


def tag_cuts(tree: ast.Module) -> ast.Module:
    """The script with each until extrude that is cut from the part
    (`part -= extrude(..., until=...)`, or `a - extrude(...)`) told so:
    `_cut=True` (Up to next stops a cut where it breaks out of material, a
    join where it meets material)."""
    return ast.fix_missing_locations(_Tag().visit(tree))
