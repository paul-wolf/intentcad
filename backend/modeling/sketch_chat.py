"""The sketch chat: the AI in a sketch document's editor.

It sees what the part chat sees (the project brief, the other parts, the
project parameters, context files, read_part, @-mentions) plus the sketch:
for a generated sketch its code and last run (outputs, checks, error, the
parameters it read), for a drawn one its shapes; and for both, which parts
use it and which outputs they ask for.

In a generated sketch the AI rewrites the code (write_code), validated by a
trial run with one corrective retry; nothing is saved here (the editor saves
it as a revert point, asking first when outputs parts use would go). In a
drawn sketch it can't change the drawing: it answers, or proposes a
generated sketch (propose_generated) with code already run, which the user
accepts or declines. In both, as in the part chat, it may propose project
parameters (set_project_parameter) and a new brief (propose_brief_edit):
they come back with any kind of reply, for the user to accept or reject.
"""
from __future__ import annotations

from typing import Callable

from . import generated_sketch as gs
from . import project_context as pc
from . import shared_defs
from .assistant import (ANSWER_TOOL, ASK_TOOL, FINAL_TOOLS, MAX_LOOKUPS, AssistantError,
                        _anthropic_call)
from .llm_models import call_cost, is_known, list_models

CODE_API = (
    "THE CODE. A generated sketch is Python run with build123d star-imported (Rectangle, "
    "RectangleRounded, Circle, Polygon, RegularPolygon, Polyline, make_face, offset, Pos, Rot, "
    "Location, Vector, …; `import math` works). Units are mm, angles degrees, the sketch's plane "
    "is x right, y up. It reads project parameters as PP[\"name\"] (never redefine PP) and "
    "makes its results with:\n"
    "    output(name, geometry, description=None)  a named result parts use as "
    "SK[\"alias\"].group(name): closed shapes, holes, points or lines\n"
    "    check(name, ok, message=\"\", output=None)  a design rule shown green or red; "
    "output names the output it is about\n"
    "    label(text, at)                           a note on the drawing at (x, y)\n"
    "    dim(p1, p2, text=None)                    a dimension line on the drawing\n"
    "    holes(points, d)                          circles of diameter d at points\n"
    "Geometry is a build123d sketch, face, wire or edge, a point ((x, y)), or a list of them. "
    "Combine faces with +, - and &. Output names are letters, digits and _ (brace_holes), "
    "each made once."
)

GENERATED = (
    "You edit the code of a GENERATED SKETCH: a 2D layout drawn by code from the project's "
    "parameters, which parts of the project build from (a frame layout: plate outlines, hole "
    "patterns, openings). " + CODE_API + "\n\n"
    "Return the COMPLETE new code with write_code (never a fragment). Keep the existing "
    "structure and change what the instruction asks. Put the layout rules (margins, "
    "clearances, hole offsets) in named constants at the top with a short comment, and "
    "derive every size from them and from PP, never from copied numbers, so the layout "
    "follows when a parameter changes.\n\n"
    "Parts use the outputs by name (USED BY lists which part asks for which). Never rename "
    "or remove an output a part uses unless the user asks; if they do, say in the note "
    "which parts lose it. Without being asked, add a check() for each design rule the "
    "layout depends on (it fits the print bed, shapes don't collide, a hole keeps its edge "
    "distance, a board fits a space), with a message giving the measured value, and "
    "label() or dim() the sizes a reader needs. Do it in the same write_code.\n\n"
    "If LAST RUN shows an error, the code doesn't run: fix the cause, keeping the design "
    "intent. To add or change a PROJECT PARAMETER (one several parts share), use "
    "set_project_parameter; the code can read it right away. A rule only this layout uses "
    "stays a constant in the code. A layout often needs new parameters: propose them with "
    "the code that reads them, in the same reply.\n\n"
    "Answer questions (what the layout does, why a check fails) with answer, using LAST RUN "
    "and the code; ask_clarification only when you can't go on without the user."
)

