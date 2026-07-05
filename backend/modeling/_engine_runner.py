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

    # Mesh built FACE BY FACE (each face's triangles are contiguous) so the
    # viewer can pick/highlight a face. `faces` records each face's vertex range
    # + its plane (center, normal), which is what selection & sketch-on-face need.
    positions: list[float] = []
    normals: list[float] = []
    faces: list[dict] = []
    vstart = 0
    for fi, face in enumerate(part.faces()):
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

    with tempfile.NamedTemporaryFile(suffix=".step", mode="r", delete=True) as fh:
        export_step(part, fh.name)
        step = open(fh.name).read()

    bb = part.bounding_box()
    return {
        "ok": True,
        "mesh": {"positions": positions, "normals": normals, "triangle_count": len(positions) // 9},
        "faces": faces,
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
