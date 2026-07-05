"""The reference resolver: natural language -> a formal selector.

This is the AI layer's first piece (see docs/world-model.md). The selection
subsystem (modeling/selectors.py) lets an operation *name* geometry with a
precise query like `between:cylinder,top` or `tag:back`; the resolver is what
turns "the joint where the socket meets the plate" or "the back face" into one
of those queries, grounded in the actual inventory of the built result.

Shape of the problem: given (a) the current result's inventory — the same
faces/edges dicts build() returns — and (b) a phrase, produce a selector from
the vocabulary selectors.py understands, then run it to get concrete indices.

The LLM call is injected (the `llm` argument) so everything around it — the
inventory summary the model reads, and applying the model's answer back through
the deterministic selectors — is a pure, testable function. The default llm is
Claude (Opus 4.8) via the Anthropic SDK.
"""

from __future__ import annotations

import os
from typing import Callable

from .selectors import SelectorError, resolve_edges, resolve_faces

MODEL = "claude-opus-4-8"


class ResolverError(RuntimeError):
    """The reference could not be resolved (no API key, model error, etc.)."""


# ── the facts the model reasons over ──────────────────────────────────────────

def _fmt_vec(v: list[float]) -> str:
    return "(" + ", ".join(f"{x:.1f}" for x in v) + ")"


def build_inventory_summary(faces: list[dict], edges: list[dict]) -> str:
    """A compact, model-readable description of the built result.

    Pure function of the inventory dicts. Lists every face and edge with the
    descriptors a selector can key on, plus the distinct face-pair *junctions*
    the adjacency graph exposes (so `between:A,B` targets are discoverable).
    """
    lines: list[str] = []

    lines.append(f"FACES ({len(faces)}):")
    for f in faces:
        tags = " ".join(f.get("tags", [])) or "-"
        lines.append(
            f"  #{f['index']} {f['kind']} [{tags}] "
            f"area={f['area']:.1f} center={_fmt_vec(f['center'])}"
        )

    lines.append(f"EDGES ({len(edges)}):")
    # (i,j) -> (descriptor, edge count): the real junctions, as faces:i,j targets
    pairs: dict[tuple[int, int], tuple[str, int]] = {}
    for e in edges:
        border = e.get("faces", [])
        border_txt = " | ".join(" ".join(t) for t in border) or "-"
        fi = e.get("faceIndices", [])
        fi_txt = f" [faces {','.join(map(str, fi))}]" if fi else ""
        lines.append(
            f"  #{e['index']} {e['kind']} len={e['length']:.1f} between {border_txt}{fi_txt}"
        )
        if len(fi) == 2:
            key = (min(fi), max(fi))
            desc = " ∩ ".join(" ".join(t) for t in border)
            _, prev = pairs.get(key, ("", 0))
            pairs[key] = (desc, prev + 1)

    if pairs:
        lines.append("JUNCTIONS (edge between two faces — target one with faces:i,j):")
        for (i, j), (desc, n) in sorted(pairs.items()):
            lines.append(f"  faces:{i},{j}  {desc}  ({n} edge{'s' if n != 1 else ''})")

    return "\n".join(lines)


SELECTOR_REFERENCE = """\
FACE selectors (choose one):
  all | *            every face
  largest | smallest the single face with max / min area
  tag:<t>            faces whose orientation tag is <t>. Planar tags (by outward
                     normal): top +Z (up), bottom -Z (underside), front -Y,
                     back +Y, left -X, right +X. Cylindrical faces are tagged
                     convex (a boss's outer wall) or concave (a hole or bore).
  kind:<k>           faces of a geometric kind (plane, cylinder, cone, sphere, ...)

EDGE selectors (choose one):
  all | *            every edge
  longest | shortest the single edge with max / min length
  kind:<k>           edges of a geometric kind (line, circle, ellipse, ...)
  between:A,B        edges where one bordering face has descriptor A and the
                     other has descriptor B (a junction). Descriptors are face
                     kinds or tags, e.g. between:convex,top for the rim where a
                     boss's outer wall meets the top face. Matches EVERY such
                     junction — too broad when several faces share a descriptor.
  faces:i,j          the exact edge(s) bordering face #i and face #j — precise.
                     Prefer this when between:A,B is ambiguous (many cylinders or
                     several 'top' faces): pick the two specific faces from the
                     inventory by their index, area, and position."""


