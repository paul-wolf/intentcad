"""Which parameters control which faces — derived from the model, not annotated.

Perturb each param a little, rebuild, and see which faces moved: those are the
faces that parameter controls. A face is "moved" if its signature (center +
normal + area) no longer matches any face in the perturbed build. Runs the
perturbations in parallel (each is an isolated subprocess).
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from .engine import EngineError, run_script
from .paramedit import ParamError, set_params


def _sig(f: dict) -> tuple:
    c, n = f["center"], f["normal"]
    return (round(c[0], 1), round(c[1], 1), round(c[2], 1),
            round(n[0], 2), round(n[1], 2), round(n[2], 2), round(f["area"], 1))


def sensitivity(code: str) -> dict[str, list[int]]:
    """Return {param_name: [face indices it controls]} for the script's params."""
    base = run_script(code)
    params = base.get("params", {})
    base_faces = base.get("faces", [])
    if not params or not base_faces:
        return {}

    def affected(name: str, val: float) -> tuple[str, list[int]]:
        delta = max(abs(val) * 0.15, 1.0)
        try:
            perturbed = set_params(code, {name: val + delta})
            pert = run_script(perturbed)
        except (EngineError, ParamError, SyntaxError):
            return name, []  # perturbation didn't build — can't attribute
        pert_sigs = {_sig(f) for f in pert.get("faces", [])}
        return name, [f["index"] for f in base_faces if _sig(f) not in pert_sigs]

    with ThreadPoolExecutor(max_workers=min(8, len(params))) as pool:
        results = pool.map(lambda kv: affected(*kv), list(params.items()))
    return {name: faces for name, faces in results}