DRAWN = (
    "You are the AI in a DRAWN SKETCH: shapes the user drew by hand, which parts of the "
    "project may build from. You can't change drawn shapes: say so plainly when asked to "
    "move, add or resize them, and say the user draws them with the tools. That limit is "
    "only the drawing: project parameters and the brief you can propose as in any chat "
    "(set_project_parameter, propose_brief_edit; see THE PROJECT). A dimension of this "
    "sketch uses a project parameter when the user types its name in it, so say that "
    "when you propose one for it. You can answer questions about "
    "the sketch and the project (with answer), and you can offer a GENERATED SKETCH: a "
    "layout drawn by code from the project's parameters, which follows when a parameter "
    "changes. When the user asks for a layout that depends on project parameters or "
    "follows rules (a frame, a hole pattern, a plate that fits other parts), or asks you "
    "to draw something, call propose_generated: one plain sentence the user agrees to, a "
    "name, and its complete code. If the sketch is EMPTY, it becomes this generated "
    "sketch; otherwise the generated sketch is a new document next to it. " + CODE_API + "\n\n"
    "Put the layout rules in named constants at the top with a short comment, derive "
    "every size from them and PP, give each result parts will use its own output with a "
    "description, and add a check() for each design rule (bed fit, collisions, edge "
    "distances) and label()/dim() for the key sizes."
)

PROJECT = (
    "\n\nTHE PROJECT. A PROJECT BRIEF (if shown) gives the project's goals, materials and "
    "conventions: follow it. PROJECT PARTS lists the other parts and sketches; call "
    "read_part to look at one before you answer or write anything that depends on it. "
    "MENTIONED PARTS are those the user pointed at with @. PROJECT PARAMETERS are the "
    "values PP[\"name\"] reads. Other documents are read-only.\n\n"
    "PROJECT TOOLS (in this chat as in every other): set_project_parameter proposes a new "
    "or changed project parameter; for several (a list the user pasted, say) call it once "
    "for each, all in the same reply, and they show as one card. If the user settles "
    "something the whole project should remember (a material, a bolt size, a bought part, "
    "a convention), offer it with propose_brief_edit. The user accepts or rejects both; "
    "nothing changes until they do. Then finish with your reply as usual."
)

FILES = (
    "\n\nCONTEXT FILES (datasheets, drawings, photos) may be attached before the request. "
    "A number you take from one gets a comment on its line saying where it came from "
    "(file and page, stated or estimated ±x); ask rather than guess a critical size."
)

WRITE_CODE_TOOL = {
    "name": "write_code",
    "description": "Return the complete new code of this generated sketch.",
    "input_schema": {
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "the complete code; it makes its results with output()"},
            "note": {"type": "string", "description": "one or two short sentences: what changed, "
                     "and any check that now fails"},
        },
        "required": ["code", "note"],
        "additionalProperties": False,
    },
}

PROPOSE_TOOL = {
    "name": "propose_generated",
    "description": "Offer a generated sketch (a layout drawn by code from the project's parameters). "
                   "The user sees the sentence and a preview and accepts or declines.",
    "input_schema": {
        "type": "object",
        "properties": {
            "sentence": {"type": "string", "description": "one plain sentence saying what it will draw "
                         "and from which parameters, e.g. \"I'll make this a generated sketch: the plate "
                         "outline, brace holes and wall holes from prop_d, brace_r_in and arm_od.\""},
            "name": {"type": "string", "description": "a short name for the sketch, e.g. \"Frame layout\""},
            "code": {"type": "string", "description": "its complete code"},
        },
        "required": ["sentence", "name", "code"],
        "additionalProperties": False,
    },
}

FINAL_TOOLS.update({"write_code": "edit", "propose_generated": "proposal"})


def _fmt(v) -> str:
    return f"{v:g}" if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v)


def run_text(gen: dict | None) -> str:
    """A generated sketch's last run: its outputs, checks, error and the parameters it read."""
    gen = gen or {}
    lines = []
    err = gen.get("error")
    if err:
        at = f" at line {err['line']}" if err.get("line") else ""
        lines.append(f"ERROR{at}: {err.get('message', '')} (the drawing below is the last run that worked)")
    outs = gen.get("outputs") or []
    lines.append("outputs: " + ("; ".join(
        f"{o['name']} ({o.get('size', '')}{', ' + o['description'] if o.get('description') else ''})"
        for o in outs) if outs else "none"))
    checks = gen.get("checks") or []
    for c in checks:
        msg = f": {c['message']}" if c.get("message") else ""
        lines.append(f"check {'PASSES' if c.get('ok') else 'FAILS'} {c['name']}{msg}")
    reads = gen.get("reads") or {}
    lines.append("read parameters: " + (", ".join(f"{k}={_fmt(v)}" for k, v in reads.items()) or "none"))
    return "\n".join(lines)