def _system_prompt() -> str:
    return (
        "You resolve a natural-language reference to geometry into a single "
        "formal selector, for a CAD modeler.\n\n"
        "You are given the inventory of a built solid (its faces and edges with "
        "descriptors) and a phrase describing which face(s) or edge(s) the user "
        "means. Pick the selector from the grammar below that best names exactly "
        "that geometry.\n\n"
        "Decide whether the reference is about faces or edges. A 'face', 'side', "
        "'surface', or 'wall' is a face; an 'edge', 'rim', 'corner', 'fillet "
        "line', or 'where X meets Y' is usually an edge (a junction).\n\n"
        "Use choose_selector when a selector clearly matches. Use "
        "ask_clarification only when the phrase is genuinely ambiguous given the "
        "inventory (e.g. it could mean several unrelated faces).\n\n"
        + SELECTOR_REFERENCE
    )


CHOOSE_TOOL = {
    "name": "choose_selector",
    "description": "Resolve the reference to one selector over faces or edges.",
    "input_schema": {
        "type": "object",
        "properties": {
            "target": {"type": "string", "enum": ["face", "edge"]},
            "selector": {
                "type": "string",
                "description": "A selector from the grammar, e.g. 'tag:back' or 'between:cylinder,top'.",
            },
            "rationale": {
                "type": "string",
                "description": "One short sentence on why this selector matches the phrase.",
            },
        },
        "required": ["target", "selector", "rationale"],
        "additionalProperties": False,
    },
}

CLARIFY_TOOL = {
    "name": "ask_clarification",
    "description": "Ask the user a question when the reference is too ambiguous to resolve.",
    "input_schema": {
        "type": "object",
        "properties": {
            "question": {"type": "string"},
        },
        "required": ["question"],
        "additionalProperties": False,
    },
}


# ── the LLM call (injected; default is Claude) ────────────────────────────────

def claude_tool_call(system: str, user: str, tools: list[dict]) -> dict:
    """One Anthropic tool-use turn (tool_choice=any). Returns {"tool", "input"}.

    Shared by the reference resolver and the chat agent (modeling/agent.py)."""
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover - env issue, not logic
        raise ResolverError(
            "the anthropic SDK is not installed (pip install anthropic)"
        ) from exc

    # project convention is ANTHROPIC_KEY (see cam/advisor.py); fall back to the
    # SDK's own ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN.
    api_key = os.environ.get("ANTHROPIC_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not (api_key or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise ResolverError("ANTHROPIC_KEY is not set")

    client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()
    try:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            thinking={"type": "adaptive"},
            system=system,
            tools=tools,
            tool_choice={"type": "any"},
            messages=[{"role": "user", "content": user}],
        )
    except anthropic.APIError as exc:
        raise ResolverError(f"Anthropic API error: {exc}") from exc

    for block in resp.content:
        if block.type == "tool_use":
            return {"tool": block.name, "input": dict(block.input)}
    raise ResolverError("model did not return a tool call")


# ── orchestration ─────────────────────────────────────────────────────────────

def resolve_reference(
    reference: str,
    faces: list[dict],
    edges: list[dict],
    *,
    llm: Callable[[str, str, list[dict]], dict] | None = None,
) -> dict:
    """Resolve `reference` against the inventory. Returns one of:

      {"status": "resolved", "target", "selector", "indices", "rationale"}
      {"status": "clarify", "question"}

    Raises ResolverError if the model call itself fails.
    """
    reference = (reference or "").strip()
    if not reference:
        raise ResolverError("empty reference")

    llm = llm or claude_tool_call
    summary = build_inventory_summary(faces, edges)
    user = f"INVENTORY:\n{summary}\n\nREFERENCE: {reference}"

    call = llm(_system_prompt(), user, [CHOOSE_TOOL, CLARIFY_TOOL])
    tool, args = call.get("tool"), call.get("input", {})

    if tool == "ask_clarification":
        return {"status": "clarify", "question": args.get("question", "")}

    if tool != "choose_selector":
        raise ResolverError(f"unexpected tool call: {tool!r}")

    target = args.get("target")
    selector = (args.get("selector") or "").strip()
    try:
        if target == "face":
            indices = resolve_faces(selector, faces)
        elif target == "edge":
            indices = resolve_edges(selector, edges)
        else:
            raise ResolverError(f"unknown target: {target!r}")
    except SelectorError as exc:
        raise ResolverError(f"model produced an invalid selector {selector!r}: {exc}") from exc

    return {
        "status": "resolved",
        "target": target,
        "selector": selector,
        "indices": indices,
        "rationale": args.get("rationale", ""),
    }
