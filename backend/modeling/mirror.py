"""mirror_body() and mirrored(): the part editor's Mirror operations.

    part = mirror_body(part, PLANES["Mid"], join=True)
    part -= mirrored(extrude(sketch("USB"), amount=-P["cut1_depth"]), PLANES["Mid"])  # mirror of line 7 across Mid
    part = holes(part, at=mirrored(sketch_points("Posts"), PLANES["Mid"]), kind="insert", ...)  # mirror of line 8 across Mid
    part = fillet(part, mirrored(edges_ref([{...}]), "YZ"), radius=P["fillet_r"])  # mirror of line 9 across YZ

The plane (the same everywhere) is a flat face (face_ref({...})), "XY", "XZ"
or "YZ" through the origin, or a construction plane PLANES["name"].

mirror_body() reflects the whole part: join=True fuses the mirror with it (a
half modelled up to the plane becomes one solid), join=False keeps it as a
separate body beside it (left and right versions). gap moves the plane gap/2
away from the part, so a copy of a part touching the plane sits `gap` from it.

mirrored() reflects one step's input, so the step does the same thing on
the other side: a solid (an extrude), sketch_points() (where holes go) and
face and edge references. A reference is reflected and then found again on
the part as it is when the line runs (face_ref / edge_ref), so a fillet's
mirrored edges are the part's own edges on the other side.

A copy the editor writes carries a link comment, `# mirror of line N across
NAME`, naming the step it copies (modeling/paramedit.py keeps it in step).
"""

from __future__ import annotations

import ast

from build123d import Compound, Edge, Face, GeomType, Part, Plane, Shape, ShapeList, Vector

from modeling import edge_ref as edge_ref_mod
from modeling import face_ref as face_ref_mod
from modeling.planes import BASES, _adjacent
from modeling.sketch_profile import Points


class MirrorError(ValueError):
    pass


def mirror_plane(plane) -> Plane:
    """The plane to mirror across: a flat Face, "XY" / "XZ" / "YZ" or a Plane."""
    if isinstance(plane, Plane):
        return plane
    if isinstance(plane, str):
        key = plane.upper()
        if key not in BASES:
            raise MirrorError(f"mirror across a flat face, a construction plane or XY, XZ, YZ, not {plane!r}")
        return Plane(origin=(0, 0, 0), z_dir=BASES[key])
    if isinstance(plane, Face):
        if plane.geom_type != GeomType.PLANE:
            raise MirrorError("mirror across a flat face (this one is curved)")
        c = plane.center()
        return Plane(origin=c, z_dir=plane.normal_at(c).normalized())
    raise MirrorError("mirror across a flat face (face_ref(...)), a construction plane (PLANES[...]) "
                      f"or XY, XZ, YZ, not {type(plane).__name__}")


def _point(pl: Plane, p: Vector) -> Vector:
    n = pl.z_dir.normalized()
    return p - n * (2 * (p - pl.origin).dot(n))


def _direction(pl: Plane, d: Vector) -> Vector:
    n = pl.z_dir.normalized()
    return d - n * (2 * d.dot(n))


def outward(part, pl: Plane, gap: float) -> Plane:
    """`pl` moved gap/2 away from the part: to the side its box's centre
    isn't on (the plane's own normal when the centre is on it)."""
    if not gap:
        return pl
    n = pl.z_dir.normalized()
    side = (part.bounding_box().center() - pl.origin).dot(n)
    shift = n * (float(gap) / 2 * (1.0 if side <= 1e-9 else -1.0))
    return Plane(origin=pl.origin + shift, x_dir=pl.x_dir, z_dir=pl.z_dir)


def _image(part, plane, gap: float):
    if part is None or not hasattr(part, "solids"):
        raise MirrorError("mirror_body(): there is no part to mirror yet")
    return part.mirror(outward(part, mirror_plane(plane), gap))


