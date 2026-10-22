"""The CAM chat: the AI plans, edits and explains a job's operations.

The model answers through one tool, cam_reply. Its reply only ever proposes:
the setup fields to fill, new operations, and overrides on existing ones. It
has no place for the post-processor or the machine's safety settings, and
normalize_reply() drops anything outside the schema (with a note), so the
frontend's validate.ts still checks everything that reaches the G-code. The
model call is injected (`llm=`) so the prompt and the normalising are testable.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Callable

from modeling.assistant import AssistantError, _anthropic_call
from modeling.llm_models import call_cost, is_known, list_models

from .advisor import describe_entities
from .validators import MATERIALS
ORIGINS = ["front-left", "front-centre", "front-right", "centre", "back-left", "back-centre", "back-right"]
Z_ZEROS = ["stock-top", "spoilboard"]
KINDS = ["profile", "pocket", "drill", "facing"]
CUT_SIDES = ["outside", "inside", "on"]

MAX_TEXT = 2000      # summary, answer
MAX_ITEM = 500       # each choice, assumption, reason
MAX_LIST = 20        # every list in the reply
MAX_HISTORY = 10     # turns of the conversation sent to the model

# Each override the AI may set: ("num", lo, lo_inclusive, hi, hi_inclusive),
# ("int", lo, hi), ("enum", values), ("bool",) or ("tool",).
OVERRIDES: dict[str, tuple] = {
    "toolId": ("tool",),
    "depth": ("num", 0, False, 200, True),
    "depthPerPass": ("num", 0, False, 50, True),
    "lastPassDepth": ("num", 0, True, 5, True),
    "rpm": ("num", 1000, True, 60000, True),
    "chipLoad": ("num", 0, False, 0.5, True),
    "plungePercent": ("num", 5, True, 100, True),
    "stepover": ("num", 0.05, True, 0.95, True),
    "entry": ("enum", ["plunge", "ramp"]),
    "rampAngle": ("num", 0.5, True, 20, True),
    "cutDirection": ("enum", ["climb", "conventional"]),
    "tabs": ("bool",),
    "tabCount": ("int", 1, 20),
    "tabWidth": ("num", 0, False, 50, True),
    "tabHeight": ("num", 0, False, 50, True),
    "holeMethod": ("enum", ["drill", "helix"]),
    "peckDepth": ("num", 0, True, 50, True),
    "dwell": ("num", 0, True, 10, True),
}

# Keys the AI must never change, and why (the note the user reads).
MACHINE_KEYS = {"safeZ", "clearanceZ", "travel", "maxRpm", "rapidRate", "park", "toolChange",
                "spoilboardAllowance", "machine", "spindle", "coolant", "dial", "limits"}
POST_KEYS = {"postProcessor", "post", "dialect", "header", "footer", "decimalPlaces"}
FEED_KEYS = {"feedRate", "feed", "plungeRate", "plungeFeed", "spindleSpeed"}


CAM_TOOL = {
    "name": "cam_reply",
    "description": "Your whole reply to the user: the plan, the changes to it, and the answer. "
                   "Always answer through this tool.",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string",
                        "description": "One or two sentences: what the plan does, or what changed."},
            "answer": {"type": "string",
                       "description": "The reply to the user's message in plain words, without repeating "
                                      "the summary (\"\" if the summary says it all)."},
            "choices": {"type": "array", "items": {"type": "string"},
                        "description": "Decisions made, each with its reason."},
            "assumptions": {"type": "array", "items": {"type": "string"},
                            "description": "Things assumed that the user should check."},
            "setup": {
                "type": "object",
                "description": "Only the setup fields to fill or change.",
                "properties": {
                    "material": {"type": "string"},
                    "thickness": {"type": "number"},
                    "width": {"type": ["number", "null"]},
                    "height": {"type": ["number", "null"]},
                    "origin": {"type": "string", "enum": ORIGINS},
                    "zZero": {"type": "string", "enum": Z_ZEROS},
                },
            },
            "operations": {
                "type": "array", "description": "New operations to propose.",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": KINDS},
                        "entityIds": {"type": "array", "items": {"type": "string"}},
                        "cutSide": {"type": "string", "enum": CUT_SIDES},
                        "overrides": {"type": "object"},
                        "reason": {"type": "string"},
                    },
                    "required": ["kind", "entityIds"],
                },
            },
            "edits": {
                "type": "array", "description": "Changes to existing operations.",
                "items": {
                    "type": "object",
                    "properties": {
                        "opId": {"type": "string"},
                        "entityIds": {"type": "array", "items": {"type": "string"},
                                      "description": "Only to change the shapes it cuts: all of them, "
                                                     "replacing the current ones."},
                        "overrides": {"type": "object"},
                        "reset": {"type": "array", "items": {"type": "string"},
                                  "description": "Override keys to remove (back to the default)."},
                        "reason": {"type": "string"},
                    },
                    "required": ["opId"],
                },
            },
            "remove": {"type": "array", "items": {"type": "string"},
                       "description": "Ids of operations to delete."},
        },
        "required": ["summary", "answer"],
    },
}


# ── Normalising the reply ──


def _name(key: Any) -> str:
    return str(key)[:40]


def _text(v: Any, cap: int) -> str:
    return v.strip()[:cap] if isinstance(v, str) else ""


def _number(v: Any) -> float | None:
    """A finite number (a numeric string counts), else None. Booleans don't count."""
    if isinstance(v, bool):
        return None
    if isinstance(v, str):
        try:
            v = float(v.strip())
        except ValueError:
            return None
    if isinstance(v, (int, float)) and math.isfinite(v):
        return v
    return None


