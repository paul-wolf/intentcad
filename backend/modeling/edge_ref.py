"""edge_ref(ref): an edge of the part named by the two faces it lies between,
found again on the part as it is when the line runs. edges_ref([...]) does a
list of them (a fillet's edges; a loop is stored as its edges, one by one).

Edge indices change whenever the part does, so a script line that works on
particular edges stores what the edge looks like instead:

    {"faces": [face ref, face ref],     the two faces it borders (face_ref.py)
     "kind": "line",                    or "circle", "bspline", ...
     "midpoint": [x,y,z], "length": l,
     "direction": [x,y,z],              a line: its direction
     "center": [x,y,z], "radius": r, "axis": [x,y,z],   a circle or arc
     "hint": "top-front edge"}          what to call it in a message

find() finds the two faces again with face_ref's matching (the first few
candidates of each, so a face that is momentarily ambiguous still pairs up),
takes the edges each pair shares and chooses the one nearest the stored
midpoint (along the line, for a straight edge: the two faces fix the line it
is on, so only where along it can differ). When the faces can't be found as
a pair sharing an edge, it falls back to the edge that looks most alike
nearby — kind, direction or radius, midpoint — and says "ambiguous".
"""

from __future__ import annotations

import math
import sys

from build123d import Edge, Face, ShapeList, Vector

from modeling import face_ref
from modeling.face_ref import vec

# a line edge is parallel to the stored one when |cos| is at least this
SAME_DIR = 0.999
# how many candidates of each face are paired up
TRY = 3
# the runner-up edge scoring within this fraction of the best is ambiguous
AMBIGUOUS = 0.10
# a same-kind radius may differ by this much (log ratio) in the fallback
RADIUS_LOG = 0.4

_WORDS = [(2, 1, "top"), (2, -1, "bottom"), (1, -1, "front"), (1, 1, "back"), (0, 1, "right"), (0, -1, "left")]


class EdgeRefError(ValueError):
    pass


def _word(fref: dict) -> str | None:
    """'top', 'front', ... for an axis-aligned flat face, else None."""
    if fref.get("kind"):
        return None
    n = fref.get("normal") or [0, 0, 0]
    for axis, sign, w in _WORDS:
        if n[axis] * sign > 0.999:
            return w
    return None


def face_hint(fref: dict) -> str:
    """What the editor calls a face (OpDialogs' faceHint): 'top face',
    'angled face', 'cylinder face'."""
    if fref.get("kind"):
        return f"{fref['kind']} face"
    w = _word(fref)
    return f"{w} face" if w else "angled face"


def _num(x: float) -> str:
    return f"{x:.2f}".rstrip("0").rstrip(".")


def hint(kind: str, frefs: list[dict], radius: float | None = None, closed: bool = False) -> str:
    """'top-front edge', 'Ø6 circle on the top face', 'R2 arc on the top face',
    'edge of the top face'."""
    words = [w for w in (_word(f) for f in frefs) if w]
    order = [w for _, _, w in _WORDS]
    words.sort(key=order.index)
    on = f" on the {words[0]} face" if words else ""
    if kind == "circle" and radius:
        return f"Ø{_num(2 * radius)} circle{on}" if closed else f"R{_num(radius)} arc{on}"
    if kind == "line":
        if len(words) == 2:
            return f"{words[0]}-{words[1]} edge"
        return f"edge of the {words[0]} face" if words else "edge"
    return f"{kind} edge{on}"


