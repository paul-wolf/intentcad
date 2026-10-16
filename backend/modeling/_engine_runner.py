"""Standalone runner: execute a build123d script, emit artifacts as JSON.

Runs in a separate process (see engine.py) so a bad script can't take the
server down and can be time-limited. Reads {"code": ...} from stdin, execs it
with build123d available, expects the script to bind `part` (a build123d
Part/Solid/Compound), then tessellates + exports STEP and prints the result.

We do no CAD here — build123d does. We only take the artifacts out.
"""

import base64
import hashlib
import json
import os
import re
import sys
import tempfile


def _dxf_for_view(part, eye, up, look_at) -> str:
    """A single orthographic DXF outline of the part, seen from `eye` looking at
    `look_at` with `up` pointing up. Returns the hidden-line-removed silhouette
    (build123d's project_to_viewport) as DXF LINE/ARC/CIRCLE entities laid flat on
    the XY plane. The projection is orthographic, so the eye distance is
    irrelevant — only the direction matters."""
    from build123d import ExportDXF, Unit

    visible, _hidden = part.project_to_viewport(eye, up, look_at)
    exporter = ExportDXF(unit=Unit.MM)
    for edge in visible:
        exporter.add_shape(edge)
    with tempfile.NamedTemporaryFile(suffix=".dxf", mode="r", delete=True) as fh:
        exporter.write(fh.name)
        return open(fh.name).read()


def _export_dxf(part) -> str:
    """Flat top-down outline of the part as DXF text, for 2D CAM / CNC routing.

    Looks straight down the Z axis: for a prismatic sheet part this is exactly the
    cut profile plus any through-holes. The model is Y-up (same as STEP/STL),
    which matches DXF, so no Y flip is needed."""
    bb = part.bounding_box()
    cx = (bb.min.X + bb.max.X) / 2
    cy = (bb.min.Y + bb.max.Y) / 2
    cz = (bb.min.Z + bb.max.Z) / 2
    return _dxf_for_view(part, (cx, cy, bb.max.Z + 1000.0), (0, 1, 0), (cx, cy, cz))