def _ignored(key: Any, where: str = "") -> str:
    k = _name(key)
    if k in MACHINE_KEYS:
        return f"Ignored a change to {k}: the AI can't change machine settings"
    if k in POST_KEYS:
        return f"Ignored a change to {k}: the AI can't change the post-processor"
    if k in FEED_KEYS:
        return f"Ignored {k}: feeds come from chip load × flutes × rpm, not set directly"
    return f"Ignored an unknown field {k}{where}"


def _texts(v: Any, label: str, notes: list[str]) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list):
        if isinstance(v, str) and v.strip():
            return [v.strip()[:MAX_ITEM]]
        notes.append(f"Ignored the {label}: not a list")
        return []
    out = [s.strip()[:MAX_ITEM] for s in v if isinstance(s, str) and s.strip()]
    if len(out) > MAX_LIST:
        notes.append(f"Kept the first {MAX_LIST} {label}")
    return out[:MAX_LIST]


def _override(key: str, v: Any, tool_ids: set[str]) -> tuple[bool, Any]:
    """(True, the clean value) if `v` is allowed for override `key`."""
    rule = OVERRIDES[key]
    if rule[0] == "tool":
        return (isinstance(v, (str, int)) and not isinstance(v, bool) and str(v) in tool_ids), str(v)
    if rule[0] == "enum":
        return v in rule[1], v
    if rule[0] == "bool":
        return isinstance(v, bool), v
    n = _number(v)
    if n is None:
        return False, None
    if rule[0] == "int":
        return (n == int(n) and rule[1] <= n <= rule[2]), int(n)
    _, lo, lo_in, hi, hi_in = rule
    ok = (n >= lo if lo_in else n > lo) and (n <= hi if hi_in else n < hi)
    return ok, n


def _overrides(raw: Any, tool_ids: set[str], notes: list[str], where: str) -> dict:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        notes.append(f"Ignored the overrides of {where}: not a set of values")
        return {}
    out = {}
    for k, v in raw.items():
        if k not in OVERRIDES:
            notes.append(_ignored(k, f" on {where}"))
            continue
        ok, clean = _override(k, v, tool_ids)
        if not ok:
            what = "a tool not in the library" if OVERRIDES[k][0] == "tool" else "out of range"
            notes.append(f"Ignored {k} = {_name(v)} on {where}: {what}")
            continue
        out[k] = clean
    return out


