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

from .engine import EngineError, load_assets, run_script
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


def _match(f: dict, candidates: list[dict]) -> tuple[dict, float] | None:
    """The face in `candidates` that `f` became: same orientation and similar
    area, nearest center. Returns (face, center distance), or None when there
    is no counterpart or it didn't actually move."""
    match, md = None, None
    for pf in candidates:
        if not _aligned(f["normal"], pf["normal"]):
            continue
        if abs(f["area"] - pf["area"]) > max(f["area"] * 0.3, 1.0):
            continue
        d = _dist(f["center"], pf["center"])
        if md is None or d < md:
            md, match = d, pf
    if match is None or md is None or md < 1e-3:
        return None
    return match, md


def sensitivity(code: str, document_id: str | None = None) -> dict[str, dict]:
    """Return {param_name: dimension-info} for the script's params.

    Each entry is {faces, value, shifts, radial, anchor, dir, kind}:
      faces  — inventory indices of the faces the param controls
      value  — the param's current value
      shifts — {face index: [dx, dy, dz]}: how far each moved face's center
               travels per unit of the param (for drag handles). A cylinder's
               center is a point on its wall, so a diameter param shows up as
               a radial shift there.
      radial — {face index: dr}: for cylinders whose radius changes, the
               radius change per unit (so a drag preview can tell a hole
               growing from one sliding along its own normal)
      anchor — a world point on the controlled geometry (or None)
      dir    — unit direction the geometry moves as the param grows (or None)
      kind   — "length" when a translation was recovered, else "callout"
    """
    # load uploaded files once, here: the perturbed builds run on pool threads
    # (no DB there), and only change P, so they import the same files
    assets = load_assets(code, document_id)
    base = run_script(code, assets=assets)
    params = base.get("params", {})
    base_faces = base.get("faces", [])
    if not params or not base_faces:
        return {}

    def affected(name: str, val: float) -> tuple[str, dict]:
        empty = {"faces": [], "value": val, "shifts": {}, "radial": {},
                 "anchor": None, "dir": None, "kind": "callout"}
        delta = max(abs(val) * 0.15, 1.0)
        try:
            perturbed = set_params(code, {name: val + delta})
            pert = run_script(perturbed, assets=assets)
        except (EngineError, ParamError, SyntaxError):
            return name, empty  # perturbation didn't build — can't attribute
        pert_faces = pert.get("faces", [])
        pert_sigs = {_sig(f) for f in pert_faces}
        moved = [f for f in base_faces if _sig(f) not in pert_sigs]
        idxs = [f["index"] for f in moved]

        # match every moved face to its counterpart in the perturbed build: its
        # center displacement per unit of the param is how a drag on that face
        # maps to the param (`shifts`). The face that shifts the farthest gives
        # the param's representative dimension direction (`dir`).
        shifts: dict[int, list[float]] = {}
        radial: dict[int, float] = {}
        best = None  # (shift, center, unit_dir)
        for f in moved:
            m = _match(f, pert_faces)
            if m is None:
                continue
            pf, md = m
            disp = [pf["center"][i] - f["center"][i] for i in range(3)]
            shifts[f["index"]] = [d / delta for d in disp]
            r0, r1 = f.get("radius"), pf.get("radius")
            if r0 and r1 and abs(r1 - r0) > 1e-6:
                radial[f["index"]] = (r1 - r0) / delta
            u = _unit(disp)
            if u and (best is None or md > best[0]):
                best = (md, list(f["center"]), u)

        if best:
            return name, {"faces": idxs, "value": val, "shifts": shifts,
                          "radial": radial, "anchor": best[1], "dir": best[2], "kind": "length"}
        anchor = list(moved[0]["center"]) if moved else None
        return name, {"faces": idxs, "value": val, "shifts": shifts,
                      "radial": radial, "anchor": anchor, "dir": None, "kind": "callout"}

    with ThreadPoolExecutor(max_workers=min(8, len(params))) as pool:
        results = pool.map(lambda kv: affected(*kv), list(params.items()))
    return {name: info for name, info in results}
