"""The AI loop: turn an instruction into an edit of the build123d script.

The model is a build123d script; the assistant rewrites it from natural language
(with the user's current selection as the target), then we validate it by running
it — one corrective retry on a build error. build123d does the CAD; the AI just
authors the script. The Anthropic call is injected so the prompt/validation logic
is testable with a fake llm.
"""

from __future__ import annotations

import os
from collections import defaultdict
from typing import Callable

from .engine import EngineError, asset_refs, load_assets, run_script
from .paramedit import ParamError, set_params
from .llm_models import is_known, list_models, price_for

# Per-attempt cap on an Anthropic call, and how many times the SDK retries it.
# The SDK's own default is more patient than gunicorn's --timeout, so without
# these a slow call gets the *worker* killed mid-stream instead of returning an
# error the UI can show. Worst case per call is TIMEOUT * (1 + RETRIES), and an
# edit makes up to two calls — keep that under the gunicorn timeout budget.
LLM_TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "240"))
LLM_RETRIES = int(os.environ.get("LLM_RETRIES", "1"))

# Selectable models and their pricing live in llm_models.py — discovered from
# the Models API so a new release shows up without a code change. The default
# is the newest Opus (capable + fast); stronger tiers are opt-in per request.


class AssistantError(RuntimeError):
    """The edit failed (no key, model error, or couldn't produce a building script)."""


def _fmt(v: float) -> str:
    v = round(v, 2)
    return f"{v:g}" if v != 0 else "0"   # no "-0"


def _vec(v) -> str:
    return "(" + ", ".join(_fmt(c) for c in v) + ")"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


_AXES = {(1.0, 0.0, 0.0): "+X", (-1.0, 0.0, 0.0): "-X", (0.0, 1.0, 0.0): "+Y",
         (0.0, -1.0, 0.0): "-Y", (0.0, 0.0, 1.0): "+Z", (0.0, 0.0, -1.0): "-Z"}


