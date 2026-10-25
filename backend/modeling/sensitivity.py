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

from .engine import EngineError, load_assets, load_sketches, run_script
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


def _resized_cylinder(f: dict, pf: dict) -> float | None:
    """For two cylinders on parallel axes with different radii — a fillet or
    a hole growing — the radius change; else None. Their area changes with the
    radius, so it says nothing about whether they're the same face."""
    a, b = f.get("axis"), pf.get("axis")
    r0, r1 = f.get("radius"), pf.get("radius")
    if f["kind"] != "cylinder" or pf["kind"] != "cylinder" or not (a and b and r0 and r1):
        return None
    if abs(sum(a[i] * b[i] for i in range(3))) < 0.999 or abs(r1 - r0) < 1e-6:
        return None
    return abs(r1 - r0)


def _match(f: dict, candidates: list[dict]) -> tuple[dict, float] | None:
    """The face in `candidates` that `f` became: same orientation and similar
    area (or, for a resized cylinder, a center that moved no more than a few
    times the radius change), nearest center. Returns (face, center distance),
    or None when there is no counterpart or it didn't actually move."""
    match, md = None, None
    for pf in candidates:
        if not _aligned(f["normal"], pf["normal"]):
            continue
        d = _dist(f["center"], pf["center"])
        if abs(f["area"] - pf["area"]) > max(f["area"] * 0.3, 1.0):
            dr = _resized_cylinder(f, pf)
            if dr is None or d > 4 * dr + 1e-3:
                continue
        if md is None or d < md:
            md, match = d, pf
    if match is None or md is None or md < 1e-3:
        return None
    return match, md


def sensitivity(code: str, document_id: str | None = None,
                sketches: dict[str, dict] | None = None, shared: dict | None = None) -> dict[str, dict]:
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
    sketches = load_sketches(code, document_id, sketches)
    base = run_script(code, assets=assets, sketches=sketches, shared=shared)
    params = base.get("params", {})
    base_faces = base.get("faces", [])
    if not params or not base_faces:
        return {}

    def affected(name: str, val: float) -> tuple[str, dict]:
        empty = {"faces": [], "value": val, "shifts": {}, "radial": {},
                 "anchor": None, "dir": None, "kind": "callout"}
        # nudge it up; if that doesn't build cleanly (a fillet radius already
        # near the most that fits), down, then by less — a positive size stays
        # positive
        step = max(abs(val) * 0.15, 1.0)
        pert = None
        for delta in (step, -step, step / 4, -step / 4):
            if val > 0 and val + delta <= 0:
                continue
            try:
                perturbed = set_params(code, {name: val + delta})
                r = run_script(perturbed, assets=assets, sketches=sketches, shared=shared)
            except (EngineError, ParamError, SyntaxError):
                continue
            if r.get("warning") and not base.get("warning"):
                continue    # it failed partway: the faces it shows aren't the param's doing
            pert = r
            break
        if pert is None:
            return name, empty  # no perturbation built — can't attribute
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
