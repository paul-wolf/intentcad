"""Generated sketches, in the build worker: a sketch made by code instead of
drawn. The code runs with build123d, the project's parameters as PP, and:

    output(name, geometry, description=None)   a named result parts use:
                                               SK["layout"].group(name)
    check(name, ok, message="", output=None)   a design rule, shown green or red
    label(text, at)                            a note on the drawing
    dim(p1, p2, text=None)                     a dimension on the drawing
    holes(points, d)                           circles of diameter d at points

Geometry is a build123d sketch, face, wire or edge, a point ((x, y) or a
Vector), or a list of them, in the sketch's plane (x right, y up). What the
run gives back (run() below) is what the server stores with the sketch: the
same profile a drawn sketch saves for parts (modeling/shared_sketch.py), each
output a group (and a named element when it is one shape), entities to draw
it with, and the run record (outputs, checks, annotations, the parameters it
read).
"""

from __future__ import annotations

import math
import re

from build123d import Circle, GeomType, Location, Pos, Shape, ShapeList, Sketch, Vector

NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_ -]{0,63}$")
XY_PLANE = {"origin": [0, 0, 0], "normal": [0, 0, 1], "xAxis": [1, 0, 0]}
CURVE_STEPS = 32       # a spline or ellipse edge drawn as this many straight pieces


class SketchCodeError(ValueError):
    pass


def _r(v: float) -> float:
    return round(float(v), 6) + 0.0      # + 0.0: no -0.0


def _xy(v) -> list[float]:
    """A build123d point as sketch (x, y): sketch y points down the screen."""
    return [_r(v.X), _r(-v.Y)]


def _g(v: float) -> str:
    return f"{round(float(v), 1):g}"


def _point(p, what: str) -> Vector:
    if isinstance(p, Vector):
        return p
    if isinstance(p, Location):
        return p.position
    if isinstance(p, (tuple, list)) and len(p) in (2, 3) and all(isinstance(c, (int, float)) for c in p):
        return Vector(*p)
    raise SketchCodeError(f"{what}: expected a point such as (x, y), not {type(p).__name__}")


class _Recording(dict):
    """PP: the project parameters, noting each one the code reads."""

    def __init__(self, values: dict, reads: dict):
        super().__init__(values)
        self._reads = reads

    def __getitem__(self, key):
        if key not in self:
            have = ", ".join(repr(n) for n in self) or "none"
            raise SketchCodeError(f"PP[{key!r}]: the project has no parameter called {key!r} "
                                  f"(Parameters on the project page; it has: {have})")
        v = super().__getitem__(key)
        self._reads[key] = v
        return v

    def get(self, key, default=None):
        if key in self:
            return self[key]
        return default


# ── geometry → loops ──

def _edge_segments(e) -> list[dict]:
    """One edge as profile segments, in sketch coordinates."""
    kind = e.geom_type
    if kind == GeomType.LINE:
        a, b = e.position_at(0), e.position_at(1)
        return [{"t": "line", "p": [_xy(a), _xy(b)]}] if (a - b).length > 1e-9 else []
    if kind == GeomType.CIRCLE:
        if e.is_closed:
            return [{"t": "circle", "c": _xy(e.arc_center), "r": _r(e.radius)}]
        return [{"t": "arc", "p": [_xy(e.position_at(0)), _xy(e.position_at(0.5)), _xy(e.position_at(1))]}]
    pts = [e.position_at(i / CURVE_STEPS) for i in range(CURVE_STEPS + 1)]
    return [{"t": "line", "p": [_xy(a), _xy(b)]} for a, b in zip(pts, pts[1:]) if (a - b).length > 1e-9]


def _ends(s: dict):
    return None if s["t"] == "circle" else (s["p"][0], s["p"][-1])


def _near(a, b) -> bool:
    return math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-4


def _chain(segs: list[dict]) -> list[list[dict]]:
    """Segments joined end to end, each chain in order (a wire's edges can
    come in any order and direction)."""
    pool = list(segs)
    out = []
    while pool:
        cur = [pool.pop(0)]
        if cur[0]["t"] == "circle":
            out.append(cur)
            continue
        grown = True
        while grown:
            grown = False
            end = cur[-1]["p"][-1]
            for i, s in enumerate(pool):
                ends = _ends(s)
                if ends is None:
                    continue
                if _near(ends[0], end):
                    cur.append(pool.pop(i)); grown = True; break
                if _near(ends[1], end):
                    cur.append({**s, "p": list(reversed(s["p"]))}); pool.pop(i); grown = True; break
        out.append(cur)
    return out


def _closed(chain: list[dict]) -> bool:
    if chain[0]["t"] == "circle":
        return True
    return _near(chain[0]["p"][0], chain[-1]["p"][-1])