def _setup(raw: Any, materials: list[str], notes: list[str]) -> dict:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        notes.append("Ignored the setup: not a set of values")
        return {}
    raw = dict(raw)
    stock = raw.pop("stock", None)       # {"stock": {"thickness": …}} → flat
    if isinstance(stock, dict):
        for k in ("thickness", "width", "height"):
            if k in stock and k not in raw:
                raw[k] = stock[k]
    out = {}
    for k, v in raw.items():
        if k == "material":
            if v in materials:
                out[k] = v
            else:
                notes.append(f"Ignored the material {_name(v)}: not one of the materials")
        elif k == "thickness":
            n = _number(v)
            if n is not None and 0 < n <= 200:
                out[k] = n
            else:
                notes.append(f"Ignored the stock thickness {_name(v)}: out of range")
        elif k in ("width", "height"):
            n = _number(v)
            if v is None:
                out[k] = None
            elif n is not None and 0 < n <= 5000:
                out[k] = n
            else:
                notes.append(f"Ignored the stock {k} {_name(v)}: out of range")
        elif k == "origin":
            if v in ORIGINS:
                out[k] = v
            else:
                notes.append(f"Ignored the origin {_name(v)}: not a known corner or centre")
        elif k == "zZero":
            if v in Z_ZEROS:
                out[k] = v
            else:
                notes.append(f"Ignored Z zero {_name(v)}: must be stock-top or spoilboard")
        else:
            notes.append(_ignored(k, " in the setup"))
    return out


def _fold(item: dict, keep: set[str], notes: list[str], where: str) -> dict:
    """The item's own keys outside `keep`: an override key at the wrong level
    moves into its overrides; anything else is dropped with a note."""
    extra = {}
    for k in item:
        if k in keep:
            continue
        if k in OVERRIDES:
            extra[k] = item[k]
        else:
            notes.append(_ignored(k, f" on {where}"))
    return extra


def _operations(raw: Any, entity_ids: set[str], tool_ids: set[str], notes: list[str]) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        notes.append("Ignored the new operations: not a list")
        return []
    out = []
    for i, op in enumerate(raw):
        where = f"new operation {i + 1}"
        if not isinstance(op, dict):
            notes.append(f"Ignored {where}: not an operation")
            continue
        kind = op.get("kind")
        if kind not in KINDS:
            notes.append(f"Ignored {where}: unknown kind {_name(kind)}")
            continue
        where = f"the new {kind} ({i + 1})"
        kept = _shape_ids(op.get("entityIds"), entity_ids, notes, where)
        if not kept and kind != "facing":
            notes.append(f"Ignored {where}: none of its shapes exist")
            continue
        cut_side = op.get("cutSide")
        if cut_side not in CUT_SIDES:
            if cut_side is not None:
                notes.append(f"Cut side {_name(cut_side)} on {where} is not known: used outside")
            cut_side = "outside"
        overrides = {**_fold(op, {"kind", "entityIds", "cutSide", "overrides", "reason"}, notes, where),
                     **(op.get("overrides") if isinstance(op.get("overrides"), dict) else {})}
        if op.get("overrides") is not None and not isinstance(op.get("overrides"), dict):
            notes.append(f"Ignored the overrides of {where}: not a set of values")
        out.append({"kind": kind, "entityIds": kept, "cutSide": cut_side,
                    "overrides": _overrides(overrides, tool_ids, notes, where),
                    "reason": _text(op.get("reason"), MAX_ITEM)})
        if len(out) == MAX_LIST:
            if len(raw) > i + 1:
                notes.append(f"Kept the first {MAX_LIST} new operations")
            break
    return out


def _shape_ids(ids: Any, entity_ids: set[str], notes: list[str], where: str) -> list[str]:
    """The known shape ids among `ids`, in order and once each; the rest get a note."""
    if ids is None:
        ids = []
    elif not isinstance(ids, list):
        ids = [ids]
    kept: list[str] = []
    for e in ids:
        if isinstance(e, (str, int)) and not isinstance(e, bool) and str(e) in entity_ids:
            if str(e) not in kept:
                kept.append(str(e))
        else:
            notes.append(f"Dropped shape {_name(e)} from {where}: no shape has that id")
    return kept


