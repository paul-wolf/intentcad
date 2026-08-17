"""Long-lived engine worker.

Import build123d/OpenCASCADE ONCE, then execute build123d scripts fed as JSON
lines on stdin, writing one JSON result line per request to stdout. Keeping OCP
warm avoids the ~5-9s import cost that a fresh subprocess pays on every build.

Protocol: prints a single `READY` line once the heavy import is done, then for
each `{"code": ..., "export": [...]}` line read from stdin writes one JSON result
line (the same dict shape `_engine_runner._run` returns). Each request runs in a
fresh namespace, so no state leaks between builds. Run as
`python -m modeling._engine_worker` with cwd=backend.
"""

import json
import sys


def main() -> None:
    from modeling import _engine_runner  # its _run is the core build routine
    import build123d  # noqa: F401  — warm the heavy OCP import once, up front

    sys.stdout.write("READY\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            result = _engine_runner._run(req.get("code", ""), req.get("export"))
        except Exception as exc:  # never let one bad request take down the worker
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