def _circle(edge: Edge) -> tuple[Vector, float, Vector] | None:
    """A circular edge's centre, radius and axis."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GeomAbs import GeomAbs_Circle

    try:
        c = BRepAdaptor_Curve(edge.wrapped)
        if c.GetType() != GeomAbs_Circle:
            return None
        circ = c.Circle()
        p, d = circ.Location(), circ.Axis().Direction()
        return Vector(p.X(), p.Y(), p.Z()), float(circ.Radius()), Vector(d.X(), d.Y(), d.Z())
    except Exception:  # noqa: BLE001
        return None


def _kind(edge: Edge) -> str:
    return edge.geom_type.name.lower()


def midpoint(edge: Edge) -> Vector:
    return edge @ 0.5


def _r(v: Vector, n: int = 3) -> list[float]:
    return [round(v.X, n), round(v.Y, n), round(v.Z, n)]


def describe(edge: Edge, frefs: list[dict]) -> dict:
    """The reference for `edge`, given the references of the two faces it
    borders (face_ref.describe; each gets its hint here)."""
    frefs = [{**f, "hint": f.get("hint") or face_hint(f)} for f in frefs]
    kind = _kind(edge)
    m = midpoint(edge)
    ref: dict = {"faces": frefs, "kind": kind, "midpoint": _r(m), "length": round(float(edge.length), 3)}
    radius = None
    if kind == "line":
        d = (edge @ 1 - edge @ 0).normalized()
        ref["direction"] = _r(d, 4)
    elif kind == "circle":
        circ = _circle(edge)
        if circ:
            c, radius, ax = circ
            ref.update(center=_r(c), radius=round(radius, 4), axis=_r(ax, 4))
    ref["hint"] = hint(kind, frefs, radius, bool(edge.is_closed))
    return ref


def _shared(fa, fb) -> list[Edge]:
    eb = fb.edges()
    return [e for e in fa.edges() if any(e.wrapped.IsSame(x.wrapped) for x in eb)]


def _gap(ref: dict, edge: Edge) -> float:
    """How far `edge` is from where the reference's edge was: along the line
    for a straight edge (its faces fix the line), else midpoint to midpoint."""
    d = midpoint(edge) - vec(ref["midpoint"])
    if ref.get("kind") == "line" and ref.get("direction"):
        return abs(d.dot(vec(ref["direction"]).normalized()))
    return d.length


def _alike(ref: dict, edge: Edge) -> bool:
    """`edge` is the same kind of edge as the reference's, facing the same way."""
    kind = ref.get("kind")
    if _kind(edge) != kind:
        return False
    if kind == "line" and ref.get("direction"):
        d = (edge @ 1 - edge @ 0).normalized()
        return abs(d.dot(vec(ref["direction"]).normalized())) >= SAME_DIR
    if kind == "circle" and ref.get("radius"):
        circ = _circle(edge)
        if not circ:
            return False
        _, r, ax = circ
        return (abs(math.log(r / float(ref["radius"]))) <= RADIUS_LOG
                and abs(ax.normalized().dot(vec(ref["axis"]).normalized())) >= SAME_DIR)
    return True


def find(part, ref: dict) -> dict:
    """The edge of `part` that `ref` names: {"status", "edge", "moved_by"}.

    status is "found", "ambiguous" (another edge scored within 10%, or the
    faces weren't found and the edge was matched on looks alone — the best is
    still given) or "not_found" (edge None). Raises on a reference it can't
    read."""
    fa, fb = ref["faces"][:2]
    length0 = float(ref.get("length") or 1.0)
    scale = max(length0, 1.0)
    m0 = vec(ref["midpoint"])
    none = {"status": "not_found", "edge": None, "moved_by": None}
    # the two faces, the first few candidates of each, paired up
    sa, ra = face_ref.rank(part, fa)
    sb, rb = face_ref.rank(part, fb)
    ra = [t for t in ra[:TRY] if t[3] or t[1] <= sa]   # as face_ref.find's not_found
    rb = [t for t in rb[:TRY] if t[3] or t[1] <= sb]
    scored: list[tuple[float, Edge, Face, Face]] = []
    for ta in ra:
        for tb in rb:
            if ta[5].wrapped.IsSame(tb[5].wrapped):
                continue
            shared = _shared(ta[5], tb[5])
            same = [e for e in shared if _kind(e) == ref.get("kind")] or shared
            for e in same:
                scored.append((ta[0] + tb[0] + _gap(ref, e) / scale, e, ta[5], tb[5]))
    if scored:
        scored.sort(key=lambda t: t[0])
        best, edge, f0, f1 = scored[0]
        status = "found"
        rival = next((s for s, e, *_ in scored[1:] if not e.wrapped.IsSame(edge.wrapped)), None)
        if rival is not None and rival <= best * (1 + AMBIGUOUS) + 1e-9:
            status = "ambiguous"
        edge._ref_faces = (f0, f1)    # the ref's two faces, in its order (planes.edge_plane)
        return {"status": status, "edge": edge, "moved_by": (midpoint(edge) - m0).length}
    # the faces aren't there as a pair: the edge most like it, nearby
    reach = max(0.5 * length0, 3.0)
    alike = []
    for e in part.edges():
        if not _alike(ref, e):
            continue
        d = (midpoint(e) - m0).length
        if d > reach:
            continue
        alike.append((d / scale + abs(math.log(max(float(e.length), 1e-9) / length0)), d, e))
    if not alike:
        return none
    alike.sort(key=lambda t: t[0])
    return {"status": "ambiguous", "edge": alike[0][2], "moved_by": alike[0][1]}


