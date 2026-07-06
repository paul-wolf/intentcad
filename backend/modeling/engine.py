"""Run an AI/user-authored build123d script and return its artifacts.

This is the whole modeler now: the model IS a build123d script; we execute it in
an isolated subprocess (timeout, crash-contained) and take the mesh + STEP out.
No op-list, no selectors, no hand-rolled CAD — the engine does all of it.

Sandbox: the runner is executed inside bubblewrap when available (no network,
read-only filesystem, private /tmp, own namespaces, scrubbed env) — see
_sandbox(). On a host without bwrap (e.g. local macOS dev) it falls back to a
plain subprocess with just the timeout, identical to before. A hosted deploy
should additionally run the engine as a separate secret-less worker (gVisor /
Fargate). Force the plain path with MODELING_SANDBOX=off.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Run as a module from the backend root so modeling/ is NOT sys.path[0]
# (otherwise stdlib `import selectors` resolves to modeling/selectors.py).
_BACKEND = Path(__file__).resolve().parent.parent


class EngineError(RuntimeError):
    """The script failed to build (surfaced to the client with the message)."""


def _min_env() -> dict[str, str]:
    """A scrubbed environment for the sandboxed child: it runs arbitrary code,
    so it must NOT see the app's secrets (ANTHROPIC_KEY, DB creds, …). Keep only
    what build123d needs; give it a writable TMPDIR on the tmpfs."""
    keep = ("PATH", "LANG", "LC_ALL", "LC_CTYPE")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env["HOME"] = "/tmp"
    env["TMPDIR"] = "/tmp"
    return env


def _sandbox() -> tuple[list[str], dict[str, str] | None]:
    """Return (argv_prefix, env) to run the runner inside an OS sandbox.

    Uses bubblewrap when present: no network, read-only filesystem, a private
    writable /tmp, non-root, its own namespaces, and a scrubbed env. When no
    sandbox binary is available (e.g. local macOS dev) or MODELING_SANDBOX is
    off, returns ([], None) — the plain subprocess with the inherited env,
    identical to the previous behaviour. Set MODELING_SANDBOX=off to force this.
    """
    mode = os.environ.get("MODELING_SANDBOX", "auto").lower()
    if mode in ("0", "off", "none", "false"):
        return [], None
    bwrap = shutil.which("bwrap") if mode in ("auto", "bwrap") else None
    if bwrap:
        prefix = [
            bwrap,
            "--ro-bind", "/", "/",              # whole fs read-only (find python + OCP libs)
            "--dev", "/dev", "--proc", "/proc",
            "--tmpfs", "/tmp",                  # private writable tmp for STEP/STL export
            "--setenv", "TMPDIR", "/tmp",
            "--unshare-all",                    # no network + own pid/ipc/uts/user namespaces
            "--die-with-parent", "--new-session",
            "--chdir", str(_BACKEND),           # so stdlib `import selectors` wins
            "--",
        ]
        return prefix, _min_env()
    return [], None


def run_script(code: str, *, export: list[str] | None = None, timeout: float = 30.0) -> dict:
    """Execute `code` (a build123d script that binds `part`) and return
    {mesh, faces, edges, params, metrics, exports}. `export` requests STEP/STL
    text. Raises EngineError with the script's error message on failure."""
    prefix, env = _sandbox()
    try:
        proc = subprocess.run(
            [*prefix, sys.executable, "-m", "modeling._engine_runner"],
            input=json.dumps({"code": code, "export": export or []}),
            capture_output=True, text=True, timeout=timeout, cwd=_BACKEND, env=env,
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
