"""Which parameters control which geometry — derived from the model, not annotated.

Perturb each param a little, rebuild, and see which faces moved: those are the
faces that parameter controls. A face is "moved" if its signature (center +
normal + area) no longer matches any face in the perturbed build. By matching a
moved face to its counterpart in the perturbed build we also recover *how far*
and *in which direction* it shifted — enough to draw a dimension for that param.
Runs the perturbations in parallel (each is an isolated subprocess).
"""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor

from .engine import EngineError, run_script
from .paramedit import ParamError, set_params


def _sig(f: dict) -> tuple:
    c, n = f["center"], f["normal"]
    return (round(c[0], 1), round(c[1], 1), round(c[2], 1),
            round(n[0], 2), round(n[1], 2), round(n[2], 2), round(f["area"], 1))


def _dist(a: list[float], b: list[float]) -> float:
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def _unit(v: list[float]) -> list[float] | None:
    n = math.sqrt(sum(c * c for c in v))
    return [c / n for c in v] if n > 1e-9 else None


def _aligned(a: list[float], b: list[float]) -> bool:
    """True if two normals point roughly the same way (within ~25°)."""
    return sum(a[i] * b[i] for i in range(3)) > 0.9


def sensitivity(code: str) -> dict[str, dict]:
    """Return {param_name: dimension-info} for the script's params.

    Each entry is {faces, value, anchor, dir, kind}:
      faces  — inventory indices of the faces the param controls
      value  — the param's current value
      anchor — a world point on the controlled geometry (or None)
      dir    — unit direction the geometry moves as the param grows (or None)
      kind   — "length" when a translation was recovered, else "callout"
    """
    base = run_script(code)
    params = base.get("params", {})
    base_faces = base.get("faces", [])
    if not params or not base_faces:
        return {}

    def affected(name: str, val: float) -> tuple[str, dict]:
        empty = {"faces": [], "value": val, "anchor": None, "dir": None, "kind": "callout"}
        delta = max(abs(val) * 0.15, 1.0)
        try:
            perturbed = set_params(code, {name: val + delta})
            pert = run_script(perturbed)
        except (EngineError, ParamError, SyntaxError):
            return name, empty  # perturbation didn't build — can't attribute
        pert_faces = pert.get("faces", [])
        pert_sigs = {_sig(f) for f in pert_faces}
        moved = [f for f in base_faces if _sig(f) not in pert_sigs]
        idxs = [f["index"] for f in moved]

        # recover a representative translation: the moved face that shifts the
        # farthest, matched to its counterpart (same orientation + area) in the
        # perturbed build. That shift vector is the param's dimension direction.
        best = None  # (shift, center, unit_dir)
        for f in moved:
            match, md = None, None
            for pf in pert_faces:
                if not _aligned(f["normal"], pf["normal"]):
                    continue
                if abs(f["area"] - pf["area"]) > max(f["area"] * 0.3, 1.0):
                    continue
                d = _dist(f["center"], pf["center"])
                if md is None or d < md:
                    md, match = d, pf
            if match is None or md is None or md < 1e-3:
                continue
            u = _unit([match["center"][i] - f["center"][i] for i in range(3)])
            if u and (best is None or md > best[0]):
                best = (md, list(f["center"]), u)

        if best:
            return name, {"faces": idxs, "value": val,
                          "anchor": best[1], "dir": best[2], "kind": "length"}
        anchor = list(moved[0]["center"]) if moved else None
        return name, {"faces": idxs, "value": val,
                      "anchor": anchor, "dir": None, "kind": "callout"}

    with ThreadPoolExecutor(max_workers=min(8, len(params))) as pool:
        results = pool.map(lambda kv: affected(*kv), list(params.items()))
    return {name: info for name, info in results}
