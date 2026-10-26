"""Generated sketches, server side: a sketch document whose one sketch is made
by code (data.source = "generated", data.code) instead of drawn.

The code runs in the build worker (engine.run_sketch_code, see
modeling/sketch_code.py for its API). A run writes the sketch as a drawn
sketch's save would: its `profile` (what parts read through SK["alias"]),
display `entities` (marked generated), `groups` (one per output), and
`solvedWith` (the project parameters the code read, at the values it read).
Plus the run record:

    sketch.generated = {outputs: [{name, description, kind, count, size}],
                        checks: [{name, ok, message, output?}],
                        annotations: {labels: [{text, at}], dims: [{p1, p2, text}]},
                        reads: {name: value}, error: None | {message, line},
                        ran_at: ms}

A run that fails keeps the last good profile and entities and sets
`generated.error`, and (when the project's parameters changed since the last
good run) `solveError` as a drawn sketch's failed solve does, so parts keep
building from the last good result with those parameters held (see
shared_defs.sketch_state).

Only the server writes those keys (update_document keeps them as stored), and
it re-runs a generated sketch when its code is saved, when the project's
parameters are saved, and when a part reads one that hasn't been run for the
current parameters. Part builds never run the code: they read the profile.
"""
from __future__ import annotations

import time

from documents.models import Document

from . import shared_defs
from .engine import EngineError, run_sketch_code

SERVER_KEYS = ("source", "code", "codeHistory", "sketches", "activeSketchId")
HISTORY = 60

STARTER = '''\
# Code that draws this sketch. Parts use what it outputs.
# PP["name"] reads a project parameter.
# output("name", shapes) gives parts SK[...].group("name").
# check(...), label(...), dim(...) add checks and notes to the drawing.

output("outline", Rectangle(80, 60))
'''


is_generated = shared_defs.is_generated


def _now_ms() -> int:
    return int(time.time() * 1000)


def the_sketch(doc) -> dict | None:
    """A generated document's one sketch."""
    for s in shared_defs._data(doc).get("sketches") or []:
        if isinstance(s, dict):
            return s
    return None


def _plane(sketch: dict | None):
    prof = (sketch or {}).get("profile")
    return prof.get("plane") if isinstance(prof, dict) and isinstance(prof.get("plane"), dict) else None


def pp_used(doc, sketch: dict, params: dict) -> list[str]:
    """The project parameters a generated sketch reads: those its last run
    read, those its code names (PP["…"]), and any it was run with that have
    since been deleted."""
    return shared_defs.sketch_pp(doc, sketch, params)


def run(doc, overrides: dict | None = None, code: str | None = None) -> dict:
    """A trial run: the document's code (or `code`) with the project's
    parameters, `overrides` on top. Saves nothing. The worker's result
    (sketch_code.result, or {"ok": False, "error", "line", "reads"})."""
    data = shared_defs._data(doc)
    params = shared_defs.params_of(doc.project) if doc.project_id else {}
    params = {**params, **(overrides or {})}
    src = data.get("code") if code is None else code
    try:
        return run_sketch_code(src if isinstance(src, str) else "", params, plane=_plane(the_sketch(doc)))
    except EngineError as exc:
        return {"ok": False, "error": str(exc), "line": None, "reads": {}}


def apply(doc, result: dict, params: dict | None = None) -> dict:
    """Write a run's result into the document's sketch (not saved); returns the sketch."""
    data = dict(shared_defs._data(doc))
    sketches = [dict(s) if isinstance(s, dict) else s for s in data.get("sketches") or []]
    if not sketches or not isinstance(sketches[0], dict):
        sketches = [new_sketch()]
    s = sketches[0]
    gen = dict(s.get("generated") or {}) if isinstance(s.get("generated"), dict) else {}
    if result.get("ok"):
        s["profile"] = result["profile"]
        s["entities"] = result["entities"]
        s["constraints"] = []
        s["groups"] = [{"name": n, "ids": ids} for n, ids in result["profile"]["groups"].items()]
        s["solvedWith"] = dict(result.get("reads") or {})
        s.pop("solveError", None)
        gen = {"outputs": result["outputs"], "checks": result["checks"],
               "annotations": result["annotations"], "reads": dict(result.get("reads") or {}),
               "error": None, "ran_at": _now_ms()}
    else:
        params = params if params is not None else (shared_defs.params_of(doc.project) if doc.project_id else {})
        gen = {"outputs": gen.get("outputs") or [], "checks": gen.get("checks") or [],
               "annotations": gen.get("annotations") or {"labels": [], "dims": []},
               "reads": gen.get("reads") or {}, "ran_at": _now_ms(),
               "error": {"message": result.get("error") or "it failed", "line": result.get("line")}}
        s["generated"] = gen
        used = pp_used(doc_with(doc, data, sketches), s, params) + list(result.get("reads") or {})
        s["solveError"] = {"with": {n: params.get(n) for n in sorted(set(used))},
                           "message": gen["error"]["message"], "dimensionIds": []}
    s["generated"] = gen
    sketches[0] = s
    data["sketches"] = sketches
    data["activeSketchId"] = s["id"]
    doc.data = data
    return s


