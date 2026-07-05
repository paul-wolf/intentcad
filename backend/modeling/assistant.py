"""The AI loop: turn an instruction into an edit of the build123d script.

The model is a build123d script; the assistant rewrites it from natural language
(with the user's current selection as the target), then we validate it by running
it — one corrective retry on a build error. build123d does the CAD; the AI just
authors the script. The Anthropic call is injected so the prompt/validation logic
is testable with a fake llm.
"""

from __future__ import annotations

import os
from typing import Callable

from .engine import EngineError, run_script

MODEL = "claude-opus-4-8"
# Opus 4.8 pricing, USD per token (input $5/M, output $25/M)
_IN_PER_TOK = 5.0 / 1_000_000
_OUT_PER_TOK = 25.0 / 1_000_000


class AssistantError(RuntimeError):
    """The edit failed (no key, model error, or couldn't produce a building script)."""


def _system() -> str:
    return (
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
        "write a selector that resolves to it (use the given positions/kinds)."
    )


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


def _anthropic_call(system: str, user: str, tools: list[dict]) -> dict:
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover
        raise AssistantError("the anthropic SDK is not installed") from exc
    key = os.environ.get("ANTHROPIC_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not (key or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise AssistantError("ANTHROPIC_KEY is not set")
    client = anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()
    try:
        resp = client.messages.create(
            model=MODEL, max_tokens=8192,
            thinking={"type": "adaptive"},
            system=system, tools=tools,
            messages=[{"role": "user", "content": user}],
        )
    except anthropic.APIError as exc:
        raise AssistantError(f"Anthropic API error: {exc}") from exc
    for block in resp.content:
        if block.type == "tool_use" and block.name == "write_script":
            out = dict(block.input)
            out["usage"] = {"input": resp.usage.input_tokens, "output": resp.usage.output_tokens}
            return out
    raise AssistantError("the model did not return a script")


def edit_script(
    code: str,
    instruction: str,
    context: str = "",
    *,
    llm: Callable[[str, str, list[dict]], dict] | None = None,
) -> dict:
    """Edit `code` per `instruction` (with optional selection `context`). Returns
    {code, note}. Validates by building it; one corrective retry on a build error."""
    instruction = (instruction or "").strip()
    if not instruction:
        raise AssistantError("empty instruction")
    llm = llm or _anthropic_call

    def prompt(extra: str = "") -> str:
        sel = f"SELECTION: {context}\n\n" if context.strip() else ""
        return (
            f"CURRENT SCRIPT:\n```python\n{code}\n```\n\n"
            f"{sel}INSTRUCTION: {instruction}\n{extra}"
        )

    tok_in = tok_out = 0

    def call(extra: str = "") -> dict:
        nonlocal tok_in, tok_out
        o = llm(_system(), prompt(extra), [WRITE_TOOL])
        u = o.get("usage") or {}
        tok_in += u.get("input", 0)
        tok_out += u.get("output", 0)
        return o

    def validate(script: str) -> None:
        r = run_script(script)  # raises EngineError if nothing builds
        if r.get("warning"):    # an operation failed partway — treat as a build error
            raise EngineError(r["warning"])

    out = call()
    new_code = out.get("code", "")
    try:
        validate(new_code)
    except EngineError as exc:
        out = call(
            f"\nYour previous script failed to build with this error:\n{exc}\n"
            "Return a corrected complete script.")
        new_code = out.get("code", "")
        try:
            validate(new_code)
        except EngineError as exc2:
            raise AssistantError(f"couldn't produce a script that builds: {exc2}") from exc2

    return {
        "code": new_code,
        "note": out.get("note", ""),
        "tokens_in": tok_in,
        "tokens_out": tok_out,
        "cost_usd": round(tok_in * _IN_PER_TOK + tok_out * _OUT_PER_TOK, 4),
    }
