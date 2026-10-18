"""Run an AI/user-authored build123d script and return its artifacts.

This is the whole modeler now: the model IS a build123d script. It runs in a
long-lived WARM worker (`_engine_worker`) that imports build123d/OpenCASCADE
once — a fresh subprocess per build otherwise pays ~5-9s of import every time.
Requests are serialized over the worker; a build that overruns the timeout, or
a hard crash, kills the worker and the next build starts a fresh one.

Sandbox: the worker is launched inside bubblewrap when available (no network,
read-only filesystem, private /tmp, own namespaces, scrubbed env) — see
_sandbox(). Without bwrap (e.g. local macOS dev) it's a plain subprocess. A
hosted deploy should additionally run the engine as a separate secret-less
worker (gVisor / Fargate). Force the plain path with MODELING_SANDBOX=off.
"""

from __future__ import annotations

import atexit
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

# Run as a module from the backend root so modeling/ is NOT sys.path[0]
# (otherwise stdlib `import selectors` resolves to modeling/selectors.py).
_BACKEND = Path(__file__).resolve().parent.parent


class EngineError(RuntimeError):
    """The script failed to build (surfaced to the client with the message).

    `fix`, when present, is the runner's structured remedy for a fillet/chamfer
    that doesn't fit: {kind, size, max, suggest} plus {param, value} when the
    failing size is a script param — so callers can apply it without an edit.
    `params` are the script's editable params as far as it got — so the UI can
    keep offering them even though nothing built."""

    def __init__(self, message: str, fix: dict | None = None, params: dict | None = None):
        super().__init__(message)
        self.fix = fix
        self.params = params or {}


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


class _Worker:
    """A warm engine subprocess plus a background drain of its stderr (so a
    chatty OCP can't deadlock on a full pipe, and we can report crash output)."""

    def __init__(self, proc: subprocess.Popen):
        self.proc = proc
        self.assets: set[str] = set()      # asset hashes this worker has on disk
        self._err: list[str] = []
        t = threading.Thread(target=self._drain, daemon=True)
        t.start()

    def _drain(self) -> None:
        for line in self.proc.stderr:          # ends at EOF (process exit)
            self._err.append(line)
            if len(self._err) > 200:
                del self._err[0]

    def stderr_tail(self) -> str:
        return "".join(self._err).strip()[-500:]


_worker_lock = threading.Lock()
_worker: _Worker | None = None


