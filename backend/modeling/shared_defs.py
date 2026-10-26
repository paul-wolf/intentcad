"""A project's shared definitions, server side: which sketch each of a part's
SK["alias"] is (data.sketchRefs), the project's parameters (PP["name"]),
their versions, and what is out of date when one changes.

A part's data:
    sketchRefs: {alias: {"document": <sketch document id>, "sketch": <sketch id>}}
    pinned:     the inputs of a restored version, used instead of the latest
                until "Follow latest" clears them (same shape as inputs, with
                each sketch's profile): {"sk": {alias: {document, sketch,
                version, profile}}, "pp": {name: value}}

A sketch document's sketches each carry `profile`, the shared profile the
browser computes on save (see modeling/shared_sketch.py for its shape). A
sketch's version is a hash of that profile: its plane, shapes, element names
and groups, so renaming a group marks the parts that use it out of date.

The inputs of a build, kept in Document.last_build["inputs"] and in each
part version: {"sk": {alias: {document, sketch, version}}, "pp": {name: value}}.

A sketch document in a project can size its dimensions with the project's
parameters (by name in a dimension's expression). Only the browser solves a
sketch, so each sketch also saves what it was solved with:
    solvedWith: {name: value}   the project parameter values of its last solve
    solveError: {"with": {name: value}, "message": "…", "dimensionIds": [...]}
                when the values in `with` couldn't be solved; the sketch kept
                its last good shapes (and `solvedWith`)
A sketch whose parameters have changed since (sketch_state "pending") gives
parts no shapes until the browser solves it again; one that couldn't be solved
("failed") gives its last good shapes, and parts read the parameters it failed
on at the values those shapes were solved with ("held"), so they stay as built.
"""
from __future__ import annotations

import hashlib
import json
import re

from django.core.exceptions import ValidationError

from documents.models import Document, document_kind

from .engine import pp_names, sk_aliases

GROUP_USE = re.compile(r"""\.(group|named)\(\s*(["'])(.+?)\2""")
GROUP_BY_NAME = re.compile(r"""\.(group|named)\(\s*[^\s"')]""")     # .group(g): the name is in a variable
QUOTED = re.compile(r"""(["'])([^"'\n]+?)\1""")
IDENT = re.compile(r"(?<![\w.])[A-Za-z_][A-Za-z0-9_]*")