def _flatten(g, what: str, out: list) -> None:
    """Into ("loop", segments) / ("open", segments) / ("point", Vector)."""
    if g is None:
        return
    if isinstance(g, (Vector, Location)) or (isinstance(g, (tuple, list)) and len(g) in (2, 3)
                                             and all(isinstance(c, (int, float)) for c in g)):
        out.append(("point", _point(g, what)))
        return
    if isinstance(g, (list, tuple, ShapeList)) and not isinstance(g, Shape):
        for x in g:
            _flatten(x, what, out)
        return
    if not isinstance(g, Shape):
        raise SketchCodeError(f"{what}: can't use a {type(g).__name__} (give a sketch, face, wire, "
                              "edge, a point (x, y), or a list of them)")
    faces = g.faces()
    if faces:
        for f in faces:
            for w in [f.outer_wire(), *f.inner_wires()]:
                for ch in _chain([s for e in w.edges() for s in _edge_segments(e)]):
                    out.append(("loop", ch))
        return
    edges = g.edges()
    if edges:
        for ch in _chain([s for e in edges for s in _edge_segments(e)]):
            out.append(("loop" if _closed(ch) else "open", ch))
        return
    for v in g.vertices():
        out.append(("point", Vector(v.X, v.Y, v.Z)))


def _bulge(s: dict) -> float:
    """A three-point arc as a polyline bulge (tan of a quarter of its angle),
    signed as utils/arcGeometry.ts: positive when the arc's middle is on the
    side of (dy, -dx) from start → end, in sketch (y-down) coordinates."""
    if s["t"] != "arc":
        return 0.0
    (ax, ay), (mx, my), (bx, by) = s["p"]
    dx, dy = bx - ax, by - ay
    d = math.hypot(dx, dy)
    if d < 1e-12:
        return 0.0
    side = (mx - (ax + bx) / 2) * (-dy / d) + (my - (ay + by) / 2) * (dx / d)
    return _r(-2 * side / d)


def _entity(eid: str, kind: str, segs: list[dict], name: str = "") -> dict:
    base = {"id": eid, "generated": True, **({"name": name} if name else {})}
    if kind == "loop" and len(segs) == 1 and segs[0]["t"] == "circle":
        c = segs[0]["c"]
        return {**base, "type": "circle", "center": {"x": c[0], "y": c[1]}, "radius": segs[0]["r"]}
    pts = [{"x": s["p"][0][0], "y": s["p"][0][1]} for s in segs]
    if kind == "open":
        pts.append({"x": segs[-1]["p"][-1][0], "y": segs[-1]["p"][-1][1]})
    bulge = [_bulge(s) for s in segs]
    return {**base, "type": "line", "points": pts, **({"closed": True} if kind == "loop" else {}),
            **({"bulge": bulge} if any(bulge) else {})}


def _bounds(parts: list) -> tuple[float, float] | None:
    xs, ys = [], []
    for kind, v in parts:
        if kind == "point":
            xs.append(v.X); ys.append(-v.Y)
            continue
        for s in v:
            if s["t"] == "circle":
                xs += [s["c"][0] - s["r"], s["c"][0] + s["r"]]
                ys += [s["c"][1] - s["r"], s["c"][1] + s["r"]]
            else:
                xs += [p[0] for p in s["p"]]; ys += [p[1] for p in s["p"]]
    if not xs:
        return None
    return max(xs) - min(xs), max(ys) - min(ys)


def _describe(parts: list) -> tuple[str, int, str]:
    """(kind, count, size in words) of an output: "36 holes Ø3.4",
    "circle Ø84", "239 × 248 mm", "4 points"."""
    loops = [v for k, v in parts if k == "loop"]
    points = [v for k, v in parts if k == "point"]
    opens = [v for k, v in parts if k == "open"]
    circles = [ch[0] for ch in loops if len(ch) == 1 and ch[0]["t"] == "circle"]
    if loops and len(circles) == len(loops) and not opens and not points:
        ds = {round(2 * c["r"], 3) for c in circles}
        n = len(circles)
        if n == 1:          # one circle may be a space rather than a hole: stack_space
            return "holes", 1, f"circle Ø{_g(ds.pop())}"
        return "holes", n, f"{n} holes Ø{_g(ds.pop())}" if len(ds) == 1 else f"{n} holes"
    if points and not loops and not opens:
        n = len(points)
        return "points", n, f"{n} point{'s' if n != 1 else ''}"
    b = _bounds(parts)
    size = f"{_g(b[0])} × {_g(b[1])} mm" if b else "empty"
    if loops:
        n = len(loops)
        return "shapes", n, size if n == 1 else f"{n} shapes, {size}"
    return "lines", len(opens), size