def mirror_body(part, plane, join: bool = True, gap: float = 0.0):
    """`part` and its mirror image across `plane`: fused into one (join=True)
    or as a separate body beside it (join=False), the plane moved gap/2 away
    from the part (outward)."""
    other = _image(part, plane, gap)
    if join:
        out = part + other
        return out if isinstance(out, Part) else Part(Compound([out]).wrapped)
    return Part(Compound(list(part.solids()) + list(other.solids())).wrapped)


# --- reflecting stored references: mirrored(edges_ref([...]), PLANE) reflects the
# descriptors written in the line and finds the reflected ones on the part. The
# originals aren't looked up at all: by the time the copy's line runs the
# original step may have changed them (a fillet rounds its edges away).

REF_FNS = {"face_ref": "face", "edge_ref": "edge", "edges_ref": "edges"}


class Refs:
    """face_ref / edge_ref / edges_ref's arguments, not yet looked up."""

    def __init__(self, kind: str, data, on=None):
        self.kind, self.data, self.on = kind, data, on


# the copies whose references are left unresolved (pattern.py's patterned() too)
COPY_FNS = ("mirrored", "patterned")


class _Defer(ast.NodeTransformer):
    def visit_Call(self, node):
        self.generic_visit(node)
        if (isinstance(node.func, ast.Name) and node.func.id in COPY_FNS and node.args
                and isinstance(a := node.args[0], ast.Call) and isinstance(a.func, ast.Name)
                and a.func.id in REF_FNS and len(a.args) == 1):
            node.args[0] = ast.copy_location(
                ast.Call(func=ast.Name(id="_mirror_refs", ctx=ast.Load()),
                         args=[ast.Constant(REF_FNS[a.func.id]), a.args[0]], keywords=a.keywords), a)
        return node


def defer_refs(tree: ast.Module) -> ast.Module:
    """The script with each face_ref / edge_ref / edges_ref written straight
    into mirrored() (or patterned()) left unresolved (a Refs) for it to
    reflect (or move)."""
    return ast.fix_missing_locations(_Defer().visit(tree))


def _vec(v) -> Vector:
    return Vector(float(v[0]), float(v[1]), float(v[2]))


def _r(v: Vector, n: int = 3) -> list[float]:
    return [round(v.X, n) + 0.0, round(v.Y, n) + 0.0, round(v.Z, n) + 0.0]


def map_face(ref: dict, point, direction) -> dict:
    """A face reference (face_ref.describe) moved by a rigid motion (or a
    reflection): `point` and `direction` map a Vector."""
    n0 = _vec(ref["normal"]).normalized()
    c0 = _vec(ref["center"])
    n1 = direction(n0).normalized()
    out = {**ref, "center": _r(point(c0)), "normal": _r(n1, 4)}
    out.pop("hint", None)
    box = ref.get("box")
    if box:
        # its outline's corners, on the face's plane, moved and measured in the new basis
        b0, b1 = face_ref_mod.basis(n0), face_ref_mod.basis(n1)
        along = c0.dot(n0)
        pts = [b1.to_local_coords(point(b0.from_local_coords((u, v, along))))
               for u in (box[0], box[2]) for v in (box[1], box[3])]
        out["box"] = [round(min(p.X for p in pts), 3), round(min(p.Y for p in pts), 3),
                      round(max(p.X for p in pts), 3), round(max(p.Y for p in pts), 3)]
    return out


def map_edge(ref: dict, point, direction) -> dict:
    """An edge reference (edge_ref.describe) moved like map_face(), its hint
    worded for where it is now ("top-left edge")."""
    out = {**ref}
    frefs = [map_face(f, point, direction) for f in ref.get("faces") or []]
    out["faces"] = [{**f, "hint": edge_ref_mod.face_hint(f)} for f in frefs]
    out["midpoint"] = _r(point(_vec(ref["midpoint"])))
    if ref.get("direction"):
        out["direction"] = _r(direction(_vec(ref["direction"])), 4)
    if ref.get("center"):
        out["center"] = _r(point(_vec(ref["center"])))
    if ref.get("axis"):
        out["axis"] = _r(direction(_vec(ref["axis"])), 4)
    closed = str(ref.get("hint") or "").startswith("Ø")
    out["hint"] = edge_ref_mod.hint(ref.get("kind") or "edge", frefs, ref.get("radius"), closed)
    return out