def used_by_text(doc) -> str:
    """Which parts use the sketch, and which of its outputs each asks for."""
    lines = []
    for p in shared_defs.used_by(doc):
        asks = sorted({n for u in p["uses"] for n in [*u["groups"], *u["names"]]})
        aliases = sorted({u["alias"] for u in p["uses"]})
        what = f"outputs {', '.join(asks)}" if asks else "the whole sketch"
        state = " (pinned to an older version)" if p.get("pinned") else (" (out of date)" if p.get("stale") else "")
        lines.append(f'- "{p["name"]}" as SK[{", ".join(repr(a) for a in aliases)}]: {what}{state}')
    return "\n".join(lines) or "no part uses it yet"


def sketch_block(doc) -> str:
    """The sketch itself, for the prompt."""
    used = f"USED BY:\n{used_by_text(doc)}"
    if gs.is_generated(doc):
        data = shared_defs._data(doc)
        s = gs.the_sketch(doc) or {}
        return (f'THIS SKETCH: "{doc.name}", generated.\nCURRENT CODE:\n```python\n{data.get("code") or ""}\n```\n\n'
                f"LAST RUN:\n{run_text(s.get('generated'))}\n\n{used}")
    empty = gs.is_empty_drawn(doc)
    shapes = "" if empty else f"\nSHAPES (mm, sketch y points down):\n{pc.sketch_summary(doc)}"
    prof = [pc._profile_text(s["profile"]) for s in shared_defs._data(doc).get("sketches") or []
            if isinstance(s, dict) and isinstance(s.get("profile"), dict)]
    shared = f"\nAS PARTS SEE IT: {'; '.join(prof)}" if prof else ""
    return f'THIS SKETCH: "{doc.name}", drawn{", EMPTY" if empty else ""}.{shapes}{shared}\n\n{used}'