def build_profile(outputs: list[dict], plane: dict | None = None) -> tuple[dict, list[dict], list[dict]]:
    """(profile, entities, outputs record) from [{name, description, parts}]."""
    loops_all: list = []
    items = {"points": [], "circles": [], "lines": []}
    names: dict = {}
    groups: dict = {}
    sub: dict = {}
    points: list = []
    lines: dict = {}
    entities: list = []
    record: list = []
    for o in outputs:
        name, parts = o["name"], o["parts"]
        ids, loops = [], []
        one = len(parts) == 1
        for n, (kind, v) in enumerate(parts):
            eid = f"g:{name}:{n}"
            ids.append(eid)
            label = name if one else ""
            if kind == "point":
                p = _xy(v)
                items["points"].append({"id": eid, "p": p})
                points.append(p)
                entities.append({"id": eid, "generated": True, "type": "point", "position": {"x": p[0], "y": p[1]},
                                 **({"name": label} if label else {})})
                continue
            entities.append(_entity(eid, kind, v, label))
            if kind == "loop":
                loops.append(v)
                if len(v) == 1 and v[0]["t"] == "circle":
                    items["circles"].append({"id": eid, "c": v[0]["c"], "r": v[0]["r"]})
                else:
                    for s in v:
                        if s["t"] == "line":
                            items["lines"].append({"id": eid, "p": s["p"]})
            else:
                for s in v:
                    if s["t"] == "line":
                        items["lines"].append({"id": eid, "p": s["p"]})
                if len(v) == 1 and v[0]["t"] == "line":
                    lines[eid] = v[0]["p"]
        loops_all += loops
        groups[name] = ids
        sub[f"g:{name}"] = loops
        if one:
            names[name] = ids[0]
            sub[f"n:{name}"] = loops
        kind, count, size = _describe(parts)
        record.append({"name": name, "description": o.get("description") or "", "kind": kind,
                       "count": count, "size": size})
    profile = {"plane": plane or XY_PLANE, "loops": loops_all, "points": points, "lines": lines,
               "items": items, "names": names, "groups": groups, "sub": sub}
    return profile, entities, record


# ── the code's namespace ──

def bind(pp: dict, state: dict) -> dict:
    """PP and the sketch functions; what the code makes goes into `state`:
    {"outputs": [...], "checks": [...], "labels": [...], "dims": [...], "reads": {...}}."""
    state.setdefault("outputs", [])
    state.setdefault("checks", [])
    state.setdefault("labels", [])
    state.setdefault("dims", [])
    state.setdefault("reads", {})

    def output(name, geometry, description=None):
        if not isinstance(name, str) or not NAME.match(name):
            raise SketchCodeError(f"output({name!r}, …): a name is letters, digits and _ (such as \"brace_holes\")")
        if any(o["name"] == name for o in state["outputs"]):
            raise SketchCodeError(f"output({name!r}, …) is made twice; give each output its own name")
        parts: list = []
        _flatten(geometry, f"output({name!r}, …)", parts)
        if not parts:
            raise SketchCodeError(f"output({name!r}, …) has no geometry")
        state["outputs"].append({"name": name, "description": str(description or ""), "parts": parts})
        return geometry

    def check(name, ok, message="", output=None):
        state["checks"].append({"name": str(name), "ok": bool(ok), "message": str(message or ""),
                                **({"output": str(output)} if output else {})})
        return bool(ok)

    def label(text, at):
        state["labels"].append({"text": str(text), "at": _xy(_point(at, "label(…, at)"))})

    def dim(p1, p2, text=None):
        a, b = _point(p1, "dim(p1, …)"), _point(p2, "dim(…, p2)")
        state["dims"].append({"p1": _xy(a), "p2": _xy(b),
                              "text": str(text) if text is not None else _g((a - b).length)})

    def holes(points, d):
        pts = [_point(p, "holes(points, d)") for p in (points if isinstance(points, (list, tuple, ShapeList)) else [points])]
        if not pts:
            raise SketchCodeError("holes(points, d): no points")
        if not isinstance(d, (int, float)) or d <= 0:
            raise SketchCodeError(f"holes(points, d): d is a diameter above 0, not {d!r}")
        return Sketch([Pos(p.X, p.Y) * Circle(d / 2) for p in pts])

    return {"PP": _Recording(dict(pp or {}), state["reads"]), "output": output, "check": check,
            "label": label, "dim": dim, "holes": holes}


def result(state: dict, plane: dict | None = None) -> dict:
    """What a successful run returns (see the module docstring)."""
    profile, entities, outputs = build_profile(state["outputs"], plane)
    return {"ok": True, "profile": profile, "entities": entities, "outputs": outputs,
            "checks": state["checks"], "annotations": {"labels": state["labels"], "dims": state["dims"]},
            "reads": state["reads"]}