def _edits(raw: Any, op_ids: dict[str, str], entity_ids: set[str], tool_ids: set[str],
           notes: list[str]) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        notes.append("Ignored the edits: not a list")
        return []
    out = []
    for i, ed in enumerate(raw):
        if not isinstance(ed, dict):
            notes.append(f"Ignored edit {i + 1}: not an edit")
            continue
        op_id = ed.get("opId")
        if not isinstance(op_id, (str, int)) or isinstance(op_id, bool) or str(op_id) not in op_ids:
            notes.append(f"Ignored an edit of operation {_name(op_id)}: no operation has that id")
            continue
        op_id = str(op_id)
        where = op_ids[op_id]
        given = ed.get("overrides")
        if given is not None and not isinstance(given, dict):
            notes.append(f"Ignored the overrides of {where}: not a set of values")
            given = None
        merged = {**_fold(ed, {"opId", "entityIds", "overrides", "reset", "reason"}, notes, where),
                  **(given or {})}
        shapes = None
        if ed.get("entityIds") is not None:
            shapes = _shape_ids(ed.get("entityIds"), entity_ids, notes, where)
            if not shapes:
                notes.append(f"Kept the shapes of {where}: none of the new ones exist")
                shapes = None
        reset_raw = ed.get("reset")
        if reset_raw is None:
            reset_raw = []
        elif not isinstance(reset_raw, list):
            reset_raw = [reset_raw]
        reset: list[str] = []
        for k in reset_raw:
            if isinstance(k, str) and k in OVERRIDES:
                if k not in reset:
                    reset.append(k)
            else:
                notes.append(f"Ignored resetting {_name(k)} on {where}: not a setting it can reset")
        overrides = _overrides(merged, tool_ids, notes, where)
        if not overrides and not reset and shapes is None:
            continue
        edit = {"opId": op_id, "overrides": overrides, "reset": reset,
                "reason": _text(ed.get("reason"), MAX_ITEM)}
        if shapes is not None:
            edit["entityIds"] = shapes
        out.append(edit)
        if len(out) == MAX_LIST:
            if len(raw) > i + 1:
                notes.append(f"Kept the first {MAX_LIST} edits")
            break
    return out


def _remove(raw: Any, op_ids: dict[str, str], notes: list[str]) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raw = [raw]
    out: list[str] = []
    for r in raw:
        if isinstance(r, (str, int)) and not isinstance(r, bool) and str(r) in op_ids:
            if str(r) not in out:
                out.append(str(r))
        else:
            notes.append(f"Ignored removing operation {_name(r)}: no operation has that id")
    return out[:MAX_LIST]


def _readable(text: str, words: dict[str, str]) -> str:
    """`text` with each id in `words` (shape or operation ids) put in words."""
    if not text:
        return text
    pattern = re.compile(r"(?<![\w-])(?:" + "|".join(re.escape(k) for k in sorted(words, key=len, reverse=True))
                         + r")(?![\w-])")
    text = pattern.sub(lambda m: words[m.group(0)], text)
    return re.sub(r"\b([Oo])perations? (?:id )?(operation \d+)", lambda m: m.group(1) + m.group(2)[1:], text)


REPLY_KEYS = {"summary", "answer", "choices", "assumptions", "setup", "operations", "edits", "remove"}


def normalize_reply(raw: Any, known_entity_ids, known_tool_ids, known_op_ids,
                    materials=None, labels: dict[str, str] | None = None) -> tuple[dict, list[str]]:
    """The model's cam_reply input made safe for the client: (reply, notes).

    Never raises. Every field is checked against the schema and the job (shape,
    tool and operation ids); what doesn't fit is dropped and a note says why.
    `known_op_ids` is in cutting order, so notes and text name an operation by
    its number; `labels` (shape id → words) replaces shape ids left in the text."""
    entity_ids = {str(e) for e in known_entity_ids or []}
    tool_ids = {str(t) for t in known_tool_ids or []}
    op_ids: dict[str, str] = {}
    for o in known_op_ids or []:
        op_ids.setdefault(str(o), f"operation {len(op_ids) + 1}")
    materials = list(materials or MATERIALS)
    notes: list[str] = []
    if not isinstance(raw, dict):
        notes.append("The AI's reply could not be read")
        raw = {}
    for k in raw:
        if k not in REPLY_KEYS:
            notes.append(_ignored(k))
    reply = {
        "summary": _text(raw.get("summary"), MAX_TEXT),
        "answer": _text(raw.get("answer"), MAX_TEXT),
        "choices": _texts(raw.get("choices"), "choices", notes),
        "assumptions": _texts(raw.get("assumptions"), "assumptions", notes),
        "setup": _setup(raw.get("setup"), materials, notes),
        "operations": _operations(raw.get("operations"), entity_ids, tool_ids, notes),
        "edits": _edits(raw.get("edits"), op_ids, entity_ids, tool_ids, notes),
        "remove": _remove(raw.get("remove"), op_ids, notes),
    }
    words = {**{k: v for k, v in (labels or {}).items() if k in entity_ids}, **op_ids}
    if words:
        reply["summary"] = _readable(reply["summary"], words)
        reply["answer"] = _readable(reply["answer"], words)
        reply["choices"] = [_readable(c, words) for c in reply["choices"]]
        reply["assumptions"] = [_readable(a, words) for a in reply["assumptions"]]
        for item in reply["operations"] + reply["edits"]:
            item["reason"] = _readable(item["reason"], words)
    seen: list[str] = []
    for n in notes:
        if n not in seen:
            seen.append(n)
    return reply, seen[:MAX_LIST * 2]


