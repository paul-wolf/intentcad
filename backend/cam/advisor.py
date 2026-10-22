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

    entity_lines = describe_entities(document_data.get("sketches", []))

    prompt = f"""You are a CNC machining expert. Given the shapes in a 2D sketch, plan the CAM operations to cut them.

Shapes (sketch units are mm; the sketch's Y axis points down):
{chr(10).join(entity_lines) if entity_lines else "(no shapes)"}

{f"Machine profile: {json.dumps(profile_config)}" if profile_config else "No machine profile provided - use reasonable defaults for a small CNC router."}
{f"Material: {material}" if material else "Material: not specified (assume plywood or MDF)"}

Rules:
- Every operation lists the ids of the shapes it cuts in "entityIds", using the ids above exactly.
- "profile" cuts along closed shapes: "outside" to cut a part free, "inside" for a cut-out, "on" for engraving a line.
- "pocket" clears the inside of one closed shape to a depth.
- "drill" drills circles at their centre with a drill of the circle's diameter or smaller.
- Holes go before the outside profile that frees the part. Use one operation per tool and depth.
- Depths are positive numbers in mm below the stock top. Through cuts go to the stock thickness.

Return a JSON object with this exact structure:
{{
  "config": {{
    "stock": {{"thickness": <mm>}},
    "useFloodCoolant": false,
    "operations": [
      {{
        "kind": "profile" | "pocket" | "drill",
        "entityIds": ["<shape id>", ...],
        "cutSide": "outside" | "inside" | "on",        (profile only)
        "stepover": <fraction of tool diameter, e.g. 0.4>, (pocket only)
        "cutDirection": "climb" | "conventional",      (pocket only)
        "peckDepth": <mm, 0 for a single plunge>,      (drill only)
        "dwell": <seconds>,                            (drill only)
        "cutting": {{
          "tool": {{"id": "<short id>", "name": "...", "diameter": <mm>, "type": "flat" | "ball" | "vbit" | "drill", "fluteCount": <n>, "fluteLength": <mm>}},
          "spindleSpeed": <rpm>, "feedRate": <mm/min>, "plungeRate": <mm/min>, "safeZ": <mm above the stock>,
          "depth": {{"totalDepth": <mm>, "depthPerPass": <mm>, "finalPassAllowance": 0}}
        }}
      }}
    ]
  }},
  "notes": ["what you chose and why, including where feeds and speeds came from"]
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


MAX_ENTITIES = 300


def _bbox(points):
    xs = [p.get("x", 0) for p in points]
    ys = [p.get("y", 0) for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def describe_entities(sketches: list) -> list[str]:
    """One line per cuttable shape: id, type and the size the AI needs to plan with."""
    lines: list[str] = []
    for sketch in sketches or []:
        sketch_name = sketch.get("name", "unnamed")
        for e in sketch.get("entities", []) or []:
            if len(lines) >= MAX_ENTITIES:
                lines.append(f"... more shapes not listed (over {MAX_ENTITIES})")
                return lines
            if e.get("construction"):
                continue
            t = e.get("type")
            eid = e.get("id")
            if t == "circle":
                c = e.get("center", {})
                lines.append(
                    f"- id={eid} sketch='{sketch_name}' circle diameter={2 * e.get('radius', 0):.2f} "
                    f"center=({c.get('x', 0):.2f}, {c.get('y', 0):.2f})"
                )
            elif t == "rectangle":
                c = e.get("center", {})
                r = e.get("cornerRadius") or 0
                lines.append(
                    f"- id={eid} sketch='{sketch_name}' rectangle {e.get('width', 0):.2f} x {e.get('height', 0):.2f}"
                    f"{f' corner radius {r:.2f}' if r else ''} center=({c.get('x', 0):.2f}, {c.get('y', 0):.2f})"
                )
            elif t == "line":
                pts = e.get("points") or []
                if len(pts) < 2:
                    continue
                x0, y0, x1, y1 = _bbox(pts)
                closed = "closed" if e.get("closed") else "open"
                arcs = " with arcs" if any(b for b in (e.get("bulge") or [])) else ""
                lines.append(
                    f"- id={eid} sketch='{sketch_name}' {closed} polyline{arcs}, {len(pts)} points, "
                    f"bounding box {x1 - x0:.2f} x {y1 - y0:.2f} from ({x0:.2f}, {y0:.2f})"
                )
    return lines