def geometry_summary(faces: list[dict], metrics: dict | None = None, max_lines: int = 60) -> str:
    """A compact text description of a build's face inventory (the runner's
    `faces`): bbox and face count, planar faces grouped by normal with their
    offsets along it, and cylinders with radius/axis/center. For the model to
    write selectors against geometry it can't read from the script (an imported
    STEP). Capped at about `max_lines`; the biggest features come first."""
    lines = []
    if metrics and metrics.get("bbox_min") and metrics.get("bbox_max"):
        lo, hi = metrics["bbox_min"], metrics["bbox_max"]
        lines.append(f"bbox: min {_vec(lo)} max {_vec(hi)}  "
                     f"size {_vec([hi[i] - lo[i] for i in range(3)])}")
    kinds: dict[str, int] = defaultdict(int)
    for f in faces:
        kinds[f.get("kind", "?")] += 1
    lines.append(f"{len(faces)} faces: " + ", ".join(f"{n} {k}" for k, n in sorted(kinds.items(), key=lambda kv: -kv[1])))

    # planes: by normal, then by offset along it (d = center . normal)
    planes: dict[tuple, dict[float, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for f in faces:
        if f.get("kind") != "plane":
            continue
        n = tuple(round(c, 3) + 0.0 for c in f["normal"])
        d = round(sum(f["center"][i] * f["normal"][i] for i in range(3)), 2)
        planes[n][d].append(f)
    body = []
    if planes:
        body.append("PLANAR faces by outward normal; each at a position along it "
                    "(x/y/z = that coordinate, d = signed offset along a slanted normal):")
        groups = sorted(planes.items(), key=lambda kv: -sum(f["area"] for fs in kv[1].values() for f in fs))
        for n, by_d in groups:
            fs = [f for v in by_d.values() for f in v]
            name = _AXES.get(n)
            body.append(f"  normal {name or _vec(n)}: {_plural(len(fs), 'face')}, "
                        f"area {_fmt(sum(f['area'] for f in fs))}")
            sign = -1 if name and name[0] == "-" else 1
            for d, at in sorted(by_d.items(), key=lambda kv: -sign * kv[0]):   # highest first
                # along an axis, report the coordinate itself (what filter_by_position takes)
                where = f"{name[1].lower()}={_fmt(sign * d)}" if name else f"d={_fmt(d)}"
                idx = ",".join(str(f["index"]) for f in at[:6]) + ("…" if len(at) > 6 else "")
                body.append(f"    {where}: {_plural(len(at), 'face')}, "
                            f"area {_fmt(sum(f['area'] for f in at))} [#{idx}]")
    cyls = [f for f in faces if f.get("kind") == "cylinder" and f.get("radius")]
    if cyls:
        body.append("CYLINDRICAL faces (holes/bosses/rounds):")
        for f in sorted(cyls, key=lambda f: (-f["radius"], -f["area"])):
            axis = f.get("axis")
            center = f.get("axis_point") or f["center"]
            # a hole's surface normal points at its axis; a boss's points away
            to_axis = [center[i] - f["center"][i] for i in range(3)]
            hole = sum(to_axis[i] * f["normal"][i] for i in range(3)) > 0
            size = f.get("size") or [0.0, 0.0, 0.0]
            length = sum(size[i] * abs(axis[i]) for i in range(3)) if axis else max(size)
            body.append(f"  r={_fmt(f['radius'])} (dia {_fmt(2 * f['radius'])}) "
                        f"axis {_vec(axis) if axis else '?'} center {_vec(center)} "
                        f"{'hole' if hole else 'boss/round'}, ~{_fmt(length)} long [#{f['index']}]")
    room = max_lines - len(lines)
    if len(body) > room:
        body = body[:room - 1] + [f"  … {len(body) - room + 1} more lines omitted"]
    return "\n".join(lines + body)


def _system(production: str = "") -> str:
    base = (
        "You edit a build123d (Python) script that defines a 3D part. The script "
        "MUST bind `part` to the built solid. build123d is already star-imported "
        "(Box, Cylinder, Sphere, Pos, Rot, Plane, Axis, GeomType, fillet, chamfer, "
        "extrude, …) — do NOT add imports. Units are millimeters, Z is up.\n\n"
        "Return the COMPLETE updated script via write_script (never a diff or a "
        "fragment). Preserve the existing structure and any `params`/`P` dict; "
        "change only what the instruction asks.\n\n"
        "Keep the model tweakable: put the key dimensions of any feature you add "
        "or change (sizes, depths, radii, counts, angles) into the `params`/`P` "
        "dict and reference them by name — don't bury dimensions as inline "
        "literals — so they can be adjusted later without rewriting the script.\n\n"
        "Target geometry with build123d selectors — e.g. part.faces(), "
        "part.edges(), .filter_by(GeomType.CIRCLE), .filter_by_position(Axis.Z, "
        "lo, hi), .group_by(Axis.Z), .sort_by(Axis.Z), Plane(a_face). To sketch "
        "on a face, build on Plane(face). For rounds/bevels select the edges then "
        "fillet(edges, radius=r) or chamfer(edges, length=d).\n\n"
        "If a SELECTION is given, it names the exact geometry the user means — "
        "write a selector that resolves to it (use the given positions/kinds).\n\n"
        "If a BUILD ERROR is given, the CURRENT SCRIPT does not build: the error "
        "names the failing line and, where known, the cause. Fix the cause while "
        "preserving the design intent — e.g. a fillet/chamfer that is too large "
        "for its geometry should be reduced to the largest value that fits (or "
        "applied to fewer edges), not deleted. Keep the size as a named param. "
        "If the user's instruction is about something else, do both: fix the "
        "build AND make the requested change.\n\n"
        "ASSEMBLIES / MECHANISMS: to keep several bodies as distinct parts (an "
        "assembly), position each and combine them with Compound([a, b, …]) — NOT "
        "a boolean +, which fuses them into one solid. `part` may be a Compound. "
        "For a mechanism (hinge, slider, fold), the cleanest parametric approach "
        "is to drive the articulation with a param and apply it as a transform "
        "about the joint axis — e.g. a hinge is Rot(0, fold_angle, 0) * moving_body "
        "about the hinge axis, with fold_angle in the params. build123d also has a "
        "formal joint system (RigidJoint, RevoluteJoint, LinearJoint, "
        "CylindricalJoint, BallJoint) with .connect_to(); use it if the user asks, "
        "but the param-driven transform is usually simpler and stays tweakable.\n\n"
        "IMPORTED GEOMETRY: a line like part = import_step(ASSETS[\"<sha256>\"]) "
        "loads a file the user uploaded. Never invent, change or remove an "
        "ASSETS[...] reference — keep each exactly as written. The imported body "
        "has no params; put the dimensions of any feature you add to it in P as "
        "usual. To target imported geometry, write selectors from the GEOMETRY "
        "SUMMARY (face normals, plane offsets, cylinder axes/radii) — e.g. "
        "part.faces().filter_by(Axis.Z).sort_by(Axis.Z)[-1] for the top face.\n\n"
        "ROUNDING THE WHOLE PART: auto_round(part, convex=…, concave=…, keep=[…]) "
        "is available (no import) and rounds every eligible edge — convex edges "
        "to `convex`, concave edges to `concave` — capping each radius to the "
        "local wall thickness and skipping edges it can't round. It leaves the "
        "print bed face and small hole walls sharp by default, plus any face in "
        "`keep` (faces or selectors, e.g. keep=[part.faces().sort_by(Axis.Z)[-1]]). "
        "Rules: call it LAST, as the final `part = auto_round(part, …)` line, after "
        "every other feature; put its radii in P (e.g. P[\"round_r\"] for convex, "
        "P[\"blend_r\"] for concave) and pass them by name; put every FUNCTIONAL "
        "surface in keep — mounting, mating, clamping, bearing and sealing faces "
        "must stay flat and sharp-edged. When the user asks to soften or round "
        "the part (as a whole, not specific edges), use auto_round, not "
        "hand-picked fillet() calls. To protect more faces, add selectors to its "
        "keep list and change nothing else.\n\n"
        "ORGANIC SHAPES (no import, exact B-rep): "
        "spoke(a, b, w0, w1, t0, t1=None, bow=0, bow_dir=None, section=\"ellipse\"|\"rounded_rect\", "
        "flat_bottom_z=None) — a tapered member a→b (3D points), width w0→w1, thickness "
        "t0→t1, midpoint bowed `bow` mm sideways; "
        "frame(nodes={name: (x, y, z, r)}, members=[(a, b, w0, w1, t, bow), …], flat_bottom_z=None, "
        "blend=None) — hubs of radius r at the nodes joined by spokes, one solid (with "
        "flat_bottom_z it's laid out in plan on that plane: tapered bowed members t high, "
        "hub cylinders, every joint blended to `blend`; give the members one t so "
        "auto_round can round it all; failed members are reported, not fatal); "
        "window(part, face, outline=[(u, v), …], corner_r, depth=None) — a rounded pocket "
        "or through-cut; "
        "truss_windows(part, face, rim, rib, anchors=[(u, v), …], corner_r, keep_clear=3.0, "
        "pattern=\"fan\"|\"triangulate\") — lightens a flat plate with windows between "
        "ribs radiating from the anchors, keeping `rim` round the edge and holes and "
        "keep_clear from protected faces and bosses. 2D (u, v) are world coordinates on "
        "the face's plane: (X, Y) on a ±Z face, (X, Z) on ±Y, (Y, Z) on ±X. They all warn "
        "when something is thinner than P[\"min_wall\"] (default 2 mm). "
        "When the user asks to make a part organic, sculpted, lighter or aerodynamic: "
        "identify its mount and load points (holes, bosses, mating faces) and keep them "
        "as protected nodes; connect them with frame() members, or lighten its plates "
        "with truss_windows() anchored at the mounts. Lightening should show: aim to "
        "remove 30-40% of the mass unless told otherwise. For truss_windows, rim about "
        "2.5 × P[\"min_wall\"] and rib about 2 × P[\"min_wall\"] gets there on a typical "
        "plate; wider ribs remove much less. Members taper from the mounts "
        "outward (w0 > w1) and bow gently (a few mm). Then auto_round() LAST with a "
        "generous blend_r. Put every width, taper, bow, rim, rib and corner_r in P with "
        "a descriptive name (e.g. P[\"spoke_root_w\"], P[\"spoke_tip_w\"], "
        "P[\"spoke_bow\"], P[\"truss_rib\"]) so they can be dragged. For a part "
        "printed flat, pass flat_bottom_z = the bed plane (usually 0). Never cut into or "
        "cover a protected face.\n\n"
        "RECENT CONVERSATION (if shown) is prior turns with the user; use it to "
        "resolve references like 'that hole' or 'make it bigger'. When the "
        "instruction is genuinely ambiguous or you lack information you need "
        "(which face? what dimension? which of several holes?), call "
        "ask_clarification with ONE short question instead of guessing — a wrong "
        "guess is worse than a question. Otherwise, make the edit."
    )
    if production.strip():
        base += (
            "\n\nMANUFACTURING CONTEXT — the user's target production process for "
            "this part. Honour it in EVERY edit: design in the clearances, fits, "
            "wall thicknesses and feature limits it implies, and expose fit "
            "clearances as named params in P so they stay tunable. The process is:\n"
            + production.strip()
        )
    return base


WRITE_TOOL = {
    "name": "write_script",
    "description": "Return the full updated build123d script that satisfies the instruction.",
    "input_schema": {
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "the complete build123d script; must bind `part`"},
            "note": {"type": "string", "description": "one short sentence describing the change"},
        },
        "required": ["code", "note"],
        "additionalProperties": False,
    },
}

