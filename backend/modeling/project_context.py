"""The project around a part, for the AI: the project's brief, a short list of
the project's other parts and sketches (the manifest), and read_part, the tool
that looks one of them up. Everything is scoped to the part's own project."""
import hashlib
import json
import re
from collections import Counter

from django.core.exceptions import ValidationError
from django.utils import timezone

from documents.models import Document, document_kind

from .assistant import _fmt, _vec, geometry_summary
from .paramedit import _p_values

BRIEF_SOFT_WORDS = 2000     # the project page warns above this
MANIFEST_MAX = 40           # parts and sketches listed; read_part finds the rest by name
MANIFEST_PARAMS = 6         # key parameters per part
MAX_SCRIPT_CHARS = 20000    # read_part "script" is clipped beyond this
MAX_SKETCH_LINES = 40
NOT_IN_PROJECT = "This part isn't in a project, so there are no other parts to read."


def word_count(text: str) -> int:
    return len((text or "").split())


def code_sha(code: str) -> str:
    return hashlib.sha256((code or "").encode()).hexdigest()[:16]


def build_record(code: str, result: dict) -> dict:
    """What a successful build leaves on the document (Document.last_build)."""
    m = result.get("metrics") or {}
    record = {
        "bbox_min": m.get("bbox_min"), "bbox_max": m.get("bbox_max"),
        "summary": geometry_summary(result.get("faces") or [], m),
        "code_sha": code_sha(code),
        "built_at": timezone.now().isoformat(timespec="seconds"),
    }
    if result.get("inputs"):   # the shared sketches and parameters it read (shared_defs.py)
        record["inputs"] = result["inputs"]
    return record


def save_build(document_id: str, code: str, result: dict) -> None:
    """Record a successful build of `document_id`'s script. .update() leaves
    updated_at alone (an open editor uses it to spot a save from elsewhere)."""
    try:
        Document.objects.filter(id=document_id).update(last_build=build_record(code, result))
    except (ValidationError, ValueError):
        pass


def _load(document_id):
    try:
        return Document.objects.select_related("project").filter(id=document_id).first()
    except (ValidationError, ValueError):   # not a document id
        return None


def _size(lb: dict | None) -> str:
    if not lb or not lb.get("bbox_min") or not lb.get("bbox_max"):
        return ""
    lo, hi = lb["bbox_min"], lb["bbox_max"]
    return " × ".join(_fmt(hi[i] - lo[i]) for i in range(3)) + " mm"


def _code(doc) -> str:
    data = doc.data if isinstance(doc.data, dict) else {}
    code = data.get("modelCode")
    return code if isinstance(code, str) else ""


def _params(doc) -> dict:
    """A part's P values (its key parameters), or a sketch's parameters."""
    code = _code(doc)
    if code.strip():
        try:
            return _p_values(code)
        except SyntaxError:
            return {}
    data = doc.data if isinstance(doc.data, dict) else {}
    ps = data.get("parameters")
    if isinstance(ps, dict):
        return dict(ps)
    if isinstance(ps, list):   # [{name, value|expression}, ...]
        return {p["name"]: p.get("value", p.get("expression")) for p in ps
                if isinstance(p, dict) and p.get("name")}
    return {}


def _param_text(params: dict, limit: int | None = None) -> str:
    items = list(params.items())
    shown = items[:limit] if limit else items
    text = ", ".join(f"{k}={_fmt(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else json.dumps(v)}"
                     for k, v in shown)
    return text + (f" (+{len(items) - len(shown)} more)" if len(items) > len(shown) else "")


def _entities(doc) -> list[dict]:
    data = doc.data if isinstance(doc.data, dict) else {}
    return [e for s in data.get("sketches") or [] if isinstance(s, dict)
            for e in s.get("entities") or [] if isinstance(e, dict)]


