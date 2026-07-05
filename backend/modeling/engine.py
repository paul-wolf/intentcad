"""Run an AI/user-authored build123d script and return its artifacts.

This is the whole modeler now: the model IS a build123d script; we execute it in
an isolated subprocess (timeout, crash-contained) and take the mesh + STEP out.
No op-list, no selectors, no hand-rolled CAD — the engine does all of it.

Sandbox note: a subprocess with a timeout contains crashes and runaway loops.
It does NOT yet restrict filesystem/network — fine for local single-user use;
a hosted service must run this in a real sandbox (container/seccomp). Tracked.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# Run as a module from the backend root so modeling/ is NOT sys.path[0]
# (otherwise stdlib `import selectors` resolves to modeling/selectors.py).
_BACKEND = Path(__file__).resolve().parent.parent


class EngineError(RuntimeError):
    """The script failed to build (surfaced to the client with the message)."""


def run_script(code: str, *, timeout: float = 30.0) -> dict:
    """Execute `code` (a build123d script that binds `part`) and return
    {mesh, step, metrics}. Raises EngineError with the script's error message on
    failure."""
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "modeling._engine_runner"],
            input=json.dumps({"code": code}),
            capture_output=True, text=True, timeout=timeout, cwd=_BACKEND,
        )
    except subprocess.TimeoutExpired as exc:
        raise EngineError(f"build timed out after {timeout:.0f}s") from exc

    if proc.returncode != 0 and not proc.stdout:
        raise EngineError((proc.stderr or "engine crashed").strip()[-500:])

    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise EngineError((proc.stderr or proc.stdout or "no output").strip()[-500:]) from exc

    if not result.get("ok"):
        raise EngineError(result.get("error", "build failed"))
    return result
