"""auto_round: round every eligible edge of a part, robustly, in exact B-rep.

Injected into the script namespace (like ASSETS), meant as the script's last
step:

    part = auto_round(part, convex=P["round_r"], concave=P["blend_r"],
                      keep=[part.faces().sort_by(Axis.Z)[0]])

What it leaves alone — every edge on, or ending at, a protected face, so the
protected face keeps its plane, its boundary and its area exactly:
  - `keep`: faces, ShapeLists, or selector callables (evaluated on the input);
  - the bed: the lowest downward-facing planar face(s), when keep_bed;
  - hole walls: cylinders of radius <= hole_max_r with the material outside
    (a boss has it inside), when protect_holes;
plus tangent / mixed edges and edges shorter than min_edge.

Edges are classified with OCCT's BRepOffset_Analyse (right on curved faces
too). Each edge's radius is capped at max_thickness_frac x the local wall
thickness, measured by casting rays inward from both faces at a few points.

Filleting goes straight to BRepFilletAPI_MakeFillet (not the script's wrapped
`fillet`, which turns a failure into a user error): concave edges first, then
convex, each group all at once; a failing batch is split in half recursively
(between chains of connected edges where it can be), and a single failing
edge is retried once at half radius, else skipped. Every
result is checked (valid, still one solid, a plausible volume change), and the
remaining edges are found again in the new shape by midpoint + tangent +
length — edge objects from an earlier shape are never reused. Past
time_budget it stops and returns the best valid shape so far; a single
attempt that takes more than 15% of the budget (at least 1 s) counts as failed.

Every result must also leave each protected face exactly as it was — passed
through as the very same face (and the same area). OCCT carries a fillet on
along tangent-continuous edges and round reflex corners, so rounding one edge
can round others that were never asked for, ones ending at a kept face or
running down into the bed; such an edge is skipped as 'protected'.

The report goes to the `report` callback (the engine returns it as
result["auto_round"]): {rounded, skipped: [{reason, kind, polyline}], capped,
merged, protected, elapsed} — `skipped` is the eligible edges left sharp
(reason 'failed', 'protected', 'timeout' or 'thin'), `capped` the edges rounded below the
requested radius, `merged` the rounded edges a neighbouring fillet's chain took in.
"""

from __future__ import annotations

import faulthandler
import math
import os
import tempfile
import time
import warnings
from dataclasses import dataclass

from build123d import Compound, Edge, Face, Part, Shape, Solid, Vector
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.BRepGProp import BRepGProp
from OCP.BRepOffset import BRepOffset_Analyse
from OCP.BinTools import BinTools
from OCP.Bnd import Bnd_Box
from OCP.ChFiDS import ChFiDS_Concave, ChFiDS_Convex
from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane
from OCP.GeomAPI import GeomAPI_ProjectPointOnCurve
from OCP.GProp import GProp_GProps
from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_IN, TopAbs_ON, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape
from OCP.TopoDS import TopoDS, TopoDS_Shape
from OCP.gp import gp_Dir, gp_Lin, gp_Pnt

# volume a fillet may plausibly add/remove per unit edge length, in units of r²
# (a 90° edge is 0.21 r²; this allows edges down to ~20°)
_VOL_PER_R2 = 4.0
_SAMPLES = (0.2, 0.5, 0.8)   # where along an edge the wall thickness is probed
_TIMEOUT = "timeout"
_PROTECTED = "protected"
_SLOW = "slow"


@dataclass
class _Pending:
    """An edge still to round, held by its geometry (not by an edge object, which
    goes stale the moment the solid is rebuilt)."""
    kind: str          # 'convex' | 'concave'
    radius: float      # the radius to apply (requested, or capped)
    capped: bool
    mid: tuple         # midpoint
    tangent: tuple     # unit tangent at the midpoint
    length: float
    curve: object      # Geom_Curve carrier, for the on-the-same-curve test
    bbox: tuple        # (xmin, ymin, zmin, xmax, ymax, zmax), enlarged
    geom: str          # build123d geom_type name, e.g. 'LINE'
    edge: object       # the build123d Edge it was last found as (for polylines)


def _vec(v) -> tuple:
    return (v.X, v.Y, v.Z)


def _dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _dist(a, b) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def _polyline(edge) -> list[list[float]]:
    """Sampled like the engine's edge inventory (2 points for a line)."""
    n = 2 if edge.geom_type.name == "LINE" else 33
    try:
        return [list(_vec(edge @ (k / (n - 1)))) for k in range(n)]
    except Exception:
        return []


