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
"""
from __future__ import annotations

import hashlib
import json
import re

from django.core.exceptions import ValidationError

from documents.models import Document, document_kind

from .engine import pp_names, sk_aliases

GROUP_USE = re.compile(r"""\.(group|named)\(\s*(["'])(.+?)\2""")


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


def _project_params(part) -> dict:
    if part is None or not part.project_id:
        return {}
    return {p["name"]: p.get("value") for p in part.project.parameters or []
            if isinstance(p, dict) and p.get("name")}


def resolve(code: str, part, user=None, refs: dict | None = None, pinned: dict | None = None,
            docs: dict | None = None) -> dict:
    """What `code` (part `part`'s script, or a document id) reads through SK
    and PP: {"sk": {alias: profile}, "pp": {name: value}, "errors": {alias:
    why}, "inputs": {"sk": {alias: {document, sketch, version}}, "pp": {...}},
    "profiles": {alias: profile}}. `refs`/`pinned` override the part's saved
    ones (the editor sends what it has, saved or not). `docs` caches sketch
    documents across calls."""
    part = _part(part)
    data = _data(part)
    refs = data.get("sketchRefs") if refs is None else refs
    refs = refs if isinstance(refs, dict) else {}
    pinned = data.get("pinned") if pinned is None else pinned
    pinned = pinned if isinstance(pinned, dict) else {}
    docs = {} if docs is None else docs
    sk, errors, used_sk = {}, {}, {}

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
        profile = s.get("profile")
        if not isinstance(profile, dict) or "items" not in profile:
            errors[alias] = (f"SK[{alias!r}]: open {sk_doc.name!r} once in the sketch editor, "
                             "so it saves its shapes for parts to use")
            continue
        sk[alias] = profile
        used_sk[alias] = {"document": str(sk_doc.id), "sketch": s.get("id"),
                          "version": profile_version(profile)}

    pp = _project_params(part)
    pinned_pp = pinned.get("pp") if isinstance(pinned.get("pp"), dict) else {}
    used_pp = {}
    for name in pp_names(code):
        if name in pinned_pp:
            pp[name] = pinned_pp[name]
        if name in pp:
            used_pp[name] = pp[name]

    inputs = {k: v for k, v in (("sk", used_sk), ("pp", used_pp)) if v}
    return {"sk": sk, "pp": pp, "errors": errors, "inputs": inputs,
            "profiles": {a: sk[a] for a in used_sk}}


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
    sketch editor can warn before one goes)."""
    qs = Document.objects.select_related("project")
    qs = (qs.filter(project_id=sk_doc.project_id) if sk_doc.project_id
          else qs.filter(project__isnull=True, created_by_id=sk_doc.created_by_id))
    out, doc_id, docs = [], str(sk_doc.id), {str(sk_doc.id): sk_doc}
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
        out.append({
            "id": str(d.id), "name": d.name,
            "uses": [{"alias": a, "sketch": r.get("sketch"), "in_script": a in aliases,
                      "groups": sorted(asked["group"]), "names": sorted(asked["named"])}
                     for a, r in mine],
            "stale": stale(d, docs),
            "pinned": bool(data.get("pinned")),
        })
    return out