def manifest_line(doc) -> str:
    """One or two lines on a part or sketch: name, kind, short id, description,
    size, key parameters, last updated. Never its script."""
    kind = document_kind(doc.data)
    head = f'- "{doc.name}" [{kind}, id {str(doc.id)[:8]}]'
    bits = [doc.description] if doc.description else []
    if kind == "part":
        size = _size(doc.last_build)
        bits.append(f"size {size}" if size else "not built yet")
    else:
        n = Counter(e.get("type") for e in _entities(doc) if e.get("type") != "dimension")
        bits.append(", ".join(f"{c} {t}{'s' if c != 1 else ''}" for t, c in n.most_common()) or "empty")
    bits.append(f"updated {doc.updated_at:%Y-%m-%d}")
    line = head + ": " + "; ".join(bits)
    params = _params(doc)
    if params:
        line += "\n  key parameters: " + _param_text(params, MANIFEST_PARAMS)
    return line


def in_project(document_id) -> bool:
    doc = _load(document_id)
    return bool(doc and doc.project_id)


def project_context(document_id) -> str:
    """The PROJECT BRIEF and PROJECT PARTS blocks for an AI edit of
    `document_id`, or "" when it isn't in a project."""
    doc = _load(document_id)
    if not doc or not doc.project_id:
        return ""
    project = doc.project
    out = []
    if project.brief.strip():
        out.append(f'PROJECT BRIEF (project "{project.name}": its goals, constraints, materials and '
                   f"conventions — follow it in every part):\n{project.brief.strip()}")
    others = list(Document.objects.filter(project_id=doc.project_id).exclude(id=doc.id)
                  .only("id", "name", "description", "data", "last_build", "updated_at").order_by("name"))
    if others:
        lines = [manifest_line(d) for d in others[:MANIFEST_MAX]]
        if len(others) > MANIFEST_MAX:
            lines.append(f"- … {len(others) - MANIFEST_MAX} more; read_part finds any of them by name")
        out.append(f'PROJECT PARTS (the other parts and sketches in "{project.name}"; you are editing '
                   f'"{doc.name}". Call read_part to see one\'s script, parameters or geometry):\n'
                   + "\n".join(lines))
    shared = shared_context(doc, [doc, *others])
    if shared:
        out.append(shared)
    return "\n\n".join(out)


def _profile_text(profile: dict) -> str:
    """A shared sketch's plane, groups and named elements, in a line."""
    plane = profile.get("plane") or {}
    if (plane.get("normal") in (None, [0, 0, 1]) and plane.get("origin") in (None, [0, 0, 0])
            and plane.get("xAxis") in (None, [1, 0, 0])):
        bits = ["on XY of the project frame"]
    else:
        bits = [f"on its own plane (origin {_vec(plane.get('origin') or [0, 0, 0])}, "
                f"normal {_vec(plane.get('normal') or [0, 0, 1])})"]
    items = profile.get("items") or {}
    circles = {c.get("id"): c for c in items.get("circles") or []}

    def what(ids) -> str:
        cs = [circles[i] for i in ids if i in circles]
        rest = len(ids) - len(cs)
        dias = sorted({_fmt(2 * float(c.get("r") or 0)) for c in cs})
        parts = [f"{len(cs)} circle{'s' if len(cs) != 1 else ''} dia {'/'.join(dias)}"] if cs else []
        if rest:
            parts.append(f"{rest} other shape{'s' if rest != 1 else ''}")
        return ", ".join(parts) or "empty"

    groups = profile.get("groups") or {}
    if groups:
        bits.append("groups: " + "; ".join(f'"{g}" ({what(ids)})' for g, ids in groups.items()))
    names = profile.get("names") or {}
    if names:
        bits.append("named: " + ", ".join(f'"{n}"' for n in names))
    n_items = sum(len(v or []) for v in items.values())
    bits.append(f"{n_items} element{'s' if n_items != 1 else ''}, {len(profile.get('loops') or [])} closed shape(s)")
    return "; ".join(bits)