def _start_worker() -> _Worker:
    prefix, env = _sandbox()
    proc = subprocess.Popen(
        [*prefix, sys.executable, "-u", "-m", "modeling._engine_worker"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, cwd=_BACKEND, env=env,
    )
    w = _Worker(proc)
    ready = proc.stdout.readline()             # blocks until build123d is imported
    if ready.strip() != "READY":
        proc.kill()
        raise EngineError(w.stderr_tail() or "engine worker failed to start")
    return w


def _shutdown_worker() -> None:
    global _worker
    if _worker is not None:
        try:
            _worker.proc.kill()
        except Exception:  # pragma: no cover
            pass
        _worker = None


atexit.register(_shutdown_worker)


def _read_line(proc: subprocess.Popen, timeout: float) -> str | None:
    """Read one line from proc.stdout; None on timeout, "" on EOF (crash)."""
    out: dict[str, str] = {}

    def reader() -> None:
        try:
            out["line"] = proc.stdout.readline()
        except Exception:  # pragma: no cover
            out["line"] = ""

    th = threading.Thread(target=reader, daemon=True)
    th.start()
    th.join(timeout)
    if th.is_alive():
        return None
    return out.get("line", "")


# An uploaded file is referenced by content hash: ASSETS["<sha256>"] is its
# local path inside the worker. The hash in the script text is what keeps a
# build a pure function of the script (the frontend's build cache keys on it).
ASSET_REF = re.compile(r"""ASSETS\[\s*["']([0-9a-f]{64})["']\s*\]""")


def asset_refs(code: str) -> set[str]:
    """The asset hashes `code` references."""
    return set(ASSET_REF.findall(code))


def load_assets(code: str, document_id: str | None) -> dict[str, bytes]:
    """The bytes of every asset `code` references, from that document only.
    Raises EngineError naming a hash the document doesn't have."""
    refs = asset_refs(code)
    if not refs:
        return {}
    if not document_id:
        raise EngineError("this script uses an uploaded file (ASSETS[...]) but no document was given")
    from documents.models import DocumentAsset  # the engine is otherwise Django-free

    rows = dict(DocumentAsset.objects.filter(document_id=document_id, sha256__in=refs)
                .values_list("sha256", "data"))
    missing = sorted(refs - rows.keys())
    if missing:
        raise EngineError(f"uploaded file ASSETS[\"{missing[0]}\"] is not part of this document")
    return {sha: bytes(data) for sha, data in rows.items()}


# A face sketch is referenced by name: sketch("Sketch on top face"). Its closed
# loops (the profile the frontend stores with the sketch) travel with the build.
SKETCH_REF = re.compile(r"""\bsketch\(\s*(["'])(.+?)\1\s*\)""")


def sketch_refs(code: str) -> set[str]:
    """The sketch names `code` references."""
    return {m.group(2) for m in SKETCH_REF.finditer(code)}


def load_sketches(code: str, document_id: str | None,
                  given: dict[str, dict] | None = None) -> dict[str, dict]:
    """{name: profile} for every sketch `code` references: from `given` (the
    editor sends what it has on screen, saved or not), else from the document.
    A name found nowhere is left to sketch() to report."""
    refs = sketch_refs(code)
    out = {n: given[n] for n in refs if given and n in given}
    if refs - out.keys() and document_id:
        from documents.models import Document  # the engine is otherwise Django-free

        data = Document.objects.filter(id=document_id).values_list("data", flat=True).first() or {}
        for s in data.get("sketches") or []:
            if isinstance(s, dict) and s.get("name") in refs and s["name"] not in out and s.get("profile"):
                out[s["name"]] = s["profile"]
    return out


def run_script(code: str, *, export: list[str] | None = None, timeout: float = 60.0,
               document_id: str | None = None, assets: dict[str, bytes] | None = None,
               sketches: dict[str, dict] | None = None) -> dict:
    """Execute `code` (a build123d script that binds `part`) and return
    {mesh, faces, edges, params, metrics, exports}. `export` requests STEP/STL
    text. Raises EngineError with the script's error message on failure.

    Uploaded files the script references (ASSETS["<sha256>"]) are loaded from
    `document_id`'s assets, or taken from `assets` ({sha256: bytes}) when the
    caller already has them (sensitivity rebuilds one script many times).
    Face sketches it references (sketch("name")) likewise: `sketches`
    ({name: profile}) first, the document's stored profiles for the rest.

    Runs on the warm worker; serialized by a lock. On timeout or crash the worker
    is discarded so the next call gets a fresh one."""
    refs = asset_refs(code)
    if assets is None:
        assets = load_assets(code, document_id)
    missing = sorted(refs - assets.keys())
    if missing:
        raise EngineError(f"uploaded file ASSETS[\"{missing[0]}\"] is not part of this document")
    profiles = load_sketches(code, document_id, sketches) if sketch_refs(code) else {}

    for attempt in range(2):
        with _worker_lock:
            global _worker
            if _worker is None or _worker.proc.poll() is not None:
                _worker = _start_worker()
            w = _worker
            # send only the files this worker doesn't hold yet (a new worker holds none)
            payload = json.dumps({
                "code": code, "export": export or [],
                "assets": {sha: base64.b64encode(assets[sha]).decode()
                           for sha in sorted(refs) if sha not in w.assets},
                "asset_refs": sorted(refs),
                "sketches": profiles,
            })
            try:
                w.proc.stdin.write(payload + "\n")
                w.proc.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                _worker = None
                raise EngineError("engine worker crashed") from exc
            line = _read_line(w.proc, timeout)
            if line is None:                        # overran the timeout — kill it
                _worker = None
                w.proc.kill()
                raise EngineError(f"build timed out after {timeout:.0f}s")
            if line == "":                          # EOF — the worker died mid-build
                _worker = None
                raise EngineError(w.stderr_tail() or "engine worker crashed")

        try:
            result = json.loads(line)
        except json.JSONDecodeError as exc:
            raise EngineError("engine returned malformed output") from exc
        if result.get("missing_assets") and attempt == 0:
            # its copy is gone (tmp cleaned): forget it and send the bytes again
            w.assets.difference_update(result["missing_assets"])
            continue
        w.assets.update(refs)                       # staged before the script ran
        break
    if not result.get("ok"):
        raise EngineError(result.get("error", "build failed"), fix=result.get("fix"),
                          params=result.get("params"))
    return result