def _volume(shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return props.Mass()


def _area(face) -> float:
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, props)
    return props.Mass()


def _unique(shape, kind) -> list:
    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, kind, m)
    return [m.FindKey(i) for i in range(1, m.Extent() + 1)]


def _solids_of(shape) -> list:
    out, ex = [], TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        out.append(TopoDS.Solid_s(ex.Current()))
        ex.Next()
    return out


# ── which faces are protected ────────────────────────────────────────────────

def _keep_faces(part, keep) -> list:
    """The faces `keep` names: Faces, iterables of them (a ShapeList), or
    callables evaluated on the input part (returning either)."""
    out: list = []

    def add(item):
        if item is None:
            return
        if callable(item) and not isinstance(item, Shape):
            add(item(part))
        elif isinstance(item, Face):
            out.append(item)
        elif isinstance(item, Shape):      # a shell/solid: all of its faces
            out.extend(item.faces())
        else:
            for x in item:
                add(x)

    add(keep)
    return out


def _face_sig(f) -> tuple:
    """Where a face is and how big — to recognise it across shape copies."""
    return (_vec(f.center()), f.area)


def _is_hole_wall(f, max_r: float) -> bool:
    """A cylindrical face of radius <= max_r with the material outside it (its
    outward normal points at the axis), wrapping at least half way round — a
    hole or a slot end. A boss has the material inside; a rounded inside
    corner (a pocket's or a window's) wraps less than half way."""
    s = BRepAdaptor_Surface(f.wrapped)
    if s.GetType() != GeomAbs_Cylinder:
        return False
    cyl = s.Cylinder()
    if cyl.Radius() > max_r + 1e-9:
        return False
    try:
        if s.LastUParameter() - s.FirstUParameter() < math.pi - 1e-6:
            return False
    except Exception:
        pass
    ax = cyl.Axis()
    a, d = ax.Location(), ax.Direction()
    p = f.center()   # area centroid; for a partial wall use a point ON the face
    try:
        u0, u1, v0, v1 = s.FirstUParameter(), s.LastUParameter(), s.FirstVParameter(), s.LastVParameter()
        q = s.Value((u0 + u1) / 2, (v0 + v1) / 2)
        p = Vector(q.X(), q.Y(), q.Z())
    except Exception:
        pass
    n = f.normal_at(p)   # outward (face orientation applied)
    rel = (p.X - a.X(), p.Y - a.Y(), p.Z - a.Z())
    axial = _dot(rel, (d.X(), d.Y(), d.Z()))
    radial = (rel[0] - axial * d.X(), rel[1] - axial * d.Y(), rel[2] - axial * d.Z())
    return _dot(_vec(n), radial) < 0


def _bed_faces(part) -> list:
    """The lowest downward-facing planar face(s)."""
    down = []
    for f in part.faces():
        if BRepAdaptor_Surface(f.wrapped).GetType() != GeomAbs_Plane:
            continue
        if f.normal_at(f.center()).Z < -1 + 1e-6:
            down.append(f)
    if not down:
        return []
    z = min(f.center().Z for f in down)
    return [f for f in down if f.center().Z < z + 1e-6]


# ── wall thickness ──────────────────────────────────────────────────────────

