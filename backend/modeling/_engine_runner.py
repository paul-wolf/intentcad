"""Standalone runner: execute a build123d script, emit artifacts as JSON.

Runs in a separate process (see engine.py) so a bad script can't take the
server down and can be time-limited. Reads {"code": ...} from stdin, execs it
with build123d available, expects the script to bind `part` (a build123d
Part/Solid/Compound), then tessellates + exports STEP and prints the result.

We do no CAD here — build123d does. We only take the artifacts out.
"""

import json
import sys
import tempfile


def _run(code: str, export: list | None = None) -> dict:
    from build123d import export_step, export_stl

    ns: dict = {"__name__": "__cad__"}
    # Run the script. If an operation fails partway (e.g. a chamfer too big),
    # `part` still holds the model built up to that line — render THAT plus the
    # error as a warning, instead of blanking the whole model.
    warning = None
    try:
        exec(f"from build123d import *\n{code}", ns)  # noqa: S102 - sandboxed subprocess
    except Exception as exc:
        warning = f"{type(exc).__name__}: {exc}"

    part = ns.get("part") or ns.get("result")
    if part is None or not hasattr(part, "faces"):
        return {"ok": False, "error": warning or "script did not define `part`"}

    # expose the params dict (scalar entries) so the UI can offer number fields
    raw = ns.get("P")
    if not isinstance(raw, dict):
        raw = ns.get("params")
    params: dict = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            if isinstance(k, str) and isinstance(v, (int, float, bool)) and not isinstance(v, bool):
                params[k] = v

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

    def cyl_radius(f):
        try:
            surf = BRepAdaptor_Surface(f.wrapped)
            if surf.GetType() == GeomAbs_Cylinder:
                return float(surf.Cylinder().Radius())
        except Exception:
            pass
        return None

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
        faces.append({
            "index": fi, "start": vstart, "count": count,
            "kind": face.geom_type.name.lower(),
            "area": float(face.area),
            "center": [c.X, c.Y, c.Z],
            "normal": [n.X, n.Y, n.Z] if n is not None else [0.0, 0.0, 1.0],
            "radius": cyl_radius(face),
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
    if warning:
        result["warning"] = warning   # an op failed; we rendered up to it
    return result


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        result = _run(payload.get("code", ""), payload.get("export"))
    except Exception as exc:  # any script/engine error → structured, not a crash
        import traceback
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                  "trace": traceback.format_exc()[-1500:]}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
