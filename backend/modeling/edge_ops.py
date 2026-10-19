"""fillet() and chamfer(): the part editor's Fillet and Chamfer operations as
script functions. Each is one readable script line written by the editor's
dialog (paramedit.add_edge_op) and read back by it to edit it (op_at):

    part = fillet(part, edges_ref([{...}, {...}]), radius=P["fillet_r"])
    part = chamfer(part, edges_ref([{...}]), length=P["chamfer_d"])

They stand in for build123d's own fillet()/chamfer() in the script, which
still work as before when called the build123d way (fillet(edges, radius),
in a builder or not). A size that doesn't fit raises SizeError with the
largest that works (Mixin3D.fillet/chamfer are instrumented in
_engine_runner), so the editor offers the one-click fix.
"""

from __future__ import annotations

import build123d as bd


class EdgeOpError(ValueError):
    pass


def _is_solid(x) -> bool:
    """A part to work on (rather than build123d's first argument, the edges)."""
    if isinstance(x, (bd.Edge, bd.Vertex, bd.Wire)) or not isinstance(x, bd.Shape):
        return False
    try:
        return len(x.solids()) > 0
    except Exception:  # noqa: BLE001
        return False


def _edges(edges) -> list[bd.Edge]:
    if isinstance(edges, bd.Edge):
        return [edges]
    out: list[bd.Edge] = []
    for e in edges or []:
        if not isinstance(e, bd.Edge):
            raise EdgeOpError(f"expected edges (edges_ref([...])), got {type(e).__name__}")
        out.append(e)
    return out


def _target(part):
    # as build123d's fillet(): a Box etc. becomes a plain Part first
    return bd.Part(part.wrapped) if isinstance(part, bd.BasePartObject) else part


def _edge_op(kind: str, part, edges, size) -> bd.Part:
    noun = "radius" if kind == "fillet" else "length"
    if size is None:
        raise EdgeOpError(f"{kind}(): give the {noun}, e.g. {kind}(part, edges, {noun}=1)")
    s = float(size)
    if s <= 0:
        raise EdgeOpError(f"{kind}(): the {noun} must be more than 0 (got {s:g})")
    es = _edges(edges)
    if not es:
        raise EdgeOpError(f"{kind}(): no edges to {kind}")
    t = _target(part)
    new = t.fillet(s, es) if kind == "fillet" else t.chamfer(s, None, es)
    return bd.Part(bd.Compound([new]).wrapped)


def fillet(*args, **kwargs):
    """fillet(part, edges, radius=r): `part` with `edges` rounded to radius r.
    (fillet(edges, radius) is build123d's own, as before.)"""
    if args and _is_solid(args[0]):
        part, rest = args[0], list(args[1:])
        edges = rest.pop(0) if rest else kwargs.pop("edges", None)
        radius = rest.pop(0) if rest else kwargs.pop("radius", None)
        return _edge_op("fillet", part, edges, radius)
    return bd.fillet(*args, **kwargs)


def chamfer(*args, **kwargs):
    """chamfer(part, edges, length=d): `part` with `edges` bevelled d back
    along each face. (chamfer(edges, length, ...) is build123d's own.)"""
    if args and _is_solid(args[0]):
        part, rest = args[0], list(args[1:])
        edges = rest.pop(0) if rest else kwargs.pop("edges", None)
        length = rest.pop(0) if rest else kwargs.pop("length", None)
        return _edge_op("chamfer", part, edges, length)
    return bd.chamfer(*args, **kwargs)


def bind() -> dict:
    return {"fillet": fillet, "chamfer": chamfer}