# ── The prompt ──


SYSTEM = """You are a CNC programmer planning a 2.5D job for a CNC router. You talk with the user \
about the job in a chat, and you always reply through the cam_reply tool: never answer in plain text.

Units are mm. The sketch's Y axis points down: the front of the stock (nearest the operator) is the \
sketch's largest y.

The settings come in levels. The machine (read-only for you) has a tool library and presets: the \
default feeds and speeds of each tool in each material. The job setup holds the stock, the material \
and the origin. Each operation stores only overrides of the defaults it resolves to; the current plan \
shows each operation's resolved values.

How to plan:
- Set an override only where a value should differ from the resolved default, and give the reason.
- Prefer tools already in use in the plan; each tool change costs time.
- Inside work goes before outside work; the cut that frees the part goes last.
- An outside profile cut through the stock keeps tabs so the part stays put.
- Drill a hole with a drill bit of the hole's size if the library has one; otherwise bore it with a \
helix ("holeMethod": "helix"), with an end mill between half the hole's size and the hole's size.
- Never set feed rates: the feed comes from chipLoad x flutes x rpm, so change chipLoad or rpm.
- Never change anything about the post-processor, the safe or clearance heights, the park position \
or the machine's limits: the reply has no place for them, and the user sets them on the machine.
- Copy shape ids, tool ids and operation ids exactly as they are listed.
- Lines that join end to end make one outline (see OUTLINES): an inside or outside cut of it takes \
all of its lines.
- An operation with the wrong shapes, or none, gets them in an edit: "entityIds" lists all the shapes \
it should cut.
- Only remove operations that you proposed and the user has not accepted, or when the user asks.
- Carbon fibre is abrasive and splinters at the edges: keep the presets' shallow passes and ramp \
entries, keep tabs on parts cut free, and drill holes before the outside cut. Its dust is harmful and \
conducts electricity: if the user asks about cutting it, say to use dust extraction or cut wet.

How to reply:
- "summary": one or two sentences on what the plan does, or what changed.
- "answer": the reply to the user's message, in plain, short sentences; don't repeat the summary \
("" if the summary says it all).
- The user never sees ids: name shapes by size and place ("the 28 Ø3.4 holes", "the outer outline") \
and operations by their number in the plan ("operation 2").
- "choices": each decision with its reason, e.g. "T2 6mm end mill for the pocket: the largest that fits".
- "assumptions": what you assumed that the user should check.
- To fix an issue, edit the operation it names.
- To answer a question, answer it; change the plan only if the user asks for a change.

Override keys you may set: toolId (an id from the tool library), depth (mm), depthPerPass (mm), \
lastPassDepth (mm), rpm, chipLoad (mm per tooth), plungePercent (% of the feed), stepover (fraction of \
the tool's diameter), entry ("plunge" or "ramp"), rampAngle (degrees), cutDirection ("climb" or \
"conventional"), tabs (true/false), tabCount, tabWidth (mm), tabHeight (mm), holeMethod ("drill" or \
"helix"), peckDepth (mm, 0 for a single plunge), dwell (seconds)."""


def _list(v: Any) -> list:
    return v if isinstance(v, list) else []


