import json
import os


def suggest_cutting_plan(
    document_data: dict,
    profile_config: dict | None,
    material: str | None,
) -> dict:
    """
    Use the Anthropic API to suggest a CAM job config from document sketch data.
    Returns {"config": {...}, "notes": [...]}.
    """
    api_key = os.environ.get("ANTHROPIC_KEY", "")
    if not api_key:
        return {
            "config": {},
            "notes": ["ANTHROPIC_KEY not configured - AI advisor unavailable."],
        }

    try:
        import anthropic
    except ImportError:
        return {
            "config": {},
            "notes": ["anthropic package not installed - run: pip install anthropic"],
        }

    # Summarize entities for the prompt
    sketches = document_data.get("sketches", [])
    entity_summary = []
    for sketch in sketches:
        name = sketch.get("name", "unnamed")
        entities = sketch.get("entities", [])
        counts: dict[str, int] = {}
        for e in entities:
            t = e.get("type", "unknown")
            counts[t] = counts.get(t, 0) + 1
        entity_summary.append(f"Sketch '{name}': {counts}")

    prompt = f"""You are a CNC machining expert. Given a 2D sketch document, suggest a complete CAM job configuration.

Document sketches:
{chr(10).join(entity_summary)}

{f"Machine profile: {json.dumps(profile_config)}" if profile_config else "No machine profile provided - use reasonable defaults for a small CNC router."}
{f"Material: {material}" if material else "Material: not specified (assume plywood or MDF)"}

Return a JSON object with this exact structure:
{{
  "config": {{
    "tool": {{"id": "suggested", "name": "...", "diameter": <mm>, "type": "flat"|"ball"|"vbit"|"drill", "fluteCount": <n>, "fluteLength": <mm>}},
    "machine": {{"spindleSpeed": <rpm>, "feedRate": <mm/min>, "plungeRate": <mm/min>, "safeZ": <mm>, "useFloodCoolant": false}},
    "stock": {{"thickness": <mm>, "zTop": 0}},
    "depth": {{"totalDepth": <mm>, "depthPerPass": <mm>, "finalPassAllowance": 0}},
    "postProcessor": {{"dialect": "grbl", "decimalPlaces": 3, "arcOutput": "arcs", "linearizeTolerance": 0.01, "header": "", "footer": ""}},
    "operations": [
      {{"kind": "profile"|"drill"|"pocket", "entityIds": [], "sketchId": "...", ...}}
    ]
  }},
  "notes": ["explanation of choices..."]
}}

Respond ONLY with the JSON object, no markdown fences."""

    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    text = response.content[0].text.strip()
    # Strip markdown fences if present
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
        if text.endswith("```"):
            text = text[: text.rfind("```")]

    try:
        result = json.loads(text)
        return {
            "config": result.get("config", {}),
            "notes": result.get("notes", []),
        }
    except json.JSONDecodeError:
        return {
            "config": {},
            "notes": [f"Failed to parse AI response: {text[:200]}"],
        }