def profile_version(profile: dict | None) -> str:
    """A short hash of a shared sketch's profile (its plane, shapes, names and
    groups), so any change to what a part could read from it shows."""
    blob = json.dumps(profile or {}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def _data(doc) -> dict:
    return doc.data if doc is not None and isinstance(doc.data, dict) else {}


def _load(doc_id):
    try:
        return Document.objects.select_related("project").filter(id=doc_id).first()
    except (ValidationError, ValueError, TypeError):
        return None


def _part(part):
    return part if isinstance(part, Document) or part is None else _load(part)


def _may_read(user, part, sk_doc) -> bool:
    """A part may use a sketch in its own project; any other sketch only if
    whoever is building may open it (with no user: one its creator made)."""
    if part is not None and part.project_id and sk_doc.project_id == part.project_id:
        return True
    if user is not None:
        from projects.access import can_access_document

        return can_access_document(user, sk_doc)
    return bool(part is not None and sk_doc.created_by_id and sk_doc.created_by_id == part.created_by_id)


def saved_refs(part) -> dict:
    """The part's saved sketchRefs ({alias: {document, sketch}})."""
    refs = _data(_part(part)).get("sketchRefs")
    return dict(refs) if isinstance(refs, dict) else {}


def find_sketch(sk_doc, sketch_id: str) -> dict | None:
    for s in _data(sk_doc).get("sketches") or []:
        if isinstance(s, dict) and s.get("id") == sketch_id:
            return s
    return None


def params_of(project) -> dict:
    """A project's parameters as {name: value}."""
    if project is None:
        return {}
    return {p["name"]: p.get("value") for p in project.parameters or []
            if isinstance(p, dict) and p.get("name")}


def _project_params(part) -> dict:
    if part is None or not part.project_id:
        return {}
    return params_of(part.project)


def expression_names(sketch: dict) -> set[str]:
    """The names a sketch's dimension expressions use."""
    out = set()
    for e in sketch.get("entities") or []:
        if isinstance(e, dict) and e.get("type") == "dimension" and isinstance(e.get("expression"), str):
            out.update(IDENT.findall(e["expression"]))
    return out


def own_params(sk_doc) -> dict:
    """A sketch document's own parameters ({name: value})."""
    p = _data(sk_doc).get("parameters")
    return dict(p) if isinstance(p, dict) else {}


def sketch_pp(sk_doc, sketch: dict, params: dict) -> list[str]:
    """The project parameters a sketch's dimensions use (its own parameters
    of the same name come first, so those don't count), with any it was
    solved with that have since been deleted."""
    if sk_doc is None or not sk_doc.project_id:
        return []
    solved = sketch.get("solvedWith") if isinstance(sketch.get("solvedWith"), dict) else {}
    if is_generated(sk_doc):
        # what its code reads: its last run's reads and PP["…"] in the code
        gen = sketch.get("generated") if isinstance(sketch.get("generated"), dict) else {}
        reads = gen.get("reads") if isinstance(gen.get("reads"), dict) else {}
        code = _data(sk_doc).get("code")
        names = set(reads) | set(pp_names(code if isinstance(code, str) else "")) | set(solved)
        return sorted(n for n in names if n in params or n in solved)
    own = own_params(sk_doc)
    return sorted(n for n in expression_names(sketch) if n not in own and (n in params or n in solved))


def is_generated(sk_doc) -> bool:
    """A sketch document made by code (see modeling/generated_sketch.py)."""
    return _data(sk_doc).get("source") == "generated"


def sketch_title(sk_doc, sketch: dict) -> str:
    """What the project calls a sketch: its document's name (and its own name
    when the document has several)."""
    many = len(_data(sk_doc).get("sketches") or []) > 1
    return f"{sk_doc.name} · {sketch.get('name')}" if many else sk_doc.name


def sketch_state(sk_doc, sketch: dict, params: dict) -> dict | None:
    """None if `sketch` is solved with the project's current parameter values,
    else {"state": "pending"|"failed", "names": [changed names], "message",
    "held": {name: value its shapes were solved with}}."""
    used = sketch_pp(sk_doc, sketch, params)
    if not used:
        return None
    solved = sketch.get("solvedWith") if isinstance(sketch.get("solvedWith"), dict) else {}
    now = {n: params.get(n) for n in used}
    changed = [n for n in used if n not in solved or solved[n] != now[n]]
    if not changed:
        return None
    words = ", ".join(f"{n} = {_v(now[n])}" for n in changed)
    err = sketch.get("solveError")
    if isinstance(err, dict) and isinstance(err.get("with"), dict) and all(
            n in err["with"] and err["with"][n] == now[n] for n in used):
        held = {n: solved[n] for n in changed if n in solved}
        was = ", ".join(f"{n} = {_v(v)}" for n, v in held.items())
        return {"state": "failed", "names": changed, "held": held,
                "message": f"{sketch_title(sk_doc, sketch)!r} can't be solved with {words}: "
                           f"{err.get('message') or 'its dimensions conflict'}"
                           + (f" (it keeps its shapes for {was})" if was else "")}
    if is_generated(sk_doc):
        return {"state": "pending", "names": changed, "held": {},
                "message": f"{sketch_title(sk_doc, sketch)!r} hasn't been run for {words} yet"}
    return {"state": "pending", "names": changed, "held": {},
            "message": f"{sketch_title(sk_doc, sketch)!r} hasn't been solved for {words} yet: "
                       "open it, or a part that uses it, so the editor solves it"}


def _v(v) -> str:
    if v is None:
        return "(deleted)"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def resolve(code: str, part, user=None, refs: dict | None = None, pinned: dict | None = None,
            docs: dict | None = None) -> dict:
    """What `code` (part `part`'s script, or a document id) reads through SK
    and PP: {"sk": {alias: profile}, "pp": {name: value}, "errors": {alias:
    why}, "inputs": {"sk": {alias: {document, sketch, version}}, "pp": {...}},
    "profiles": {alias: profile}, "unsolved": {alias: {document, sketch, name,
    state, names, message, held}}}. A sketch not yet solved for the project's
    parameters is an error (no shapes from an unsolved sketch); one that can't
    be solved gives its last good shapes and holds the parameters it failed on
    (see sketch_state). `refs`/`pinned` override the part's saved ones (the
    editor sends what it has, saved or not). `docs` caches sketch documents
    across calls."""
    part = _part(part)
    data = _data(part)
    refs = data.get("sketchRefs") if refs is None else refs
    refs = refs if isinstance(refs, dict) else {}
    pinned = data.get("pinned") if pinned is None else pinned
    pinned = pinned if isinstance(pinned, dict) else {}
    docs = {} if docs is None else docs
    sk, errors, used_sk, unsolved, held = {}, {}, {}, {}, {}
    project_params = {}   # by project id

    for alias in sk_aliases(code):
        pin = (pinned.get("sk") or {}).get(alias)
        if isinstance(pin, dict) and isinstance(pin.get("profile"), dict):
            sk[alias] = pin["profile"]
            used_sk[alias] = {"document": pin.get("document"), "sketch": pin.get("sketch"),
                              "version": pin.get("version") or profile_version(pin["profile"])}
            continue
        ref = refs.get(alias)
        if not isinstance(ref, dict) or not ref.get("document"):
            continue   # SK[alias] explains there is no such shared sketch
        key = str(ref["document"])
        if key not in docs:
            docs[key] = _load(key)
        sk_doc = docs[key]
        if sk_doc is None:
            errors[alias] = f"SK[{alias!r}]: its sketch document was deleted (Use project sketch… to pick another)"
            continue
        if not _may_read(user, part, sk_doc):
            errors[alias] = f"SK[{alias!r}]: you can't open the sketch document {sk_doc.name!r}"
            continue
        s = find_sketch(sk_doc, ref.get("sketch"))
        if s is None:
            errors[alias] = (f"SK[{alias!r}]: {sk_doc.name!r} no longer has that sketch "
                             "(it was deleted; Use project sketch… to pick another)")
            continue
        if sk_doc.project_id not in project_params:
            project_params[sk_doc.project_id] = params_of(sk_doc.project) if sk_doc.project_id else {}
        if is_generated(sk_doc):
            # the server runs generated sketches: one not yet run for the
            # project's parameters runs now (parts never run its code)
            from .generated_sketch import rerun_if_pending

            if rerun_if_pending(sk_doc, project_params[sk_doc.project_id]):
                s = find_sketch(sk_doc, ref.get("sketch")) or s
        profile = s.get("profile")
        if not isinstance(profile, dict) or "items" not in profile:
            if is_generated(sk_doc):
                err = (s.get("generated") or {}).get("error") or {}
                errors[alias] = (f"SK[{alias!r}]: {sk_doc.name!r} hasn't made anything yet"
                                 + (f": its code fails ({err.get('message')})" if err.get("message") else ""))
                continue
            errors[alias] = (f"SK[{alias!r}]: open {sk_doc.name!r} once in the sketch editor, "
                             "so it saves its shapes for parts to use")
            continue
        state = sketch_state(sk_doc, s, project_params[sk_doc.project_id])
        if state:
            unsolved[alias] = {"document": str(sk_doc.id), "sketch": s.get("id"),
                               "project": str(sk_doc.project_id) if sk_doc.project_id else None,
                               "name": sketch_title(sk_doc, s), **state}
            if state["state"] == "pending":
                errors[alias] = f"SK[{alias!r}]: {state['message']}"
                continue
            for n, v in state["held"].items():
                held.setdefault(n, v)
        sk[alias] = profile
        used_sk[alias] = {"document": str(sk_doc.id), "sketch": s.get("id"),
                          "version": profile_version(profile)}

    pp = {**_project_params(part), **held}
    pinned_pp = pinned.get("pp") if isinstance(pinned.get("pp"), dict) else {}
    used_pp = {}
    for name in pp_names(code):
        if name in pinned_pp:
            pp[name] = pinned_pp[name]
        if name in pp:
            used_pp[name] = pp[name]

    inputs = {k: v for k, v in (("sk", used_sk), ("pp", used_pp)) if v}
    return {"sk": sk, "pp": pp, "errors": errors, "inputs": inputs,
            "profiles": {a: sk[a] for a in used_sk}, "unsolved": unsolved}


def pin_inputs(resolved: dict) -> dict:
    """The inputs to keep with a part version, with each sketch's profile, so
    restoring it builds the same thing whatever the sketch is now."""
    inputs = resolved.get("inputs") or {}
    out = {}
    if inputs.get("sk"):
        out["sk"] = {a: {**v, "profile": resolved["profiles"][a]} for a, v in inputs["sk"].items()}
    if inputs.get("pp"):
        out["pp"] = dict(inputs["pp"])
    return out


def input_key(inputs: dict | None) -> str:
    """A short key for a build's inputs (the browser's cache key includes it)."""
    if not inputs:
        return ""
    sk = {a: v.get("version") for a, v in (inputs.get("sk") or {}).items()}
    return profile_version({"sk": sk, "pp": inputs.get("pp") or {}})


def changes(built: dict | None, now: dict | None) -> list[str]:
    """What changed between the inputs a part was built with and now, in words."""
    built, now = built or {}, now or {}
    out = []
    b_sk, n_sk = built.get("sk") or {}, now.get("sk") or {}
    for a in sorted(set(b_sk) | set(n_sk)):
        if (b_sk.get(a) or {}).get("version") != (n_sk.get(a) or {}).get("version"):
            out.append(f'SK["{a}"] changed')
    b_pp, n_pp = built.get("pp") or {}, now.get("pp") or {}
    for n in sorted(set(b_pp) | set(n_pp)):
        if b_pp.get(n) != n_pp.get(n):
            out.append(f'PP["{n}"] changed')
    return out


def stale(part, docs: dict | None = None) -> list[str]:
    """Why `part`'s last build is out of date with the shared sketches and
    parameters it reads ([] if it isn't, or was never built)."""
    part = _part(part)
    code = _data(part).get("modelCode") or ""
    lb = part.last_build if part is not None else None
    if not isinstance(code, str) or not lb or not (sk_aliases(code) or pp_names(code)):
        return []
    now = resolve(code, part, docs=docs)
    return changes(lb.get("inputs"), now["inputs"])


def used_by(sk_doc) -> list[dict]:
    """The parts that use any of `sk_doc`'s sketches: [{id, name, uses:
    [{alias, sketch, groups, names}], stale}]. Groups and names are those the
    part's script asks for by .group("…") / .named("…"), any alias (so the
    sketch editor can warn before one goes); with .group(g), any quoted name
    of one of the sketch's groups counts (for g in ("holes", "slots"): …)."""
    qs = Document.objects.select_related("project")
    qs = (qs.filter(project_id=sk_doc.project_id) if sk_doc.project_id
          else qs.filter(project__isnull=True, created_by_id=sk_doc.created_by_id))
    out, doc_id, docs = [], str(sk_doc.id), {str(sk_doc.id): sk_doc}
    sketches = [k for k in _data(sk_doc).get("sketches") or [] if isinstance(k, dict)]
    known = {"group": {g.get("name") for k in sketches for g in k.get("groups") or [] if isinstance(g, dict)},
             "named": {e.get("name") for k in sketches for e in k.get("entities") or []
                       if isinstance(e, dict) and e.get("name")}}
    for d in qs.exclude(id=sk_doc.id).order_by("name"):
        data = _data(d)
        if document_kind(data) != "part":
            continue
        refs = data.get("sketchRefs") if isinstance(data.get("sketchRefs"), dict) else {}
        code = data.get("modelCode") or ""
        aliases = set(sk_aliases(code))
        mine = [(a, r) for a, r in refs.items()
                if isinstance(r, dict) and str(r.get("document")) == doc_id]
        if not mine:
            continue
        asked = {"group": set(), "named": set()}
        for m in GROUP_USE.finditer(code):
            asked[m.group(1)].add(m.group(3))
        for kind in {m.group(1) for m in GROUP_BY_NAME.finditer(code)}:
            asked[kind] |= {m.group(2) for m in QUOTED.finditer(code)} & known[kind]
        out.append({
            "id": str(d.id), "name": d.name,
            "uses": [{"alias": a, "sketch": r.get("sketch"), "in_script": a in aliases,
                      "groups": sorted(asked["group"]), "names": sorted(asked["named"])}
                     for a, r in mine],
            "stale": stale(d, docs),
            "pinned": bool(data.get("pinned")),
        })
    return out