def _dict(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


def _js(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, default=str)


def known_entity_ids(sketches: Any) -> list[str]:
    """Ids of the shapes an operation may cut (construction geometry left out)."""
    out = []
    for s in _list(sketches):
        for e in _list(_dict(s).get("entities")):
            if isinstance(e, dict) and e.get("id") is not None and not e.get("construction"):
                out.append(str(e["id"]))
    return out


CHAIN_TOL = 0.5   # mm: line ends this close meet (as in the frontend's contours.ts)


def _point(p: Any) -> tuple[float, float] | None:
    p = _dict(p)
    x, y = _number(p.get("x")), _number(p.get("y"))
    return None if x is None or y is None else (x, y)


def entity_labels(sketches: Any) -> dict[str, str]:
    """Each cuttable shape's id → words for it, to put in the AI's text in place of the id."""
    out: dict[str, str] = {}
    for s in _list(sketches):
        for e in _list(_dict(s).get("entities")):
            if not isinstance(e, dict) or e.get("id") is None or e.get("construction"):
                continue
            t = e.get("type")
            c = _point(e.get("center"))
            if t == "circle" and c and _number(e.get("radius")):
                out[str(e["id"])] = f"the Ø{2 * _number(e['radius']):g} circle at ({c[0]:.1f}, {c[1]:.1f})"
            elif t == "rectangle" and c:
                out[str(e["id"])] = (f"the {_number(e.get('width')) or 0:g} x {_number(e.get('height')) or 0:g} "
                                     f"rectangle at ({c[0]:.1f}, {c[1]:.1f})")
            elif t == "line":
                pts = [q for q in (_point(p) for p in _list(e.get("points"))) if q]
                if len(pts) >= 2:
                    out[str(e["id"])] = f"the line from ({pts[0][0]:.1f}, {pts[0][1]:.1f})"
    return out


def describe_outlines(sketches: Any) -> list[str]:
    """Lines that meet end to end, as the outlines the toolpath cuts (one line each).

    An inside or outside cut of such an outline needs all of its lines."""
    ends: list[tuple[str, tuple[float, float], tuple[float, float], list]] = []
    for s in _list(sketches):
        for e in _list(_dict(s).get("entities")):
            if not isinstance(e, dict) or e.get("type") != "line" or e.get("construction") or e.get("closed"):
                continue
            pts = [q for q in (_point(p) for p in _list(e.get("points"))) if q]
            if len(pts) >= 2 and e.get("id") is not None:
                ends.append((str(e["id"]), pts[0], pts[-1], pts))
    near = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1]) <= CHAIN_TOL
    parent = list(range(len(ends)))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i in range(len(ends)):
        for j in range(i + 1, len(ends)):
            if any(near(a, b) for a in ends[i][1:3] for b in ends[j][1:3]):
                parent[root(i)] = root(j)
    groups: dict[int, list[int]] = {}
    for i in range(len(ends)):
        groups.setdefault(root(i), []).append(i)
    lines = []
    for members in groups.values():
        if len(members) < 2:
            continue
        # Closed when every end meets another line's end.
        closed = all(any(near(p, q) for j in members if j != i for q in ends[j][1:3])
                     for i in members for p in ends[i][1:3])
        pts = [p for i in members for p in ends[i][3]]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        ids = [ends[i][0] for i in members]
        lines.append(f"- lines {_js(ids)} join end to end into one {'closed' if closed else 'open'} outline, "
                     f"bounding box {max(xs) - min(xs):.2f} x {max(ys) - min(ys):.2f} "
                     f"from ({min(xs):.2f}, {min(ys):.2f})")
    return lines