def _generated_text(gen: dict | None) -> str:
    """A generated sketch's outputs (what SK["alias"].group("name") gives) and
    the checks that fail, in a line; "" for a drawn sketch."""
    if not isinstance(gen, dict):
        return ""
    outs = gen.get("outputs") or []
    bits = ["generated from code; outputs (use as .group(\"name\")): " + ("; ".join(
        f"{o['name']} ({o.get('size') or ''}{', ' + o['description'] if o.get('description') else ''})"
        for o in outs if isinstance(o, dict) and o.get("name")) or "none")]
    failing = [c for c in gen.get("checks") or [] if isinstance(c, dict) and not c.get("ok")]
    if failing:
        bits.append("FAILING checks: " + "; ".join(
            c["name"] + (f" ({c['message']})" if c.get("message") else "") for c in failing))
    if gen.get("error"):
        bits.append("its code now fails, so parts use its last good run")
    return "; ".join(bits)


def shared_context(doc, docs: list) -> str:
    """The PROJECT PARAMETERS and SHARED SKETCHES blocks: what any part can
    read as PP["name"] and SK["alias"], and which part uses which."""
    from .engine import pp_names, sk_aliases

    out = []
    params = [p for p in doc.project.parameters or [] if isinstance(p, dict) and p.get("name")]
    users_of_param: dict[str, list[str]] = {}
    users_of_sketch: dict[tuple, list[str]] = {}
    for d in docs:
        code = _code(d)
        for name in pp_names(code):
            users_of_param.setdefault(name, []).append(d.name)
        refs = (d.data or {}).get("sketchRefs") if isinstance(d.data, dict) else None
        used = set(sk_aliases(code))
        for alias, ref in (refs or {}).items() if isinstance(refs, dict) else []:
            if isinstance(ref, dict) and alias in used:
                users_of_sketch.setdefault((str(ref.get("document")), ref.get("sketch")), []).append(
                    f'{d.name} (SK["{alias}"])')
    if params:
        lines = []
        for p in params:
            v = p.get("value")
            val = (_fmt(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else json.dumps(v))
            unit = {"deg": "°"}.get(p.get("unit"), f" {p['unit']}" if p.get("unit") else "")
            desc = f" — {p['description']}" if p.get("description") else ""
            who = users_of_param.get(p["name"])
            lines.append(f'- PP["{p["name"]}"] = {val}{unit}{desc}'
                         + (f"; used by {', '.join(who)}" if who else ""))
        out.append("PROJECT PARAMETERS (any part's script reads them as PP[\"name\"]; the user edits them "
                   "on the project page; propose a change or a new one with set_project_parameter):\n"
                   + "\n".join(lines))
    lines = []
    for d in docs:
        if document_kind(d.data) == "part":
            continue
        for s in (d.data or {}).get("sketches") or []:
            if not isinstance(s, dict):
                continue
            head = f'- "{d.name}" [id {str(d.id)[:8]}] sketch "{s.get("name") or s.get("id")}"'
            prof = s.get("profile")
            if not isinstance(prof, dict) or "items" not in prof:
                lines.append(head + ": not usable yet (the user must open it once in the sketch editor)")
                continue
            who = users_of_sketch.get((str(d.id), s.get("id")))
            gen = _generated_text(s.get("generated"))
            lines.append(f"{head}: " + (f"{gen}; " if gen else "") + _profile_text(prof)
                         + (f"; used by {', '.join(who)}" if who else ""))
    if lines:
        out.append("SHARED SKETCHES (the project's sketch documents; a part uses one through "
                   "use_sketch, then reads it as SK[\"alias\"]):\n" + "\n".join(lines[:MANIFEST_MAX]))
    refs = (doc.data or {}).get("sketchRefs") if isinstance(doc.data, dict) else None
    if isinstance(refs, dict) and refs:
        names = {str(d.id): d for d in docs}
        mine = []
        for alias, ref in refs.items():
            if not isinstance(ref, dict):
                continue
            src = names.get(str(ref.get("document")))
            sk = next((s for s in ((src.data or {}).get("sketches") or []) if isinstance(s, dict)
                       and s.get("id") == ref.get("sketch")), None) if src else None
            label = (f'"{src.name}" sketch "{(sk or {}).get("name") or ref.get("sketch")}"' if src
                     else "a sketch outside this project")
            mine.append(f'- SK["{alias}"] = {label}')
        out.append("THIS PART'S SHARED SKETCHES (already usable in its script):\n" + "\n".join(mine))
    return "\n\n".join(out)


ALIAS = re.compile(r"^[A-Za-z_][A-Za-z0-9_ -]{0,40}$")


def use_sketch(document_id, document: str, sketch: str, alias: str) -> tuple[dict | None, str]:
    """The use_sketch tool: ({alias: {document, sketch}} to add to the part's
    sketchRefs, or None) and a message for the model describing it."""
    alias = (alias or "").strip()
    if not ALIAS.match(alias):
        return None, (f"{alias!r} isn't a usable alias: a short name of letters, digits and _ "
                      'such as "frame" or "arm_holes".')
    doc, why = find_document(document_id, document)
    if why:
        return None, why
    if document_kind(doc.data) == "part":
        return None, f'"{doc.name}" is a part, not a sketch; use_sketch takes a sketch document.'
    sketches = [s for s in (doc.data or {}).get("sketches") or [] if isinstance(s, dict)]
    want = (sketch or "").strip().lower()
    hits = ([s for s in sketches if want in ((s.get("name") or "").lower(), str(s.get("id")).lower())]
            if want else sketches)
    if len(hits) != 1:
        listed = ", ".join(f'"{s.get("name") or s.get("id")}"' for s in sketches)
        return None, (f'"{doc.name}" has {"no sketch called " + repr(sketch) if want and not hits else "several sketches"}; '
                      f"name one of: {listed}.")
    s = hits[0]
    prof = s.get("profile")
    if not isinstance(prof, dict) or "items" not in prof:
        return None, (f'"{doc.name}" hasn\'t saved its shapes for parts yet: ask the user to open it once '
                      "in the sketch editor, then try again.")
    ref = {alias: {"document": str(doc.id), "sketch": s.get("id")}}
    gen = _generated_text(s.get("generated"))
    return ref, (f'SK["{alias}"] is now "{doc.name}" sketch "{s.get("name") or s.get("id")}": '
                 + (f"{gen}; " if gen else "") + f"{_profile_text(prof)}. Write the script with SK[\"{alias}\"] (its .group(...), "
                 ".named(...), .circles, .points, .on(...)).")


def check_parameter(args: dict) -> tuple[dict | None, str]:
    """A set_project_parameter call: (the parameter, None) or (None, why not)."""
    from projects.api import check_parameters

    name = str(args.get("name", "")).strip()
    value = args.get("value")
    if isinstance(value, str):
        try:
            value = float(value) if value.strip() and re.fullmatch(r"-?\d+(\.\d+)?", value.strip()) else value
        except ValueError:
            pass
    if not isinstance(value, (int, float, str)) or isinstance(value, bool):
        return None, "value must be a number (mm or degrees) or a short text"
    p = {"name": name, "value": value, "unit": str(args.get("unit") or "").strip(),
         "description": str(args.get("description") or "").strip()}
    why = check_parameters([p])
    return (None, why) if why else (p, "")


def find_document(document_id, ref: str):
    """A document in the same project as `document_id`, by id, id prefix or
    name: (doc, None), or (None, why not) — a message for the model."""
    doc = _load(document_id)
    if not doc or not doc.project_id:
        return None, NOT_IN_PROJECT
    ref = (ref or "").strip().strip('"@').strip()
    if not ref:
        return None, "Name the part or sketch to read."
    qs = Document.objects.filter(project_id=doc.project_id)
    if re.fullmatch(r"[0-9a-fA-F-]{6,36}", ref):
        hits = [d for d in qs.only("id") if str(d.id).startswith(ref.lower())]
        if len(hits) == 1:
            return qs.get(id=hits[0].id), None
    names = list(qs.values_list("id", "name"))
    exact = [i for i, n in names if n.lower() == ref.lower()]
    if len(exact) == 1:
        return qs.get(id=exact[0]), None
    words = ref.lower().split()
    near = [(i, n) for i, n in names if all(w in n.lower() for w in words)]
    if len(near) == 1:
        return qs.get(id=near[0][0]), None
    if near:   # (an exact name taken twice is here too)
        listed = ", ".join(f'"{n}" (id {str(i)[:8]})' for i, n in near)
        return None, f'"{ref}" matches more than one: {listed}. Ask again with the id.'
    return None, (f'No part or sketch called "{ref}" in this project. It has: '
                  + ", ".join(f'"{n}"' for _, n in names) + ".")


def _geometry(doc) -> str:
    """The latest build's geometry summary, built now (and saved) if the
    saved script hasn't been built since it last changed."""
    from .engine import EngineError, run_script

    code = _code(doc)
    lb = doc.last_build or {}
    if lb.get("summary") and lb.get("code_sha") == code_sha(code):
        return lb["summary"]
    try:
        r = run_script(code, document_id=str(doc.id))
    except EngineError as exc:
        old = f"\nThe last successful build, of an earlier script:\n{lb['summary']}" if lb.get("summary") else ""
        return f"Its saved script doesn't build: {exc}{old}"
    save_build(str(doc.id), code, r)
    return build_record(code, r)["summary"]


def _point(p) -> str:
    return f"({_fmt(p.get('x', 0))}, {_fmt(p.get('y', 0))})" if isinstance(p, dict) else "?"


def sketch_summary(doc) -> str:
    """A sketch's shapes, one line each (circles with centre and diameter, so a
    hole pattern drawn in it reads off directly)."""
    lines = []
    for e in _entities(doc):
        t = e.get("type")
        tag = " (construction)" if e.get("construction") else ""
        if t == "circle":
            lines.append(f"circle centre {_point(e.get('center'))} dia {_fmt(2 * float(e.get('radius') or 0))}{tag}")
        elif t == "rectangle":
            r = f", corner r {_fmt(e['cornerRadius'])}" if e.get("cornerRadius") else ""
            lines.append(f"rectangle {_fmt(e.get('width') or 0)} × {_fmt(e.get('height') or 0)} "
                         f"{'corner' if e.get('anchor') == 'corner' else 'centre'} {_point(e.get('center'))}{r}{tag}")
        elif t == "line":
            pts = e.get("points") or []
            what = "closed outline" if e.get("closed") else ("line" if len(pts) == 2 else "polyline")
            shown = " → ".join(_point(p) for p in pts[:6]) + (" …" if len(pts) > 6 else "")
            lines.append(f"{what} {shown}{tag}")
        elif t == "point":
            lines.append(f"point {_point(e.get('position'))}{tag}")
        elif t == "text":
            lines.append(f"text {json.dumps(e.get('text', ''))} at {_point(e.get('position'))}")
        elif t == "bezier":
            lines.append(f"curve from {_point((e.get('controlPoints') or [{}])[0])}{tag}")
    if len(lines) > MAX_SKETCH_LINES:
        lines = lines[:MAX_SKETCH_LINES] + [f"… {len(lines) - MAX_SKETCH_LINES} more shapes"]
    return "\n".join(lines) or "(empty)"


def read_part(document_id, part: str, what: str) -> str:
    """The read_part tool: another part or sketch of the same project, as text.
    `what` is "script", "parameters" or "summary". Read-only."""
    doc, why = find_document(document_id, part)
    if why:
        return why
    kind = document_kind(doc.data)
    head = f'"{doc.name}" [{kind}, id {str(doc.id)[:8]}]' + (f": {doc.description}" if doc.description else "")
    if what == "script":
        code = _code(doc)
        if kind != "part" or not code.strip():
            return f"{head}\nA sketch has no script. Its shapes (mm):\n{sketch_summary(doc)}"
        clipped = code if len(code) <= MAX_SCRIPT_CHARS else code[:MAX_SCRIPT_CHARS] + "\n# … (clipped)"
        return f"{head}\nIts build123d script (read-only; you can't change it from here):\n```python\n{clipped}\n```"
    if what == "parameters":
        params = _params(doc)
        return f"{head}\nParameters: {_param_text(params) if params else 'none'}"
    if what == "summary":
        params = _params(doc)
        p = f"\nParameters: {_param_text(params)}" if params else ""
        if kind != "part":
            return f"{head}{p}\nShapes (mm, in the sketch's plane):\n{sketch_summary(doc)}"
        if not _code(doc).strip():
            return f"{head}{p}\nIt has no script yet."
        return f"{head}{p}\nGeometry of its latest build (mm):\n{_geometry(doc)}"
    return f'Unknown "what": {what!r}. Use "script", "parameters" or "summary".'


def mention_context(document_id, ids: list[str]) -> str:
    """The parts the user @-mentioned in this message: each one's summary."""
    out = []
    for ref in dict.fromkeys(ids or []):
        doc, why = find_document(document_id, ref)
        if doc:
            out.append(read_part(document_id, str(doc.id), "summary"))
    return "\n\n".join(out)


READ_PART_TOOL = {
    "name": "read_part",
    "description": "Look at another part or sketch in this project (listed under PROJECT PARTS): "
                   "its build123d script, its parameters, or a summary of its latest build's geometry "
                   "(size, planar faces, holes with centres and diameters; for a sketch, its shapes). "
                   "Read-only. Use it whenever a question or an edit depends on another part.",
    "input_schema": {
        "type": "object",
        "properties": {
            "part": {"type": "string", "description": "the part's name (as listed) or its id"},
            "what": {"type": "string", "enum": ["script", "parameters", "summary"]},
        },
        "required": ["part", "what"],
        "additionalProperties": False,
    },
}

USE_SKETCH_TOOL = {
    "name": "use_sketch",
    "description": "Let this part's script use one of the project's SHARED SKETCHES as SK[\"<alias>\"] "
                   "(a build123d Sketch on its plane, with .group(name), .named(name), .circles, .points, "
                   ".on(plane)). Call it before writing a script that reads SK[alias]; the reply describes "
                   "the sketch's groups and names. Use a shared sketch rather than copying its numbers, so "
                   "the parts follow it when it changes.",
    "input_schema": {
        "type": "object",
        "properties": {
            "document": {"type": "string", "description": "the sketch document's name (as listed) or id"},
            "sketch": {"type": "string", "description": "which sketch in it, by name (blank if it has one)"},
            "alias": {"type": "string", "description": "the short name the script uses, e.g. \"frame\""},
        },
        "required": ["document", "alias"],
        "additionalProperties": False,
    },
}

SET_PROJECT_PARAMETER_TOOL = {
    "name": "set_project_parameter",
    "description": "Propose a new or changed PROJECT PARAMETER (PP[\"name\"], read by every part that uses "
                   "it), e.g. a tube diameter or plate thickness several parts share. The user accepts or "
                   "rejects it on a card; your script can use the proposed value right away. Changing one "
                   "changes every part that reads it, so say which in the reason.",
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "letters, digits and _, e.g. arm_od"},
            "value": {"anyOf": [{"type": "number"}, {"type": "string"}],
                      "description": "a number (mm or degrees) or a short text such as \"M3\""},
            "unit": {"type": "string", "enum": ["mm", "deg", ""]},
            "description": {"type": "string", "description": "what it is, in a few words"},
            "reason": {"type": "string", "description": "one short sentence: why, and which parts it affects"},
        },
        "required": ["name", "value", "unit", "reason"],
        "additionalProperties": False,
    },
}

PROPOSE_BRIEF_TOOL = {
    "name": "propose_brief_edit",
    "description": "Propose a new text for the PROJECT BRIEF (e.g. to record a decision, a material, "
                   "a bought part or a convention the user just settled). The user sees a diff and "
                   "accepts or rejects it; you never change the brief yourself. Send the complete new "
                   "brief, keeping everything still true. Then finish with your reply as usual.",
    "input_schema": {
        "type": "object",
        "properties": {
            "new_text": {"type": "string", "description": "the complete new brief (markdown)"},
            "reason": {"type": "string", "description": "one short sentence: what changes and why"},
        },
        "required": ["new_text", "reason"],
        "additionalProperties": False,
    },
}