def _export_dxf_views(part) -> str:
    """Top, front and side outlines as three DXF files, zipped (base64), like
    stl-parts. Each is an orthographic silhouette on its own plane — top looks
    down Z (XY), front looks along +Y (XZ), side looks along -X (YZ). Three views
    don't guarantee full feature coverage (undercuts, angled faces can hide), but
    for most parts they give the profiles a machinist needs."""
    import base64
    import io
    import zipfile

    bb = part.bounding_box()
    cx = (bb.min.X + bb.max.X) / 2
    cy = (bb.min.Y + bb.max.Y) / 2
    cz = (bb.min.Z + bb.max.Z) / 2
    d = 1000.0  # orthographic: just needs to clear the part
    center = (cx, cy, cz)
    views = {
        "top": _dxf_for_view(part, (cx, cy, bb.max.Z + d), (0, 1, 0), center),
        "front": _dxf_for_view(part, (cx, bb.min.Y - d, cz), (0, 0, 1), center),
        "side": _dxf_for_view(part, (bb.max.X + d, cy, cz), (0, 0, 1), center),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, text in views.items():
            zf.writestr(f"{name}.dxf", text)
    return base64.b64encode(buf.getvalue()).decode()

# Script errors, made actionable. The raw exception is OpenCASCADE/build123d
# wording ("Fillet algorithm failed for Vertex(...)") with no hint of which line
# or what to do about it — this adds the failing script line and, for the
# failures that recur in practice, a plain-language cause and remedy. The same
# text goes to the user AND back to the model on a corrective retry.
#
# Fillets and chamfers get more than a hint: `_instrument()` wraps the build123d
# operations so a failure also reports the LARGEST size that does fit (measured,
# not guessed), and a structured `fix` the caller can apply — see `_last_fix`.
_HINTS = [
    (r"fillet", "The fillet radius is too large for that geometry: the fillet must fit "
                "within the edges/faces it joins, and neighbouring fillets must not "
                "overlap. Reduce the radius, or fillet fewer corners/edges."),
    (r"chamfer", "The chamfer length is too large for that geometry: it must fit within "
                 "the edges/faces it joins. Reduce the length, or chamfer fewer edges."),
    (r"BRep_API: command not done|BRepAlgoAPI|boolean", "A boolean operation produced "
                 "nothing usable — usually the shapes don't actually overlap, or they "
                 "touch only along a face or edge. Check positions and sizes."),
    (r"list index out of range|IndexError|StopIteration", "A selector matched no "
                 "geometry (or fewer items than expected). Check the face/edge selector "
                 "against the current shape."),
]


class SizeError(ValueError):
    """A fillet/chamfer size that doesn't fit, enriched with the size that does.

    `fix` is {"kind", "size", "max", "suggest"}: the size that failed, the largest
    that works (None if it couldn't be measured) and a rounded-down value to use.
    `_run` adds "param"/"value" when `size` matches a script param exactly."""

    def __init__(self, message: str, fix: dict):
        super().__init__(message)
        self.fix = fix


def _suggest(mx: float | None) -> float | None:
    """A usable size just under the measured maximum (5% margin, 2 decimals)."""
    if mx is None:
        return None
    import math
    v = math.floor(mx * 0.95 * 100) / 100
    return v if v >= 0.05 else 0.0


def _largest_ok(attempt, size: float, iters: int = 9) -> float | None:
    """Bisect for the largest size in (0, size) for which `attempt(size)` succeeds.
    `attempt` must be side-effect free (build123d topology methods are: they
    return new shapes). Resolution after 9 halvings is size/512."""
    lo, hi = 0.0, float(size)
    for _ in range(iters):
        mid = (lo + hi) / 2
        try:
            attempt(mid)
            lo = mid
        except Exception:
            hi = mid
    return lo if lo > 0 else None


def _size_error(exc: BaseException, kind: str, what: str, size: float,
                mx: float | None, extra: str = "") -> SizeError:
    noun = "length" if kind == "chamfer" else "radius"
    sug = _suggest(mx)
    if mx is None:
        remedy = (f"The largest {noun} that fits couldn't be measured; try roughly "
                  f"half, or {kind} fewer of them.")
    elif sug == 0.0:
        remedy = (f"No {kind} fits there (largest {noun} that works ≈ {mx:.3g}): "
                  f"remove it from {what}, or change the geometry.")
    else:
        remedy = (f"The largest {noun} that works is about {mx:.3g}: use {noun} "
                  f"{sug:g} (or less), or {kind} fewer of them.")
    msg = (f"{exc}\n{kind.capitalize()} {noun} {size:g} is too large for {what}"
           f"{extra}. {remedy}")
    return SizeError(msg, {"kind": kind, "size": float(size), "max": mx, "suggest": sug})


def _polyline_max_radius(points, close: bool):
    """Largest single radius FilletPolyline can apply at every corner of `points`.

    A fillet of radius r at a corner with interior angle θ consumes r/tan(θ/2)
    of each adjoining segment, so each segment of length L bounds r by
    L / (cot(θa/2) + cot(θb/2)) over the corners it joins. Returns
    (r_max, tightest_corner_point) or (None, None) if nothing constrains it."""
    import math
    from build123d import Vector
    pts = [Vector(p) for p in points]
    n = len(pts)
    if n < 3:
        return None, None
    corners = range(n) if close else range(1, n - 1)
    cot: dict = {}
    for i in corners:
        a = pts[(i - 1) % n] - pts[i]
        b = pts[(i + 1) % n] - pts[i]
        if a.length < 1e-9 or b.length < 1e-9:
            continue
        cosang = max(-1.0, min(1.0, a.dot(b) / (a.length * b.length)))
        theta = math.acos(cosang)
        if theta < 1e-6 or abs(theta - math.pi) < 1e-6:   # spike or straight-through
            continue
        cot[i] = 1.0 / math.tan(theta / 2)
    best, where = None, None
    for i in range(n if close else n - 1):
        j = (i + 1) % n
        seg_len = (pts[j] - pts[i]).length
        c = cot.get(i, 0.0) + cot.get(j, 0.0)
        if c <= 0 or seg_len < 1e-9:
            continue
        r = seg_len / c
        if best is None or r < best:
            best = r
            where = pts[i] if cot.get(i, 0.0) >= cot.get(j, 0.0) else pts[j]
    return best, where


_instrumented = False


def _instrument() -> None:
    """Wrap build123d's fillet/chamfer entry points so a size that doesn't fit
    raises SizeError carrying the size that does. Class-level, once per worker:
    covers `fillet(...)`, `part.fillet(...)`, sketch/wire `fillet_2d` and
    `FilletPolyline`. Only the failure path changes."""
    global _instrumented
    if _instrumented:
        return
    _instrumented = True
    from build123d import Face, FilletPolyline, Wire, Vector
    from build123d.build_common import flatten_sequence
    from build123d.topology.three_d import Mixin3D

    def is_size_failure(exc: BaseException) -> bool:
        return not isinstance(exc, SizeError) and bool(
            re.search(r"fillet|chamfer|BRep_API|not done", str(exc), re.IGNORECASE))

    orig_fillet3d = Mixin3D.fillet

    def fillet3d(self, radius, edge_list):
        edges = list(edge_list)
        try:
            return orig_fillet3d(self, radius, edges)
        except Exception as exc:
            if not is_size_failure(exc):
                raise
            mx = None
            try:
                mx = float(self.max_fillet(edges, tolerance=0.02, max_iterations=14))
            except Exception:
                mx = _largest_ok(lambda r: orig_fillet3d(self, r, edges), radius)
            raise _size_error(exc, "fillet", f"the {len(edges)} selected edge(s)",
                              radius, mx, " (short or converging edges limit it)") from exc

    Mixin3D.fillet = fillet3d

    orig_chamfer3d = Mixin3D.chamfer

    def chamfer3d(self, length, length2, edge_list, face=None):
        edges = list(edge_list)
        try:
            return orig_chamfer3d(self, length, length2, edges, face)
        except Exception as exc:
            if not is_size_failure(exc):
                raise
            mx = _largest_ok(
                lambda d: orig_chamfer3d(self, d, None if length2 is None else d, edges, face),
                length)
            raise _size_error(exc, "chamfer", f"the {len(edges)} selected edge(s)",
                              length, mx) from exc

    Mixin3D.chamfer = chamfer3d

    def wrap_2d(cls):
        orig = cls.fillet_2d

        def fillet_2d(self, radius, vertices):
            verts = list(vertices)
            try:
                return orig(self, radius, verts)
            except Exception as exc:
                if not is_size_failure(exc):
                    raise
                mx = _largest_ok(lambda r: orig(self, r, verts), radius)
                raise _size_error(exc, "fillet", f"the {len(verts)} selected corner(s)",
                                  radius, mx, " (adjoining edges are too short "
                                  "or the corners too close together)") from exc

        cls.fillet_2d = fillet_2d

    wrap_2d(Face)
    wrap_2d(Wire)

    orig_poly_init = FilletPolyline.__init__

    def poly_init(self, *pts, radius, close=False, **kw):
        try:
            return orig_poly_init(self, *pts, radius=radius, close=close, **kw)
        except Exception as exc:
            # corners are filleted one at a time, so an inner SizeError only knows
            # ONE corner's limit — recompute for the whole polyline
            if isinstance(exc, SizeError):
                exc = exc.__cause__ or exc
            elif not is_size_failure(exc):
                raise
            if not isinstance(radius, (int, float)):
                raise
            points = list(flatten_sequence(*pts))
            closed = close
            if len(points) >= 2 and (Vector(points[0]) - Vector(points[-1])).length < 1e-5:
                closed, points = True, points[:-1]
            mx, at = _polyline_max_radius(points, closed)
            extra = ""
            if at is not None:
                extra = f" (tightest corner at ({at.X:g}, {at.Y:g}))"
            raise _size_error(exc, "fillet", "this polyline's corners", radius, mx,
                              extra) from exc

    FilletPolyline.__init__ = poly_init


def _describe_error(exc: BaseException, code: str) -> str:
    """'<line N: source>\nType: message\nhint' — where N is the script line."""
    import traceback
    head = f"{type(exc).__name__}: {exc}"
    lines = code.split("\n")
    where = ""
    if isinstance(exc, SyntaxError) and exc.filename == "<script>" and exc.lineno:
        n = exc.lineno - 1                       # minus the prepended import line
        if 1 <= n <= len(lines):
            where = f"line {n}: {lines[n - 1].strip()}\n"
    else:
        for fr in traceback.extract_tb(exc.__traceback__):
            if fr.filename == "<script>":
                n = fr.lineno - 1
                if 1 <= n <= len(lines):
                    where = f"line {n}: {lines[n - 1].strip()}\n"
    hint = ""
    if not isinstance(exc, SizeError):          # SizeError already says what fits
        for pat, text in _HINTS:
            if re.search(pat, head, re.IGNORECASE):
                hint = "\n" + text
                break
    return f"{where}{head}{hint}"


def _fix_for(exc: BaseException, ns: dict) -> dict | None:
    """The structured remedy for a SizeError: its measured sizes, plus the name of
    the script param holding the failing size when exactly one does — that makes
    the fix a one-click "set <param> = <suggest>" instead of a script edit."""
    fix = getattr(exc, "fix", None)
    if not isinstance(fix, dict):
        return None
    fix = dict(fix)
    raw = ns.get("P")
    if not isinstance(raw, dict):
        raw = ns.get("params")
    if isinstance(raw, dict) and fix.get("suggest") is not None:
        hits = [k for k, v in raw.items()
                if isinstance(k, str) and isinstance(v, (int, float))
                and not isinstance(v, bool) and abs(float(v) - fix["size"]) < 1e-9]
        if len(hits) == 1:
            fix["param"] = hits[0]
            fix["value"] = fix["suggest"]
    return fix


class MissingAssets(RuntimeError):
    """A referenced asset isn't on disk (e.g. the tmp dir was cleaned) — the
    caller should re-send its bytes."""

    def __init__(self, hashes: list[str]):
        super().__init__(", ".join(hashes))
        self.hashes = hashes


def _stage_assets(assets: dict | None, refs: list | None) -> dict[str, str]:
    """Write uploaded files (`assets`: {sha256: base64}) to <tmp>/assets/<sha>.step
    and return ASSETS ({sha256: path}) for every hash the script references.

    The tmp dir is the sandbox's private writable /tmp (bwrap) — the rest of the
    filesystem is read-only. The worker is long-lived, so a file already there
    is not rewritten, and the engine stops re-sending hashes it knows we hold."""
    root = os.path.join(tempfile.gettempdir(), "assets")
    os.makedirs(root, exist_ok=True)
    for sha, b64 in (assets or {}).items():
        if not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise ValueError(f"bad asset hash {sha!r}")
        path = os.path.join(root, f"{sha}.step")
        if os.path.exists(path):
            continue
        data = base64.b64decode(b64)
        if hashlib.sha256(data).hexdigest() != sha:
            raise ValueError(f"asset {sha} does not match its hash")
        tmp = f"{path}.{os.getpid()}.part"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    paths = {sha: os.path.join(root, f"{sha}.step") for sha in (refs or [])}
    missing = sorted(sha for sha, path in paths.items() if not os.path.exists(path))
    if missing:
        raise MissingAssets(missing)
    return paths


def _run(code: str, export: list | None = None,
         assets: dict | None = None, asset_refs: list | None = None) -> dict:
    from build123d import export_step, export_stl

    _instrument()
    try:
        paths = _stage_assets(assets, asset_refs)
    except MissingAssets as exc:
        return {"ok": False, "error": f"uploaded file not loaded: {exc}",
                "missing_assets": exc.hashes}
    # ASSETS["<sha256>"] -> local path of an uploaded file (see engine.run_script)
    ns: dict = {"__name__": "__cad__", "ASSETS": paths}
    # auto_round(part, ...) — rounds every eligible edge; each call's report is
    # collected here and returned as result["auto_round"]
    from modeling.auto_round import auto_round

    rounds: list[dict] = []

    def auto_round_reported(part, *args, **kwargs):
        kwargs.pop("report", None)
        return auto_round(part, *args, report=rounds.append, **kwargs)

    ns["auto_round"] = auto_round_reported
    # spoke / frame / window / truss_windows (modeling/organic.py) — their
    # reports (members, windows, printability warnings) go to result["organic"];
    # min_wall comes from the script's P
    from modeling import organic

    organic_events: list[dict] = []

    def min_wall() -> float:
        p = ns.get("P")
        try:
            return float(p.get("min_wall", 2.0)) if isinstance(p, dict) else 2.0
        except (TypeError, ValueError):
            return 2.0

    ns.update(organic.bind(organic_events.append, min_wall))
    # Run the script. If an operation fails partway (e.g. a chamfer too big),
    # `part` still holds the model built up to that line — render THAT plus the
    # error as a warning, instead of blanking the whole model.
    warning = None
    fix = None
    try:
        exec(compile(f"from build123d import *\n{code}", "<script>", "exec"), ns)  # noqa: S102 - sandboxed subprocess
    except Exception as exc:
        warning = _describe_error(exc, code)
        fix = _fix_for(exc, ns)

    # expose the params dict (scalar entries) so the UI can offer number fields.
    # Collected BEFORE the no-part bail-out: a script that fails hard still has
    # its params (they're defined at the top), and the UI needs them to offer a
    # way out — a script that never builds must not lose its parameter editor.
    raw = ns.get("P")
    if not isinstance(raw, dict):
        raw = ns.get("params")
    params: dict = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            if isinstance(k, str) and isinstance(v, (int, float, bool)) and not isinstance(v, bool):
                params[k] = v

    part = ns.get("part") or ns.get("result")
    if part is None or not hasattr(part, "faces"):
        out = {"ok": False, "error": warning or "script did not define `part`", "params": params}
        if fix:
            out["fix"] = fix
        return out

    # Mesh built FACE BY FACE (each face's triangles are contiguous) so the
    # viewer can pick/highlight a face. `faces` records each face's vertex range
    # + its plane (center, normal), which is what selection & sketch-on-face need.
    positions: list[float] = []
    normals: list[float] = []
    faces: list[dict] = []
    face_list = part.faces()
    # for reporting a hole/boss diameter: a cylindrical face's radius
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cylinder

    def cyl_info(f, c) -> dict:
        """A cylindrical face's radius, axis direction and the point on its axis
        level with the face's center (where a hole/boss sits) — else {}."""
        try:
            surf = BRepAdaptor_Surface(f.wrapped)
            if surf.GetType() == GeomAbs_Cylinder:
                cyl = surf.Cylinder()
                ax = cyl.Axis()
                p, d = ax.Location(), ax.Direction()
                t = (c.X - p.X()) * d.X() + (c.Y - p.Y()) * d.Y() + (c.Z - p.Z()) * d.Z()
                return {"radius": float(cyl.Radius()),
                        "axis": [d.X(), d.Y(), d.Z()],
                        "axis_point": [p.X() + t * d.X(), p.Y() + t * d.Y(), p.Z() + t * d.Z()]}
        except Exception:
            pass
        return {}

    vstart = 0
    for fi, face in enumerate(face_list):
        fverts, ftris = face.tessellate(0.2)
        for a, b, c in ftris:
            va, vb, vc = fverts[a], fverts[b], fverts[c]
            ux, uy, uz = vb.X - va.X, vb.Y - va.Y, vb.Z - va.Z
            wx, wy, wz = vc.X - va.X, vc.Y - va.Y, vc.Z - va.Z
            nx, ny, nz = uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx
            ln = (nx * nx + ny * ny + nz * nz) ** 0.5 or 1.0
            nx, ny, nz = nx / ln, ny / ln, nz / ln
            for v in (va, vb, vc):
                positions += [v.X, v.Y, v.Z]
                normals += [nx, ny, nz]
        count = len(ftris) * 3
        c = face.center()
        try:
            n = face.normal_at(c)
        except Exception:
            n = None
        # bounding-box extents of this face (from its own vertices) — the "size"
        if fverts:
            xs = [v.X for v in fverts]; ys = [v.Y for v in fverts]; zs = [v.Z for v in fverts]
            size = [max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)]
        else:
            size = [0.0, 0.0, 0.0]
        faces.append({
            "index": fi, "start": vstart, "count": count,
            "kind": face.geom_type.name.lower(),
            "area": float(face.area),
            "center": [c.X, c.Y, c.Z],
            "normal": [n.X, n.Y, n.Z] if n is not None else [0.0, 0.0, 1.0],
            "radius": None,
            "size": size,
            **cyl_info(face, c),
        })
        vstart += count

    # edges + adjacency: each edge records the two faces it borders (by inventory
    # index) and a polyline, so "the edge between face A and B" is selectable.
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

    emap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(part.wrapped, TopAbs_EDGE, TopAbs_FACE, emap)

    def face_index(tface) -> int:
        for j, fc in enumerate(face_list):
            if fc.wrapped.IsSame(tface):
                return j
        return -1

    edges: list[dict] = []
    for ei, edge in enumerate(part.edges()):
        fis: list[int] = []
        try:
            if emap.Contains(edge.wrapped):
                for fw in emap.FindFromKey(edge.wrapped):
                    j = face_index(fw)
                    if j >= 0:
                        fis.append(j)
        except Exception:
            pass
        kind = edge.geom_type.name.lower()
        n = 2 if kind == "line" else 33
        poly: list[list[float]] = []
        try:
            for k in range(n):
                p = edge @ (k / (n - 1))
                poly.append([p.X, p.Y, p.Z])
        except Exception:
            poly = []
        edges.append({"index": ei, "kind": kind, "faceIndices": fis, "polyline": poly})

    # export only what's asked for (STEP/STL), so a plain render stays light
    exports: dict = {}
    for fmt in (export or []):
        if fmt == "stl-parts":
            # one STL per solid body, zipped (base64) — for printing an assembly
            import base64
            import io
            import zipfile
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for i, solid in enumerate(part.solids(), 1):
                    with tempfile.NamedTemporaryFile(suffix=".stl", mode="r", delete=True) as fh:
                        export_stl(solid, fh.name, ascii_format=True)
                        zf.writestr(f"part_{i}.stl", open(fh.name).read())
            exports[fmt] = base64.b64encode(buf.getvalue()).decode()
            continue
        if fmt == "dxf":
            # flat top-down outline for 2D CAM (see _export_dxf)
            exports[fmt] = _export_dxf(part)
            continue
        if fmt == "dxf-views":
            # top/front/side outlines, zipped (see _export_dxf_views)
            exports[fmt] = _export_dxf_views(part)
            continue
        suffix = {"step": ".step", "stl": ".stl"}.get(fmt)
        if not suffix:
            continue
        with tempfile.NamedTemporaryFile(suffix=suffix, mode="r", delete=True) as fh:
            if fmt == "step":
                export_step(part, fh.name)
            else:
                export_stl(part, fh.name, ascii_format=True)
            exports[fmt] = open(fh.name).read()

    bb = part.bounding_box()
    result = {
        "ok": True,
        "mesh": {"positions": positions, "normals": normals, "triangle_count": len(positions) // 9},
        "faces": faces,
        "edges": edges,
        "params": params,
        "exports": exports,
        "metrics": {
            "volume": float(part.volume),
            "area": float(part.area),
            "bbox_min": [bb.min.X, bb.min.Y, bb.min.Z],
            "bbox_max": [bb.max.X, bb.max.Y, bb.max.Z],
        },
    }
    if rounds:
        result["auto_round"] = _merge_rounds(rounds)
    if organic_events:
        result["organic"] = organic.merge(organic_events)
    if warning:
        result["warning"] = warning   # an op failed; we rendered up to it
    if fix:
        result["fix"] = fix           # ...and here's the size that would have fit
    return result


def _merge_rounds(rounds: list[dict]) -> dict:
    """One report for a script's auto_round calls (normally just one)."""
    out = {"rounded": 0, "skipped": [], "capped": 0, "merged": 0, "protected": 0, "elapsed": 0.0}
    for r in rounds:
        for k in ("rounded", "capped", "merged", "protected"):
            out[k] += r.get(k, 0)
        out["skipped"] += r.get("skipped", [])
        out["elapsed"] = round(out["elapsed"] + r.get("elapsed", 0.0), 3)
    return out


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        result = _run(payload.get("code", ""), payload.get("export"),
                      payload.get("assets"), payload.get("asset_refs"))
    except Exception as exc:  # any script/engine error → structured, not a crash
        import traceback
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                  "trace": traceback.format_exc()[-1500:]}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