def _as_found(edge: Edge | None) -> dict:
    """What the editor shows of an edge found: its length, middle and radius now."""
    if edge is None:
        return {"length": None, "midpoint": None, "radius": None}
    circ = _circle(edge) if _kind(edge) == "circle" else None
    return {"length": round(float(edge.length), 6), "midpoint": _r(midpoint(edge)),
            "radius": round(circ[1], 4) if circ else None}


def _script_line() -> int | None:
    """The line of the script (1-based, as the editor numbers it) that is
    running: the engine runs it as "<script>" behind a one-line prefix."""
    f = sys._getframe(1)
    while f is not None:
        if f.f_code.co_filename == "<script>":
            return f.f_lineno - 1
        f = f.f_back
    return None


def bind(ns: dict, report: list | None = None) -> dict:
    """The script-namespace edge_ref() and edges_ref(): resolve against the
    script's `part` as it is when the line runs (or `on=`). Each lookup is
    recorded in `report` as {"hint", "status", "moved_by", "length",
    "midpoint" and "radius" (of the edge found), "line" (the script line)}; an edge that isn't there any
    more raises, naming it."""
    def edge_ref(ref: dict, on=None) -> Edge:
        """The edge of the part that `ref` describes (see modeling/edge_ref.py)."""
        part = on if on is not None else ns.get("part")
        name = (ref or {}).get("hint") or "edge"
        if part is None or not hasattr(part, "edges"):
            raise EdgeRefError(f"edge_ref({name!r}): there is no part yet to find it on")
        try:
            m = find(part, ref)
        except (KeyError, TypeError, ValueError, IndexError) as exc:
            raise EdgeRefError(f"edge_ref: can't read the reference to the {name} ({exc})") from exc
        if report is not None:
            report.append({"hint": name, "status": m["status"],
                           "moved_by": round(float(m["moved_by"]), 6) if m["moved_by"] is not None else 0.0,
                           **_as_found(m["edge"]), "line": _script_line()})
        if m["edge"] is None:
            raise EdgeRefError(f"the {name} this line refers to is no longer on the part "
                               "(the part changed too much for it to be found again): "
                               "reopen the step and pick the edge again")
        m["edge"]._ref_status = face_ref._moved_status(m["status"], m["moved_by"] or 0.0)
        return m["edge"]

    def edges_ref(refs, on=None) -> ShapeList:
        """The edges of the part that `refs` describe, each once."""
        out: list[Edge] = []
        for r in refs or []:
            e = edge_ref(r, on=on)
            if not any(e.wrapped.IsSame(x.wrapped) for x in out):
                out.append(e)
        return ShapeList(out)

    return {"edge_ref": edge_ref, "edges_ref": edges_ref}