ASK_TOOL = {
    "name": "ask_clarification",
    "description": "Ask the user ONE short clarifying question instead of editing, when the "
                   "instruction is ambiguous or you need information (which face, what size, "
                   "which of several holes). Prefer this over guessing.",
    "input_schema": {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "one clear, specific question for the user"},
        },
        "required": ["question"],
        "additionalProperties": False,
    },
}


def _anthropic_call(system: str, user: str, tools: list[dict], model: str) -> dict:
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover
        raise AssistantError("the anthropic SDK is not installed") from exc
    key = os.environ.get("ANTHROPIC_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not (key or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise AssistantError("ANTHROPIC_KEY is not set")
    opts = {"timeout": LLM_TIMEOUT, "max_retries": LLM_RETRIES}
    client = anthropic.Anthropic(api_key=key, **opts) if key else anthropic.Anthropic(**opts)
    try:
        # Stream: adaptive thinking + a full script can run long; streaming keeps
        # data flowing so we don't block on one long read (and get_final_message
        # reassembles the complete response).
        with client.messages.stream(
            # 32k output: adaptive thinking on a hard task can otherwise use up a
            # small budget before it emits the script, leaving no tool call.
            model=model, max_tokens=32000,
            thinking={"type": "adaptive"},
            system=system, tools=tools,
            messages=[{"role": "user", "content": user}],
        ) as stream:
            resp = stream.get_final_message()
    except anthropic.APITimeoutError as exc:
        raise AssistantError(
            "the model took too long to respond — try a smaller, more specific edit"
        ) from exc
    except anthropic.APIError as exc:
        raise AssistantError(f"Anthropic API error: {exc}") from exc
    usage = {"input": resp.usage.input_tokens, "output": resp.usage.output_tokens}
    text = ""
    for block in resp.content:
        if block.type == "tool_use" and block.name == "write_script":
            out = dict(block.input); out["kind"] = "edit"; out["usage"] = usage
            return out
        if block.type == "tool_use" and block.name == "ask_clarification":
            out = dict(block.input); out["kind"] = "question"; out["usage"] = usage
            return out
        if block.type == "text":
            text += block.text
    # No tool call — don't hard-fail. Surface what the model actually said (an
    # explanation or an in-prose question), or a helpful note if it ran out of room.
    if resp.stop_reason == "refusal":
        return {"kind": "question", "question": "The model declined this request.", "usage": usage}
    if resp.stop_reason == "max_tokens":
        msg = ("That was too much to do in one step — I ran out of output room. "
               "Try breaking it into smaller changes.")
        return {"kind": "question", "question": text.strip() or msg, "usage": usage}
    if text.strip():
        return {"kind": "question", "question": text.strip(), "usage": usage}
    raise AssistantError("the model did not return a script")


def edit_script(
    code: str,
    instruction: str,
    context: str = "",
    history: list[dict] | None = None,
    model: str | None = None,
    production: str = "",
    build_error: str = "",
    document_id: str | None = None,
    *,
    llm: Callable[[str, str, list[dict]], dict] | None = None,
) -> dict:
    """Turn `instruction` into either an edit of `code` or a clarifying question.

    `history` is recent conversation turns ([{role, text}, …]) so references
    across turns resolve. `model` picks which LLM (defaults to the newest Opus;
    only models the Models API currently offers are honoured). `build_error` is
    the error the current `code` fails with, if any — the model is asked to
    repair it as part of the edit. `document_id` resolves the uploaded files
    the script imports (ASSETS[...]); for such a script the prompt also gets a
    GEOMETRY SUMMARY of the current build. Returns {kind: "edit", code, note, tokens…} for an edit
    (validated to build, one corrective retry) or {kind: "question", question,
    tokens…} when the model asks for clarification."""
    instruction = (instruction or "").strip()
    if not instruction:
        raise AssistantError("empty instruction")
    model = model if model and is_known(model) else list_models()["default"]
    llm = llm or (lambda s, u, t: _anthropic_call(s, u, t, model=model))

    # an imported file's geometry isn't readable from the script: describe it
    assets = load_assets(code, document_id) if asset_refs(code) else {}
    summary = ""
    if assets:
        try:
            cur = run_script(code, assets=assets)
            summary = geometry_summary(cur.get("faces", []), cur.get("metrics"))
        except EngineError:
            pass    # the current script doesn't build: no inventory to describe

    def prompt(extra: str = "") -> str:
        sel = f"SELECTION: {context}\n\n" if context.strip() else ""
        berr = (f"BUILD ERROR (the current script fails with this):\n{build_error.strip()}\n\n"
                if build_error.strip() else "")
        convo = ""
        if history:
            turns = []
            for h in history[-8:]:
                who = "USER" if h.get("role") == "user" else "ASSISTANT"
                turns.append(f"{who}: {h.get('text', '')}")
            convo = "RECENT CONVERSATION:\n" + "\n".join(turns) + "\n\n"
        geom = (f"GEOMETRY SUMMARY (of the current build):\n{summary}\n\n"
                if summary else "")
        return (
            f"CURRENT SCRIPT:\n```python\n{code}\n```\n\n"
            f"{geom}{convo}{berr}{sel}INSTRUCTION: {instruction}\n{extra}"
        )

    tok_in = tok_out = 0

    def call(extra: str = "") -> dict:
        nonlocal tok_in, tok_out
        o = llm(_system(production), prompt(extra), [WRITE_TOOL, ASK_TOOL])
        u = o.get("usage") or {}
        tok_in += u.get("input", 0)
        tok_out += u.get("output", 0)
        return o

    def cost() -> dict:
        pin, pout = price_for(model)
        return {
            "tokens_in": tok_in, "tokens_out": tok_out,
            "cost_usd": round(tok_in * pin + tok_out * pout, 4),
        }

    def validate(script: str) -> None:
        # an uploaded file must survive the edit (an invented one fails to resolve)
        dropped = sorted(asset_refs(code) - asset_refs(script))
        if dropped:
            raise EngineError(f'the script no longer imports ASSETS["{dropped[0]}"]; '
                              "keep every ASSETS[...] line exactly as it was")
        r = run_script(script, document_id=document_id)  # raises EngineError if nothing builds
        if r.get("warning"):    # an operation failed partway — treat as a build error
            raise EngineError(r["warning"], fix=r.get("fix"))

    def apply_fix(script: str, exc: EngineError) -> str | None:
        """The engine measured the size that fits and it lives in a param: set it
        and re-validate. Deterministic and ~instant — spares a second model call
        (the slow part) for the commonest failure."""
        fix = exc.fix or {}
        if not fix.get("param") or fix.get("value") is None:
            return None
        try:
            fixed = set_params(script, {fix["param"]: fix["value"]})
            validate(fixed)
        except (ParamError, EngineError):
            return None
        return fixed

    out = call()
    if out.get("kind") == "question":
        return {"kind": "question", "question": out.get("question", ""), **cost()}

    new_code = out.get("code", "")
    try:
        validate(new_code)
    except EngineError as exc:
        fixed = apply_fix(new_code, exc)
        if fixed is not None:
            fix = exc.fix or {}
            note = (out.get("note", "") +
                    f" ({fix['param']} reduced to {fix['value']:g}, the largest "
                    f"{fix.get('kind', 'size')} that fits this geometry)").strip()
            return {"kind": "edit", "code": fixed, "note": note, **cost()}
        out = call(
            f"\nYour previous script failed to build. The failing line and error "
            f"(with the likely cause, where known):\n{exc}\n"
            "Fix that cause — don't just remove the feature. If the error states "
            "the largest size that fits (fillet radius, chamfer length), use that "
            "value or less; otherwise compute a size that fits from the neighbouring "
            "dimensions. Return a corrected complete script.")
        if out.get("kind") == "question":
            return {"kind": "question", "question": out.get("question", ""), **cost()}
        new_code = out.get("code", "")
        try:
            validate(new_code)
        except EngineError as exc2:
            fixed = apply_fix(new_code, exc2)
            if fixed is None:
                raise AssistantError(f"couldn't produce a script that builds: {exc2}") from exc2
            new_code = fixed

    return {"kind": "edit", "code": new_code, "note": out.get("note", ""), **cost()}
