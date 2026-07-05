"""The chat agent: an instruction -> operations to append to the feature tree.

This is the rung above the reference resolver (modeling/resolver.py). Where the
resolver answers "which geometry does this phrase mean", the agent answers "what
should I do" — it reads the current model (feature tree + built inventory +
available sketches) and a natural-language instruction ("chamfer the joint 3mm",
"cut off everything above z=10", "counterbore the ring for M4 bolts") and emits
one or more feature-tree operations, using the selector vocabulary to target
real geometry.

The operations are the deterministic contract: the agent proposes features in
the same shape the manual UI produces, the frontend appends them to the tree and
rebuilds. Nothing here touches the CAD kernel — it turns intent into the IR the
builder already understands.

The LLM call is injected (shared claude_tool_call), so the prompt assembly and
the operation normalization are pure and unit-tested with a fake llm.
"""

from __future__ import annotations

import uuid
from typing import Callable

from .resolver import (
    ResolverError,
    SELECTOR_REFERENCE,
    build_inventory_summary,
    claude_tool_call,
)

# revolve is intentionally excluded: its axis is derived from sketch geometry the
# agent can't see here, so it stays a manual (UI) operation for now.
OP_TYPES = ["extrude", "fillet", "chamfer", "counterbore", "trim"]


def _new_id() -> str:
    return "op-" + uuid.uuid4().hex[:8]


# ── context the agent reads ───────────────────────────────────────────────────

def _tree_summary(features: list[dict]) -> str:
    if not features:
        return "(empty — nothing built yet)"
    lines = []
    for i, f in enumerate(features, 1):
        t = f.get("type")
        if t == "extrude":
            bits = f"d={f.get('distance')}" + (" cut" if f.get("operation") == "remove" else "")
        elif t == "revolve":
            bits = f"{f.get('angle')}°"
        elif t == "fillet":
            bits = f"{f.get('edges')} r={f.get('radius')}"
        elif t == "chamfer":
            bits = f"{f.get('edges')} d={f.get('distance')}"
        elif t == "counterbore":
            bits = f"Ø{f.get('cboreDia')}×{f.get('cboreDepth')}"
        elif t == "trim":
            bits = f.get("trimFace") or f"{f.get('trimAxis')} {f.get('keep')} {f.get('at')}"
        else:
            bits = ""
        lines.append(f"  {i}. {t} {bits}".rstrip())
    return "\n".join(lines)


def _sketch_summary(sketches: list[dict]) -> str:
    if not sketches:
        return "(none)"
    return "\n".join(
        f"  \"{s.get('name')}\" ({s.get('entityCount', 0)} entities)" for s in sketches
    )


OPERATION_REFERENCE = """\
Operations you may append (each rebuilds the running solid, in order):
  extrude     — extrude a sketch into a solid.
                fields: sketch (name), distance, operation ("add" | "remove" to
                cut), and optional placement (plane "XY"|"XZ"|"YZ", tilt degrees +
                tiltAxis "X"|"Y"|"Z", offset [dx,dy,dz]).
  fillet      — round edges. fields: edges (a selector), radius.
  chamfer     — bevel edges. fields: edges (a selector), distance (chamfer size).
  counterbore — recess the top face at every hole that already pierces it
                (bolt-head recesses); targets the solid's existing holes, so no
                sketch is needed. fields: cboreDia, cboreDepth.
  trim        — cut the solid flush with a named face, or past an axis plane.
                fields: either trimFace ("top"|"bottom"|"left"|"right"|"front"|
                "back"), OR trimAxis ("X"|"Y"|"Z") + at (position) + keep ("min"
                keeps the lower side, "max" the upper)."""


def _system_prompt() -> str:
    return (
        "You are a CAD modeling assistant. You edit a solid by appending "
        "operations to its feature tree. You are given the current tree, the "
        "sketches available, and — if something is already built — the inventory "
        "of the result's faces and edges. Turn the user's instruction into the "
        "operation(s) that achieve it.\n\n"
        "Target geometry with the selector grammar (below), grounded in the "
        "inventory: e.g. a chamfer on 'the joint where the socket meets the "
        "plate' is edges=between:cylinder,top. Reference sketches by name. Keep "
        "your reply to one short sentence describing what you did.\n\n"
        "Use add_features when the instruction is actionable. Use "
        "ask_clarification only when you genuinely cannot tell what geometry or "
        "operation is meant.\n\n"
        + OPERATION_REFERENCE + "\n\n" + SELECTOR_REFERENCE
    )