def _thickness(solid, edge, faces, size: float) -> float:
    """The thinnest wall at the edge: rays cast inward (against each face's
    outward normal) from just inside each adjacent face, at a few points along
    the edge. inf if no ray hits anything."""
    hits = IntCurvesFace_ShapeIntersector()
    hits.Load(solid.wrapped, 1e-7)
    best = float("inf")
    step = min(0.2, edge.length * 0.05, size * 1e-3)   # off the edge, onto the face
    for t in _SAMPLES:
        p = edge @ t
        tan = (edge % t).normalized()
        for f in faces:
            n = f.normal_at(p)
            side = n.cross(tan).normalized()
            start = None
            for sgn in (1, -1):   # whichever way from the edge lies on the face
                q = p + side * (sgn * step)
                cl = BRepClass_FaceClassifier(f.wrapped, gp_Pnt(q.X, q.Y, q.Z), 1e-6)
                if cl.State() in (TopAbs_IN, TopAbs_ON):
                    start = q
                    break
            if start is None:
                continue
            n = f.normal_at(start)
            d = -n
            hits.Perform(gp_Lin(gp_Pnt(start.X, start.Y, start.Z), gp_Dir(d.X, d.Y, d.Z)),
                         size * 1e-6 + 1e-6, 1e12)
            for i in range(1, hits.NbPnt() + 1):
                w = hits.WParameter(i)
                if w > size * 1e-5 + 1e-5:
                    best = min(best, w)
    # a straight edge: the material along it, through a point just inside the
    # edge — at the end of a thin rib the wall's thickness runs along the edge
    # (a 2 mm-long end edge of a 2 mm wall), which the rays above don't see
    if edge.geom_type.name == "LINE":
        p, tan = edge @ 0.5, (edge % 0.5).normalized()
        inward = -(faces[0].normal_at(p) + faces[1].normal_at(p))
        if inward.length > 1e-6:
            q = p + inward.normalized() * step
            hits.Perform(gp_Lin(gp_Pnt(q.X, q.Y, q.Z), gp_Dir(tan.X, tan.Y, tan.Z)), -1e12, 1e12)
            ws = [hits.WParameter(i) for i in range(1, hits.NbPnt() + 1)]
            ahead, behind = [w for w in ws if w > 0], [-w for w in ws if w < 0]
            if ahead and behind:
                best = min(best, min(ahead) + min(behind))
    return best


# ── finding an edge again in a rebuilt solid ────────────────────────────────

class _EdgeIndex:
    """The edges of one solid, with what matching needs precomputed."""

    def __init__(self, solid):
        self.items = []
        for e in _unique(solid.wrapped, TopAbs_EDGE):
            if BRep_Tool.Degenerated_s(TopoDS.Edge_s(e)):
                continue
            be = Edge(TopoDS.Edge_s(e))
            try:
                self.items.append((be, _vec(be @ 0.5), _vec((be % 0.5).normalized()),
                                   be.length, be.geom_type.name))
            except Exception:
                pass

    def find(self, pe: _Pending, tol: float, taken: set):
        """The edge lying on pe's curve, inside its old extent, parallel to it and
        no longer than it (a neighbouring fillet only ever trims an edge) — the
        one whose midpoint is nearest the old midpoint."""
        b = pe.bbox
        best, best_d = None, float("inf")
        for i, (be, mid, tan, length, geom) in enumerate(self.items):
            if i in taken or geom != pe.geom or length > pe.length + tol or length < 0.05 * pe.length:
                continue
            if not (b[0] <= mid[0] <= b[3] and b[1] <= mid[1] <= b[4] and b[2] <= mid[2] <= b[5]):
                continue
            if abs(_dot(tan, pe.tangent)) < 0.999 and geom == "LINE":
                continue
            proj = GeomAPI_ProjectPointOnCurve(gp_Pnt(*mid), pe.curve)
            if proj.NbPoints() == 0 or proj.LowerDistance() > tol:
                continue
            d = _dist(mid, pe.mid)
            if d < best_d:
                best, best_d = i, d
        if best is None:
            return None
        taken.add(best)
        return self.items[best][0]


def _pending(edge, kind, radius, capped, tol) -> _Pending:
    box = Bnd_Box()
    BRepBndLib.Add_s(edge.wrapped, box)
    x0, y0, z0, x1, y1, z1 = box.Get()
    curve = BRep_Tool.Curve_s(edge.wrapped, 0.0, 1.0)
    return _Pending(kind=kind, radius=radius, capped=capped,
                    mid=_vec(edge @ 0.5), tangent=_vec((edge % 0.5).normalized()),
                    length=edge.length, curve=curve,
                    bbox=(x0 - tol, y0 - tol, z0 - tol, x1 + tol, y1 + tol, z1 + tol),
                    geom=edge.geom_type.name, edge=edge)


# ── one fillet attempt ──────────────────────────────────────────────────────

def _face_map(shape) -> TopTools_IndexedMapOfShape:
    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, TopAbs_FACE, m)
    return m