def sketch_chat(doc, instruction: str, history: list[dict] | None = None, model: str | None = None,
                files: list[dict] | None = None, file_listing: list[str] | None = None,
                mentions: list[str] | None = None, *, llm: Callable[..., dict] | None = None) -> dict:
    """One turn of a sketch document's chat. Returns, with the cost keys:
    {kind: "edit", code, note, result, broken} (a generated sketch's new
    code, run but not saved), {kind: "proposal", sentence, name, code, result,
    empty} (a drawn sketch: a generated one offered), {kind: "answer", answer}
    or {kind: "question", question}; any of them with parameter_proposals
    and brief_proposal when the AI proposed those."""
    instruction = (instruction or "").strip()
    if not instruction:
        raise AssistantError("empty instruction")
    model = model if model and is_known(model) else list_models()["default"]
    llm = llm or (lambda s, u, t, turns=None: _anthropic_call(s, u, t, model=model, **({"turns": turns} if turns else {})))
    generated = gs.is_generated(doc)
    doc_id = str(doc.id)
    in_project = bool(doc.project_id)
    project = pc.project_context(doc_id) if in_project else ""
    mentioned = pc.mention_context(doc_id, mentions) if mentions and in_project else ""
    final = WRITE_CODE_TOOL if generated else PROPOSE_TOOL
    tools = [final, ASK_TOOL, ANSWER_TOOL] + ([pc.READ_PART_TOOL, pc.SET_PROJECT_PARAMETER_TOOL,
                                               pc.PROPOSE_BRIEF_TOOL] if in_project else [])
    system = (GENERATED if generated else DRAWN) + (PROJECT if in_project else "") + FILES
    block = sketch_block(doc)
    param_props: dict = {}    # set_project_parameter: name -> {name, value, unit, description, reason}
    brief: dict = {}          # propose_brief_edit: {text, reason}

    def prompt(extra: str = "") -> str:
        proj = f"{project}\n\n" if project else ""
        attached = ("CONTEXT FILES (attached above, in this order):\n" + "\n".join(file_listing) + "\n\n"
                    if files and file_listing else "")
        convo = ""
        if history:
            convo = "RECENT CONVERSATION:\n" + "\n".join(
                f"{'USER' if h.get('role') == 'user' else 'ASSISTANT'}: {h.get('text', '')}"
                for h in history[-8:]) + "\n\n"
        ment = f"MENTIONED PARTS (the user pointed at these with @):\n{mentioned}\n\n" if mentioned else ""
        return f"{proj}{attached}{block}\n\n{convo}{ment}INSTRUCTION: {instruction}\n{extra}"

    tok = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    usd = [0.0]

    def cost() -> dict:
        return {"tokens_in": tok["input"] + tok["cache_read"] + tok["cache_write"],
                "tokens_out": tok["output"], "cache_read_tokens": tok["cache_read"],
                "cache_write_tokens": tok["cache_write"], "cost_usd": round(usd[0], 4), "model": model}

    def tool_result(c: dict, lookups: int) -> dict:
        args = c.get("input") or {}
        if c["name"] == "read_part" and in_project:
            text = ("That's enough looking: finish now with what you have." if lookups > MAX_LOOKUPS
                    else pc.read_part(doc_id, str(args.get("part", "")), str(args.get("what", "summary"))))
        elif c["name"] == "set_project_parameter" and in_project:
            p, why = pc.check_parameter(args)
            if p:
                param_props[p["name"]] = {**p, "reason": str(args.get("reason", ""))}
                use = ("the code can read it now (it runs with the proposed value)" if generated else
                       "once accepted, a dimension of this sketch uses it when its name is typed in it")
                text = (f'Shown to the user as a proposed project parameter PP["{p["name"]}"] (with any others '
                        f"you propose, on one card); {use}. Now finish your reply.")
            else:
                text = why
        elif c["name"] == "propose_brief_edit" and in_project:
            brief.update(text=str(args.get("new_text", "")), reason=str(args.get("reason", "")))
            text = "Shown to the user as a proposed brief; they'll accept or reject it. Now finish your reply."
        else:
            text = f"There is no tool called {c['name']}."
        return {"type": "tool_result", "tool_use_id": c["id"], "content": text}

    def call(extra: str = "") -> dict:
        text = prompt(extra)
        user = [*files, {"type": "text", "text": text}] if files else text
        turns: list[dict] = []
        lookups = 0
        while True:
            try:
                o = llm(system, user, tools, turns) if turns else llm(system, user, tools)
            except AssistantError as exc:
                if usd[0]:
                    exc.usage = cost()
                raise
            u = o.get("usage") or {}
            for k in tok:
                tok[k] += u.get(k, 0)
            usd[0] += call_cost(model, u)
            for c in o.get("side") or []:
                tool_result(c, lookups)
            if o.get("kind") == "question" and "?" not in o.get("question", ""):
                return {**o, "kind": "answer", "text": o.get("question", "")}
            if o.get("kind") != "tool":
                return o
            lookups += sum(1 for c in o["calls"] if c["name"] == "read_part")
            if lookups > MAX_LOOKUPS + 2:
                raise AssistantError("the model kept looking at other parts without replying — "
                                     "try a more specific request", usage=cost())
            turns += [{"role": "assistant", "content": o["content"]},
                      {"role": "user", "content": [tool_result(c, lookups) for c in o["calls"]]}]

    def done(r: dict) -> dict:
        """Any reply, with the project proposals made on the way."""
        if param_props:
            r["parameter_proposals"] = list(param_props.values())
        if brief.get("text"):
            r["brief_proposal"] = dict(brief)
        return r

    def reply(o: dict) -> dict | None:
        if o.get("kind") == "question":
            return done({"kind": "question", "question": o.get("question", ""), **cost()})
        if o.get("kind") == "answer":
            return done({"kind": "answer", "answer": o.get("text", ""), **cost()})
        if o.get("kind") not in ("edit", "proposal"):
            raise AssistantError("the model didn't reply with code", usage=cost())
        return None

    def trial(o: dict) -> dict:
        overrides = {n: p["value"] for n, p in param_props.items()}
        return gs.run(doc, overrides, o.get("code") or "")

    out = call()
    early = reply(out)
    if early:
        return early
    r = trial(out)
    if not r.get("ok"):
        line = f" (line {r['line']})" if r.get("line") else ""
        out = call(f"\nYour code failed to run{line}: {r.get('error')}\n"
                   "Fix the cause and return the complete corrected code. Its note or sentence is what "
                   "the user reads: describe the layout as a whole, not only this fix.")
        early = reply(out)
        if early:
            return early
        r = trial(out)
        if not r.get("ok"):
            raise AssistantError(f"couldn't write code that runs: {r.get('error')}", usage=cost())
    if generated:
        return done({"kind": "edit", "code": out["code"], "note": out.get("note", ""), "result": r,
                     "broken": gs.broken_outputs(doc, r), **cost()})
    return done({"kind": "proposal", "sentence": out.get("sentence", ""), "name": (out.get("name") or "").strip(),
                 "code": out["code"], "result": r, "empty": gs.is_empty_drawn(doc), **cost()})