def doc_with(doc, data: dict, sketches: list):
    """`doc` seen with other data (for helpers that read doc.data)."""
    view = Document(id=doc.id, name=doc.name, project_id=doc.project_id, created_by_id=doc.created_by_id)
    view.data = {**data, "sketches": sketches}
    return view


def new_sketch(name: str = "Sketch 1", sketch_id: str | None = None) -> dict:
    import uuid

    return {"id": sketch_id or str(uuid.uuid4()), "name": name, "visible": True,
            "entities": [], "constraints": []}


def new_data(name: str, code: str = STARTER) -> dict:
    """A new generated document's data (not yet run)."""
    import uuid

    s = new_sketch()
    return {"id": str(uuid.uuid4()), "name": name, "type": "sketch", "source": "generated",
            "code": code, "codeHistory": [], "activeSketchId": s["id"], "sketches": [s]}


AXES = {"axis-h", "axis-v", "axis-fh", "axis-fv"}    # the editor's built-in reference axes


def is_empty_drawn(doc) -> bool:
    """A drawn sketch document with nothing drawn (it can become generated in place)."""
    data = shared_defs._data(doc)
    if data.get("source") == "generated" or (data.get("modelCode") or "").strip():
        return False
    return not any(isinstance(e, dict) and e.get("id") not in AXES
                   for s in data.get("sketches") or [] if isinstance(s, dict) for e in s.get("entities") or [])


def convert_in_place(doc, code: str = STARTER) -> None:
    """Make an empty drawn sketch document generated (saved)."""
    data = dict(shared_defs._data(doc))
    first = the_sketch(doc)
    s = new_sketch(first.get("name") or "Sketch 1", first.get("id")) if first else new_sketch()
    data.update({"type": "sketch", "source": "generated", "code": code, "codeHistory": [],
                 "activeSketchId": s["id"], "sketches": [s]})
    doc.data = data
    apply(doc, run(doc))
    doc.save()


def used_outputs(doc) -> dict[str, list[str]]:
    """{output name: [names of the parts that ask for it]} by .group("…") or .named("…")."""
    out: dict[str, list[str]] = {}
    for p in shared_defs.used_by(doc):
        for u in p["uses"]:
            for n in set(u["groups"]) | set(u["names"]):
                if p["name"] not in out.setdefault(n, []):
                    out[n].append(p["name"])
    return out


def broken_outputs(doc, result: dict) -> list[dict]:
    """The outputs parts use that `result` no longer makes: [{name, parts}]."""
    if not result.get("ok"):
        return []
    made = {o["name"] for o in result.get("outputs") or []}
    s = the_sketch(doc) or {}
    had = {o["name"] for o in ((s.get("generated") or {}).get("outputs") or [])}
    return [{"name": n, "parts": parts} for n, parts in sorted(used_outputs(doc).items())
            if n in had and n not in made]


def save_code(doc, code: str, label: str = "", user=None, result: dict | None = None) -> dict:
    """Save new code (the old code goes into codeHistory, a revert point), run
    it and keep the result (saved). Returns the run's result."""
    data = dict(shared_defs._data(doc))
    old = data.get("code") if isinstance(data.get("code"), str) else ""
    if old != code:
        hist = data.get("codeHistory") if isinstance(data.get("codeHistory"), list) else []
        if old.strip() and not (hist and isinstance(hist[-1], dict) and hist[-1].get("code") == old):
            hist = [*hist, {"code": old, "at": _now_ms(), "label": label or "before a change"}][-HISTORY:]
        data["codeHistory"] = hist
        data["code"] = code
    doc.data = data
    result = result if result is not None and result.get("ok") is not None else run(doc)
    apply(doc, result)
    doc.save()
    return result


def rerun(doc, params: dict | None = None) -> dict:
    """Run a generated document's code with the project's parameters now and
    save the result (no code change, so no revert point)."""
    result = run(doc)
    apply(doc, result, params)
    doc.save()
    return result


def rerun_for_project(project) -> list[str]:
    """Re-run the project's generated sketches whose parameters changed since
    they last ran; the names of those that ran."""
    params = shared_defs.params_of(project)
    ran = []
    for d in Document.objects.select_related("project").filter(project=project):
        if not is_generated(d):
            continue
        s = the_sketch(d)
        if s is None or shared_defs.sketch_state(d, s, params) is None:
            continue
        rerun(d, params)
        ran.append(d.name)
    return ran


def rerun_if_pending(doc, params: dict) -> bool:
    """Run a generated sketch not yet run for the project's parameters now
    (a part needs it); True if it ran."""
    s = the_sketch(doc)
    if not is_generated(doc) or s is None:
        return False
    state = shared_defs.sketch_state(doc, s, params)
    if not state or state["state"] != "pending":
        return False
    rerun(doc, params)
    return True