def _make_fillet(shape, edges_radii, guard=()):
    """BRepFilletAPI_MakeFillet on `shape`: (the resulting solid, the index of
    each `guard` face — given by its index in `shape`'s face map — in the
    result's face map, its volume); None if OCCT couldn't or the result isn't
    one valid solid, or _PROTECTED if a guard face didn't come through
    untouched. OCCT carries a fillet on along tangent-continuous edges,
    and round a reflex corner onto the next edge, so it can round more than it
    was asked to; a face it leaves alone is passed through as the same face."""
    try:
        mk = BRepFilletAPI_MakeFillet(shape)
        for e, r in edges_radii:
            mk.Add(r, e.wrapped)
        mk.Build()
        if not mk.IsDone():
            return None
        out = mk.Shape()
    except Exception:
        return None
    solids = _solids_of(out)
    if len(solids) != 1:
        return None
    before, after = _face_map(shape), _face_map(solids[0])
    idx = [after.FindIndex(before.FindKey(i)) for i in guard]
    if 0 in idx:
        return _PROTECTED
    # checked here, inside the deadline: BRepCheck can hang on a bad result
    if not BRepCheck_Analyzer(solids[0]).IsValid():
        return None
    return solids[0], idx, _volume(solids[0])


def _fillet_isolated(shape, edges_radii, deadline: float, guard=()):
    """_make_fillet in a forked child, so that OCCT crashing (it segfaults on
    some fillets that can't fit) or hanging costs only this attempt — not the
    engine worker, and not the time budget: the child is killed at `deadline`
    (-> _TIMEOUT). The result comes back as a binary BRep file (whose face map
    reads back in the same order) plus the guard faces' indices. Without fork
    (Windows) it runs in-process."""
    if not hasattr(os, "fork"):
        return _make_fillet(shape, edges_radii, guard)
    fd, path = tempfile.mkstemp(suffix=".brep")
    os.close(fd)
    try:
        with warnings.catch_warnings():   # "multi-threaded, fork may deadlock": the
            warnings.simplefilter("ignore", DeprecationWarning)   # child only runs OCCT
            pid = os.fork()
        if pid == 0:   # child: never return into the caller's code
            faulthandler.disable()   # an OCCT crash here is expected, not news
            status = 1
            try:
                res = _make_fillet(shape, edges_radii, guard)
                if res is _PROTECTED:
                    status = 3
                elif res is not None:
                    BinTools.Write_s(res[0], path)
                    with open(path + ".idx", "w") as fh:
                        fh.write(" ".join(map(str, [repr(res[2])] + res[1])))
                    status = 0
            finally:
                os._exit(status)
        wait = 0.001
        while True:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                break
            if time.monotonic() > deadline:
                os.kill(pid, 9)
                os.waitpid(pid, 0)
                return _TIMEOUT
            time.sleep(wait)
            wait = min(wait * 2, 0.02)
        if os.WIFEXITED(status) and os.WEXITSTATUS(status) == 3:
            return _PROTECTED
        if not (os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0):
            return None   # OCCT failed (or crashed) on these edges
        out = TopoDS_Shape()
        BinTools.Read_s(out, path)
        with open(path + ".idx") as fh:
            vol, *idx = fh.read().split()
        return out, [int(i) for i in idx], float(vol)
    finally:
        for f in (path, path + ".idx"):
            if os.path.exists(f):
                os.unlink(f)


# ── one solid ───────────────────────────────────────────────────────────────