_FEATURE_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": OP_TYPES},
        "sketch": {"type": "string", "description": "sketch name (extrude only)"},
        "operation": {"type": "string", "enum": ["add", "remove"]},
        "distance": {"type": "number", "description": "extrude distance, or chamfer size"},
        "direction": {"type": "string", "enum": ["forward", "reverse", "both"]},
        "edges": {"type": "string", "description": "edge selector for fillet / chamfer"},
        "radius": {"type": "number", "description": "fillet radius"},
        "cboreDia": {"type": "number"},
        "cboreDepth": {"type": "number"},
        "trimFace": {"type": "string"},
        "trimAxis": {"type": "string", "enum": ["X", "Y", "Z"]},
        "at": {"type": "number"},
        "keep": {"type": "string", "enum": ["min", "max"]},
        "plane": {"type": "string", "enum": ["XY", "XZ", "YZ"]},
        "tilt": {"type": "number"},
        "tiltAxis": {"type": "string", "enum": ["X", "Y", "Z"]},
        "offset": {"type": "array", "items": {"type": "number"}},
    },
    "required": ["type"],
    "additionalProperties": False,
}

ADD_TOOL = {
    "name": "add_features",
    "description": "Append one or more operations to the feature tree to satisfy the instruction.",
    "input_schema": {
        "type": "object",
        "properties": {
            "reply": {"type": "string", "description": "one short sentence describing what you did"},
            "features": {"type": "array", "items": _FEATURE_SCHEMA, "minItems": 1},
        },
        "required": ["reply", "features"],
        "additionalProperties": False,
    },
}

CLARIFY_TOOL = {
    "name": "ask_clarification",
    "description": "Ask the user a question when the instruction is too ambiguous to act on.",
    "input_schema": {
        "type": "object",
        "properties": {"question": {"type": "string"}},
        "required": ["question"],
        "additionalProperties": False,
    },
}


# ── turning the model's op into a real feature ────────────────────────────────

def _resolve_sketch(op: dict, sketches: list[dict]) -> str:
    """Map the op's sketch *name* to an id (case-insensitive), else fall back to
    the first sketch. Returns '' when there are no sketches."""
    if not sketches:
        return ""
    name = (op.get("sketch") or "").strip().lower()
    if name:
        for s in sketches:
            if (s.get("name") or "").strip().lower() == name:
                return s["id"]
    return sketches[0]["id"]


def _normalize(op: dict, sketches: list[dict]) -> dict:
    """Convert one model-produced op into a feature dict (frontend BuildFeature
    shape) with an id and a resolved sketchId."""
    t = op.get("type")
    feat: dict = {"id": _new_id(), "type": t, "sketchId": ""}

    if t == "extrude":
        feat["sketchId"] = _resolve_sketch(op, sketches)
        feat["distance"] = op.get("distance", 10)
        feat["operation"] = op.get("operation", "add")
        if op.get("direction"):
            feat["direction"] = op["direction"]
        for k in ("plane", "tilt", "tiltAxis", "offset"):
            if op.get(k) is not None:
                feat[k] = op[k]
    elif t == "fillet":
        feat["edges"] = op.get("edges", "all")
        feat["radius"] = op.get("radius", 2)
    elif t == "chamfer":
        feat["edges"] = op.get("edges", "all")
        feat["distance"] = op.get("distance", 2)
    elif t == "counterbore":
        # targets existing top-face holes; no sketch reference
        feat["cboreDia"] = op.get("cboreDia", 8)
        feat["cboreDepth"] = op.get("cboreDepth", 3)
    elif t == "trim":
        if op.get("trimFace"):
            feat["trimFace"] = op["trimFace"]
        else:
            feat["trimAxis"] = op.get("trimAxis", "Z")
            feat["at"] = op.get("at", 0)
            feat["keep"] = op.get("keep", "min")
    else:
        raise ResolverError(f"unsupported operation type: {t!r}")
    return feat


# ── orchestration ─────────────────────────────────────────────────────────────

def plan_operations(
    instruction: str,
    sketches: list[dict],
    features: list[dict],
    faces: list[dict],
    edges: list[dict],
    *,
    llm: Callable[[str, str, list[dict]], dict] | None = None,
) -> dict:
    """Plan feature-tree operations for `instruction`. Returns one of:

      {"status": "ok", "reply": str, "operations": [feature dict, ...]}
      {"status": "clarify", "question": str}

    Raises ResolverError if the model call fails or emits an unusable op.
    """
    instruction = (instruction or "").strip()
    if not instruction:
        raise ResolverError("empty instruction")

    llm = llm or claude_tool_call
    inventory = build_inventory_summary(faces, edges) if (faces or edges) else "(nothing built yet)"
    user = (
        f"CURRENT FEATURE TREE:\n{_tree_summary(features)}\n\n"
        f"SKETCHES:\n{_sketch_summary(sketches)}\n\n"
        f"INVENTORY OF THE CURRENT RESULT:\n{inventory}\n\n"
        f"INSTRUCTION: {instruction}"
    )

    call = llm(_system_prompt(), user, [ADD_TOOL, CLARIFY_TOOL])
    tool, args = call.get("tool"), call.get("input", {})

    if tool == "ask_clarification":
        return {"status": "clarify", "question": args.get("question", "")}
    if tool != "add_features":
        raise ResolverError(f"unexpected tool call: {tool!r}")

    ops = args.get("features") or []
    if not ops:
        raise ResolverError("the model returned no operations")
    operations = [_normalize(op, sketches) for op in ops]
    return {"status": "ok", "reply": args.get("reply", ""), "operations": operations}