def reflect_face(ref: dict, pl: Plane) -> dict:
    """A face reference (face_ref.describe) reflected across `pl`."""
    return map_face(ref, lambda p: _point(pl, p), lambda d: _direction(pl, d))


def reflect_edge(ref: dict, pl: Plane) -> dict:
    """An edge reference (edge_ref.describe) reflected across `pl`, its hint
    worded for where it is now ("top-left edge")."""
    return map_edge(ref, lambda p: _point(pl, p), lambda d: _direction(pl, d))


def bind(ns: dict) -> dict:
    """The script-namespace mirror_body() and mirrored(); mirrored references
    are found again on the script's `part` as it is when the line runs, with
    the script's own face_ref / edge_ref (so each lookup is reported)."""

    def find_face(face: Face, pl: Plane) -> Face:
        ref = face_ref_mod.describe(face.mirror(pl))
        ref["hint"] = f"mirrored {edge_ref_mod.face_hint(ref)}"
        return ns["face_ref"](ref)

    def find_edge(edge: Edge, pl: Plane) -> Edge:
        faces = list(getattr(edge, "_ref_faces", None) or _adjacent(ns.get("part"), edge))[:2]
        if len(faces) < 2:
            raise MirrorError("mirrored(): can't tell which faces this edge lies between, to find its mirror")
        frefs = [face_ref_mod.describe(f.mirror(pl)) for f in faces]
        ref = edge_ref_mod.describe(edge.mirror(pl), frefs)
        ref["hint"] = f"mirrored {ref['hint']}"
        return ns["edge_ref"](ref)

    def mirrored(obj, plane):
        """`obj` reflected across `plane`: a solid, sketch_points(), or face /
        edge references (found again on the part, on the other side)."""
        pl = mirror_plane(plane)
        if isinstance(obj, Refs):
            on = {"on": obj.on} if obj.on is not None else {}
            if obj.kind == "face":
                ref = reflect_face(obj.data, pl)
                ref["hint"] = f"mirrored {edge_ref_mod.face_hint(ref)}"
                return ns["face_ref"](ref, **on)
            if obj.kind == "edge":
                return ns["edge_ref"](reflect_edge(obj.data, pl), **on)
            return ns["edges_ref"]([reflect_edge(r, pl) for r in obj.data or []], **on)
        if isinstance(obj, Points):
            return Points([_point(pl, Vector(p)) for p in obj], _direction(pl, Vector(obj.normal)), obj.name)
        if isinstance(obj, Face) and hasattr(obj, "_ref_status"):
            return find_face(obj, pl)
        if isinstance(obj, Edge) and hasattr(obj, "_ref_status"):
            return find_edge(obj, pl)
        if isinstance(obj, (list, tuple, ShapeList)) and obj and all(
                isinstance(x, (Face, Edge)) and hasattr(x, "_ref_status") for x in obj):
            out = [find_face(x, pl) if isinstance(x, Face) else find_edge(x, pl) for x in obj]
            return ShapeList(out)
        if isinstance(obj, Shape):
            return obj.mirror(pl)
        if isinstance(obj, (list, tuple)) and obj and all(isinstance(x, Shape) for x in obj):
            return [x.mirror(pl) for x in obj]
        raise MirrorError("mirrored() reflects a solid (an extrude), sketch_points(), face_ref() or edges_ref(), "
                          f"not {type(obj).__name__}")

    def mirror_copy(part, plane, join: bool = True, gap: float = 0.0):
        """mirror_body()'s mirror image alone (the editor's preview draws it
        in its own colour); `join` is taken and ignored."""
        return _image(part, plane, gap)

    return {"mirror_body": mirror_body, "mirrored": mirrored, "_mirror_refs": Refs, "_mirror_copy": mirror_copy}