class _Rounder:
    def __init__(self, solid, deadline: float, report: dict, attempt_cap: float = 3.0):
        self.solid = solid
        self.deadline = deadline
        self.attempt_cap = attempt_cap
        self.report = report
        bb = solid.bounding_box()
        self.size = max(bb.size.X, bb.size.Y, bb.size.Z, 1e-6)
        self.tol = self.size * 1e-6 + 1e-6
        self.guard: list[int] = []        # protected faces, by index in the face map
        self.guard_area: list[float] = []  # ... and their areas
        self.volume = _volume(solid.wrapped)
        self.next_guard, self.next_volume = self.guard, self.volume

    def skip(self, pe: _Pending, reason: str):
        self.report["skipped"].append({"reason": reason, "kind": pe.kind, "polyline": _polyline(pe.edge)})

    def try_fillet(self, edges_radii: list, kind: str):
        """The filleted solid; None if OCCT fails or the result is implausible,
        _PROTECTED if it would change a protected face, _SLOW if it used up its
        slice of the budget, or _TIMEOUT if it ran past the deadline."""
        # each attempt gets a slice of the budget: OCCT can grind on one
        # hopeless fillet for as long as it's let
        cap = min(self.deadline, time.monotonic() + self.attempt_cap)
        res = _fillet_isolated(self.solid.wrapped, edges_radii, cap, self.guard)
        if res is _TIMEOUT and cap < self.deadline:
            return _SLOW   # as good as failed
        if res is None or res is _TIMEOUT or res is _PROTECTED:
            return res
        shape, idx, after = res
        # the protected faces, found again in the result (and their areas, as a check)
        fmap = _face_map(shape)
        kept = [fmap.FindKey(i) for i in idx]
        if any(abs(_area(f) - a) > 1e-6 * max(1.0, a) for f, a in zip(kept, self.guard_area)):
            return _PROTECTED
        before = self.volume
        bound = sum(_VOL_PER_R2 * r * r * e.length for e, r in edges_radii) + before * 1e-6
        dv = after - before
        slack = before * 1e-7 + 1e-9
        ok = (-bound <= dv <= slack) if kind == "convex" else (-slack <= dv <= bound)
        if not (ok and after > 0):
            return None
        self.next_guard, self.next_volume = idx, after
        return Solid(TopoDS.Solid_s(shape))

    def accept(self, new: Solid):
        self.solid, self.guard, self.volume = new, self.next_guard, self.next_volume

    def timed_out(self, batch: list[_Pending]):
        for pe in batch:
            self.skip(pe, "timeout")

    def run_batch(self, batch: list[_Pending]):
        if not batch:
            return
        if time.monotonic() > self.deadline:
            self.timed_out(batch)
            return
        index, taken, found = _EdgeIndex(self.solid), set(), []
        for pe in batch:
            e = index.find(pe, self.tol * 10, taken)
            if e is None:
                # gone: a neighbouring fillet's tangent chain took it in,
                # so it is rounded too
                self.report["merged"] += 1
                self.report["rounded"] += 1
            else:
                pe.edge = e
                found.append(pe)
        if not found:
            return
        kind = found[0].kind
        new = self.try_fillet([(pe.edge, pe.radius) for pe in found], kind)
        if new is _TIMEOUT:
            self.timed_out(found)
            return
        if isinstance(new, Solid):
            self.accept(new)
            self.report["rounded"] += len(found)
            self.report["capped"] += sum(1 for pe in found if pe.capped)
            return
        if len(found) == 1:
            pe = found[0]
            if new is _PROTECTED:   # a smaller radius would carry on just the same
                self.skip(pe, "protected")
                return
            if new is _SLOW:        # and would grind on just as long
                self.skip(pe, "failed")
                return
            if time.monotonic() <= self.deadline:
                new = self.try_fillet([(pe.edge, pe.radius / 2)], kind)
                if new is _TIMEOUT:
                    self.timed_out(found)
                    return
                if isinstance(new, Solid):
                    self.accept(new)
                    self.report["rounded"] += 1
                    self.report["capped"] += 1   # applied below what was asked
                    return
            self.skip(pe, "protected" if new is _PROTECTED else "failed")
            return
        # split between chains of connected edges where there are several:
        # filleting part of a loop (a rim, say) leaves the rest to end on the
        # new fillet's arcs, and OCCT carries it on round them
        comps = _chains(found)
        if len(comps) > 1:
            k, n = 0, 0
            while k < len(comps) - 1 and n + len(comps[k]) <= len(found) / 2:
                n += len(comps[k])
                k += 1
            k = max(k, 1)
            first, rest = [pe for c in comps[:k] for pe in c], [pe for c in comps[k:] for pe in c]
        else:
            half = len(found) // 2
            first, rest = found[:half], found[half:]
        # the second half's edges get re-found after the first half rebuilds
        # the solid (inside run_batch), from their stored geometry
        self.run_batch(first)
        self.run_batch(rest)


