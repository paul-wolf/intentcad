"""A project's parameters across its documents: which sketches and parts use
each one (the project page's Used by), names a sketch also has as its own
parameter, and renaming one everywhere it is used.

A part uses a parameter through its script (PP["name"]) or through a project
sketch it reads (SK["alias"]) whose dimensions use it by name.
"""
from __future__ import annotations

import re
import time

from documents.models import Document, document_kind

from . import shared_defs
from .engine import pp_names, sk_aliases


def _docs(project):
    return list(Document.objects.select_related("project").filter(project=project).order_by("name"))


def _sketches(doc) -> list[dict]:
    return [s for s in shared_defs._data(doc).get("sketches") or [] if isinstance(s, dict)]


def own_clashes(project, names) -> list[tuple[str, str]]:
    """(name, sketch document name) for each of `names` that a sketch
    document of the project has as its own parameter."""
    names = set(names)
    out = []
    for d in _docs(project):
        if document_kind(shared_defs._data(d)) == "part":
            continue
        for n in sorted(names & set(shared_defs.own_params(d))):
            out.append((n, d.name))
    return out


def uses(project) -> dict:
    """{name: {"sketches": [{id, sketch, name, state, message}], "parts":
    [{id, name, via: ["script" | a sketch's title, …]}]}} for each of the
    project's parameters (a name nothing uses has empty lists)."""
    params = shared_defs.params_of(project)
    out = {n: {"sketches": [], "parts": []} for n in params}
    docs = _docs(project)
    by_sketch = {}   # (doc id, sketch id) -> (title, names)
    for d in docs:
        if document_kind(shared_defs._data(d)) == "part":
            continue
        for s in _sketches(d):
            names = [n for n in shared_defs.sketch_pp(d, s, params) if n in params]
            if not names:
                continue
            title = shared_defs.sketch_title(d, s)
            by_sketch[(str(d.id), s.get("id"))] = (title, names)
            state = shared_defs.sketch_state(d, s, params)
            for n in names:
                hit = state if state and n in state["names"] else None
                out[n]["sketches"].append({"id": str(d.id), "sketch": s.get("id"), "name": title,
                                           "state": hit["state"] if hit else "ok",
                                           "message": hit["message"] if hit else ""})
    for d in docs:
        data = shared_defs._data(d)
        if document_kind(data) != "part":
            continue
        code = data.get("modelCode") if isinstance(data.get("modelCode"), str) else ""
        via = {}
        for n in pp_names(code):
            if n in out:
                via.setdefault(n, []).append("script")
        refs = data.get("sketchRefs") if isinstance(data.get("sketchRefs"), dict) else {}
        for a in sk_aliases(code):
            r = refs.get(a)
            hit = by_sketch.get((str(r.get("document")), r.get("sketch"))) if isinstance(r, dict) else None
            if hit:
                for n in hit[1]:
                    if hit[0] not in via.setdefault(n, []):
                        via[n].append(hit[0])
        for n, v in via.items():
            out[n]["parts"].append({"id": str(d.id), "name": d.name, "via": v})
    return out


def _pp_rename(code: str, old: str, new: str) -> str:
    return re.sub(r"""(\bPP(?:\[\s*|\.get\(\s*))(["'])""" + re.escape(old) + r"\2",
                  lambda m: f"{m.group(1)}{m.group(2)}{new}{m.group(2)}", code)


def _ident_rename(expr: str, old: str, new: str) -> str:
    return re.sub(r"(?<![\w.])" + re.escape(old) + r"(?!\w)", new, expr)


def _keys(d, renames: dict):
    return {renames.get(k, k): v for k, v in d.items()} if isinstance(d, dict) else d


def rename(project, renames: dict[str, str]) -> list[str]:
    """Rename project parameters where the project's documents use them:
    PP["old"] in part scripts (the overwritten script goes into the part's
    script history), the name in project sketches' dimension expressions, and
    the keys of what parts and sketches were built or solved with, so a rename
    alone doesn't make anything out of date. The names of the documents changed."""
    renames = {o: n for o, n in renames.items() if o and n and o != n}
    if not renames:
        return []
    changed = []
    for d in _docs(project):
        data = shared_defs._data(d)
        if not data:
            continue
        new = dict(data)
        if document_kind(data) == "part":
            code = data.get("modelCode") if isinstance(data.get("modelCode"), str) else ""
            out = code
            for o, n in renames.items():
                out = _pp_rename(out, o, n)
            if out != code:
                hist = data.get("modelCodeHistory") if isinstance(data.get("modelCodeHistory"), list) else []
                new["modelCode"] = out
                new["modelCodeHistory"] = [*hist, {"code": code, "at": int(time.time() * 1000),
                                                   "label": "before renaming " + ", ".join(
                                                       f"{o} to {n}" for o, n in renames.items())}][-60:]
            pinned = data.get("pinned")
            if isinstance(pinned, dict) and isinstance(pinned.get("pp"), dict):
                new["pinned"] = {**pinned, "pp": _keys(pinned["pp"], renames)}
            lb = d.last_build if isinstance(d.last_build, dict) else None
            if lb and isinstance((lb.get("inputs") or {}).get("pp"), dict):
                d.last_build = {**lb, "inputs": {**lb["inputs"], "pp": _keys(lb["inputs"]["pp"], renames)}}
                Document.objects.filter(id=d.id).update(last_build=d.last_build)
        else:
            own = shared_defs.own_params(d)
            sketches = []
            for s in data.get("sketches") or []:
                if not isinstance(s, dict):
                    sketches.append(s)
                    continue
                s = dict(s)
                ents = []
                for e in s.get("entities") or []:
                    if isinstance(e, dict) and e.get("type") == "dimension" and isinstance(e.get("expression"), str):
                        expr = e["expression"]
                        for o, n in renames.items():
                            if o not in own:
                                expr = _ident_rename(expr, o, n)
                        if expr != e["expression"]:
                            e = {**e, "expression": expr}
                    ents.append(e)
                s["entities"] = ents
                if isinstance(s.get("solvedWith"), dict):
                    s["solvedWith"] = _keys(s["solvedWith"], renames)
                if isinstance(s.get("solveError"), dict) and isinstance(s["solveError"].get("with"), dict):
                    s["solveError"] = {**s["solveError"], "with": _keys(s["solveError"]["with"], renames)}
                sketches.append(s)
            new["sketches"] = sketches
        if new != data:
            d.data = new
            d.save(update_fields=["data", "updated_at"])
            changed.append(d.name)
    return changed
