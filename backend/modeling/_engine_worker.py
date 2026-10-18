"""Long-lived engine worker.

Import build123d/OpenCASCADE ONCE, then execute build123d scripts fed as JSON
lines on stdin, writing one JSON result line per request to stdout. Keeping OCP
warm avoids the ~5-9s import cost that a fresh subprocess pays on every build.

Protocol: prints a single `READY` line once the heavy import is done, then for
each `{"code": ..., "export": [...], "assets": {sha: base64}, "asset_refs": [sha]}`
line read from stdin writes one JSON result line (the same dict shape
`_engine_runner._run` returns). Uploaded files are staged on disk once and
stay there for the worker's life (see _engine_runner._stage_assets). Each
request runs in a fresh namespace, so no state leaks between builds. Run as
`python -m modeling._engine_worker` with cwd=backend.
"""

import json
import os
import sys


def main() -> None:
    # The protocol owns stdout. Anything else that writes there — a script's
    # print(), or OpenCASCADE's C++ (the STEP reader reports to fd 1) — would
    # inject a line and shift every later response by one. So keep a private
    # copy of stdout for the protocol and point fd 1 at stderr (which the
    # engine drains and shows on a crash).
    proto = os.fdopen(os.dup(1), "w", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    from modeling import _engine_runner  # its _run is the core build routine
    import build123d  # noqa: F401  — warm the heavy OCP import once, up front

    proto.write("READY\n")
    proto.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            result = _engine_runner._run(req.get("code", ""), req.get("export"),
                                         req.get("assets"), req.get("asset_refs"),
                                         req.get("sketches"))
        except Exception as exc:  # never let one bad request take down the worker
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        proto.write(json.dumps(result) + "\n")
        proto.flush()


if __name__ == "__main__":
    main()