def _chains(found: list[_Pending]) -> list[list[_Pending]]:
    """`found` grouped into chains of edges that share a vertex, in order."""
    verts = TopTools_IndexedMapOfShape()
    parent = list(range(len(found)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    owner: dict[int, int] = {}
    for i, pe in enumerate(found):
        for v in _unique(pe.edge.wrapped, TopAbs_VERTEX):
            k = verts.Add(v)
            if k in owner:
                parent[root(i)] = root(owner[k])
            else:
                owner[k] = i
    groups: dict[int, list[_Pending]] = {}
    for i, pe in enumerate(found):
        groups.setdefault(root(i), []).append(pe)
    return list(groups.values())


def _round_solid(solid, protected_sigs, protected_same, opts, deadline, report):
    rd = _Rounder(solid, deadline, report, opts["attempt_cap"])
    tol = rd.tol * 10
    shape = solid.wrapped

    # protected faces of THIS solid (by identity, else by position + area)
    faces = [Face(TopoDS.Face_s(f)) for f in _unique(shape, TopAbs_FACE)]
    prot = []
    for f in faces:
        hit = any(f.wrapped.IsSame(k) for k in protected_same)
        if not hit:
            c, a = _face_sig(f)
            hit = any(_dist(c, kc) < tol and abs(a - ka) < tol * max(1.0, ka) for kc, ka in protected_sigs)
        if not hit and opts["protect_holes"]:
            hit = _is_hole_wall(f, opts["hole_max_r"])
        if hit:
            prot.append(f)
    report["protected"] += len(prot)
    fmap = _face_map(shape)
    rd.guard = [fmap.FindIndex(f.wrapped) for f in prot]
    rd.guard_area = [f.area for f in prot]
    prot_faces = TopTools_IndexedMapOfShape()
    prot_verts = TopTools_IndexedMapOfShape()
    for f in prot:
        prot_faces.Add(f.wrapped)
        TopExp.MapShapes_s(f.wrapped, TopAbs_VERTEX, prot_verts)

    e2f = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, e2f)
    analyse = BRepOffset_Analyse(shape, 0.01)

    groups: dict[str, list[_Pending]] = {"concave": [], "convex": []}
    for i in range(1, e2f.Extent() + 1):
        e = TopoDS.Edge_s(e2f.FindKey(i))
        if BRep_Tool.Degenerated_s(e):
            continue
        adj = [TopoDS.Face_s(f) for f in e2f.FindFromIndex(i)]
        uniq = []
        for f in adj:
            if not any(f.IsSame(g) for g in uniq):
                uniq.append(f)
        if len(uniq) != 2:      # a seam, or a free edge
            continue
        types = {iv.Type() for iv in analyse.Type(e)}
        if types == {ChFiDS_Convex}:
            kind = "convex"
        elif types == {ChFiDS_Concave}:
            kind = "concave"
        else:                   # tangent, mixed along its length, or unknown
            continue
        edge = Edge(e)
        if edge.length < opts["min_edge"]:
            continue
        # on a protected face, or ending at one (its fillet would round that
        # face's corner and change its boundary)
        if any(prot_faces.Contains(f) for f in uniq):
            continue
        if any(prot_verts.Contains(v) for v in _unique(e, TopAbs_VERTEX)):
            continue
        want = opts[kind]
        if want <= 0:
            continue
        r, capped = want, False
        if opts["max_thickness_frac"] > 0:
            t = _thickness(solid, edge, [Face(f) for f in uniq], rd.size)
            cap = opts["max_thickness_frac"] * t
            if cap < want:
                r, capped = cap, True
        pe = _pending(edge, kind, r, capped, tol)
        if r < 1e-3:
            rd.skip(pe, "thin")
            continue
        groups[kind].append(pe)

    for kind in ("concave", "convex"):
        rd.run_batch(groups[kind])
    return rd.solid


def auto_round(part, convex=1.0, concave=2.0, keep=(), keep_bed=True, protect_holes=True,
               hole_max_r=6.0, min_edge=1.0, max_thickness_frac=0.45, time_budget=20.0,
               report=None):
    """Round `part`'s convex edges to `convex` and concave edges to `concave`,
    leaving protected faces untouched. Returns a new shape of the same kind
    (each solid of a compound is rounded on its own). See the module doc."""
    t0 = time.monotonic()
    rep = {"rounded": 0, "skipped": [], "capped": 0, "merged": 0, "protected": 0, "elapsed": 0.0}
    solids = part.solids() if hasattr(part, "solids") else []
    if not solids:
        raise ValueError("auto_round needs a solid part")

    kept = _keep_faces(part, keep)
    if keep_bed:
        kept += _bed_faces(part)
    sigs = [_face_sig(f) for f in kept]
    same = [f.wrapped for f in kept]
    opts = {"convex": float(convex), "concave": float(concave), "protect_holes": protect_holes,
            "hole_max_r": float(hole_max_r), "min_edge": float(min_edge),
            "max_thickness_frac": float(max_thickness_frac),
            "attempt_cap": max(1.0, 0.15 * float(time_budget))}
    deadline = t0 + float(time_budget)

    out = [_round_solid(s, sigs, same, opts, deadline, rep) for s in solids]
    rep["elapsed"] = round(time.monotonic() - t0, 3)
    if report is not None:
        report(rep)

    if isinstance(part, Solid):
        return out[0]
    if isinstance(part, Part):
        return Part(Compound(out).wrapped)
    return Compound(out)