def _prompt(message: str, context: dict, sketches: list, history: list) -> str:
    setup = _dict(context.get("setup"))
    material = setup.get("material")
    presets = [p for p in _list(context.get("presets"))
               if isinstance(p, dict) and (not material or p.get("material") == material)]
    shapes = describe_entities([s for s in sketches if isinstance(s, dict)])
    outlines = describe_outlines(sketches)

    tools = []
    for t in _list(context.get("tools")):
        if isinstance(t, dict):
            tools.append(f"- id={_js(t.get('id'))} T{t.get('number', '?')} {_js(t.get('name'))} "
                         f"{t.get('type')} diameter {t.get('diameter')} mm, {t.get('flutes')} flutes, "
                         f"flute length {t.get('fluteLength')} mm")
    plan = []
    for op in [o for o in _list(context.get("plan")) if isinstance(o, dict)]:
        line = (f"- operation {len(plan) + 1}: id={_js(op.get('id'))} {op.get('kind')} "
                f"shapes={_js(op.get('entityIds'))} cutSide={op.get('cutSide')} status={op.get('status')} "
                f"overrides={_js(op.get('overrides') or {})} resolved={_js(op.get('resolved') or {})}")
        if op.get("problem"):
            line += f" problem: {op['problem']}"
        plan.append(line)
    issues = []
    for i in _list(context.get("issues")):
        if isinstance(i, dict):
            on = f" (operation {i['opId']})" if i.get("opId") else ""
            issues.append(f"- {i.get('severity')}{on}: {i.get('message')}")

    turns = []
    for h in _list(history)[-MAX_HISTORY:]:
        if isinstance(h, dict):
            who = "USER" if h.get("role") == "user" else "YOU"
            turns.append(f"{who}: {h.get('text', '')}")

    focus = context.get("focus_op_id")
    parts = [
        "SHAPES (id, type, size; mm, Y down):\n" + ("\n".join(shapes) if shapes else "(no shapes)"),
        *(["OUTLINES MADE OF LINES:\n" + "\n".join(outlines)] if outlines else []),
        "SETUP: " + _js(setup),
        "MACHINE (read-only): " + _js(_dict(context.get("machine"))),
        "MATERIALS: " + _js(_list(context.get("materials")) or MATERIALS),
        "TOOL LIBRARY:\n" + ("\n".join(tools) if tools else "(no tools)"),
        f"PRESETS{' for ' + str(material) if material else ''} (the defaults):\n"
        + ("\n".join("- " + _js(p) for p in presets) if presets else "(none)"),
        "CURRENT PLAN (in cutting order):\n" + ("\n".join(plan) if plan else "(no operations yet)"),
        "OPEN ISSUES:\n" + ("\n".join(issues) if issues else "(none)"),
    ]
    if turns:
        parts.append("RECENT CONVERSATION:\n" + "\n".join(turns))
    if focus:
        parts.append(f"The user is asking about operation {_js(focus)}.")
    parts.append("USER: " + message)
    return "\n\n".join(parts)


def cam_chat(
    message: str,
    context: dict | None,
    document_data: dict | None,
    history: list[dict] | None = None,
    model: str | None = None,
    *,
    llm: Callable[[str, str, list[dict]], dict] | None = None,
) -> dict:
    """One turn of the CAM chat: {reply, notes, tokens…, cost_usd}.

    An empty `message` asks for a first plan. Raises AssistantError when the
    model can't be called (the spend so far on `usage`)."""
    message = (message or "").strip() or "Plan this job"
    context = _dict(context)
    sketches = _list(_dict(document_data).get("sketches"))
    model = model if model and is_known(model) else list_models()["default"]
    llm = llm or (lambda s, u, t: _anthropic_call(s, u, t, model=model))

    out = llm(SYSTEM, _prompt(message, context, sketches, history or []), [CAM_TOOL])
    u = out.get("usage") or {}
    tok = {k: u.get(k, 0) or 0 for k in ("input", "output", "cache_read", "cache_write")}
    spend = {
        "tokens_in": tok["input"] + tok["cache_read"] + tok["cache_write"],
        "tokens_out": tok["output"],
        "cache_read_tokens": tok["cache_read"], "cache_write_tokens": tok["cache_write"],
        "cost_usd": round(call_cost(model, tok), 4),
        "model": model,
    }
    if out.get("kind") == "cam":
        raw = {k: v for k, v in out.items() if k not in ("kind", "usage")}
    else:   # no tool call: what the model said is the answer
        raw = {"answer": out.get("question") or out.get("note") or ""}

    tool_ids = [str(t["id"]) for t in _list(context.get("tools"))
                if isinstance(t, dict) and t.get("id") is not None]
    op_ids = [str(o["id"]) for o in _list(context.get("plan"))
              if isinstance(o, dict) and o.get("id") is not None]
    materials = [m for m in _list(context.get("materials")) if isinstance(m, str)] or MATERIALS
    reply, notes = normalize_reply(raw, known_entity_ids(sketches), tool_ids, op_ids, materials,
                                   entity_labels(sketches))
    return {"reply": reply, "notes": notes, **spend}
