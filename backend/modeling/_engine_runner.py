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


def _run(code: str) -> dict:
    import build123d as b3d
    from build123d import export_step

    ns: dict = {"__name__": "__cad__"}
    exec(f"from build123d import *\n{code}", ns)  # noqa: S102 - sandboxed subprocess

    part = ns.get("part") or ns.get("result")
    if part is None:
        return {"ok": False, "error": "script did not define `part`"}

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

    with tempfile.NamedTemporaryFile(suffix=".step", mode="r", delete=True) as fh:
        export_step(part, fh.name)
        step = open(fh.name).read()

    bb = part.bounding_box()
    return {
        "ok": True,
        "mesh": {"positions": positions, "normals": normals, "triangle_count": len(positions) // 9},
        "faces": faces,
        "edges": edges,
        "params": params,
        "step": step,
        "metrics": {
            "volume": float(part.volume),
            "area": float(part.area),
            "bbox_min": [bb.min.X, bb.min.Y, bb.min.Z],
            "bbox_max": [bb.max.X, bb.max.Y, bb.max.Z],
        },
    }


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        result = _run(payload.get("code", ""))
    except Exception as exc:  # any script/engine error → structured, not a crash
        import traceback
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                  "trace": traceback.format_exc()[-1500:]}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
