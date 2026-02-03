"""Validate document JSON structure."""


def validate_point(obj: object) -> list[str]:
    errors = []
    if not isinstance(obj, dict):
        return ["Point must be an object"]
    if "x" not in obj or not isinstance(obj["x"], (int, float)):
        errors.append("Point.x must be a number")
    if "y" not in obj or not isinstance(obj["y"], (int, float)):
        errors.append("Point.y must be a number")
    return errors


def validate_entity(obj: object) -> list[str]:
    errors = []
    if not isinstance(obj, dict):
        return ["Entity must be an object"]
    if "id" not in obj or not isinstance(obj["id"], str):
        errors.append("Entity.id must be a string")
    if obj.get("type") == "line":
        points = obj.get("points")
        if not isinstance(points, list) or len(points) < 2:
            errors.append("Entity.points must be an array with at least 2 points")
        else:
            for i, pt in enumerate(points):
                errors.extend(
                    [f"Entity.points[{i}]: {e}" for e in validate_point(pt)]
                )
    elif obj.get("type") == "dimension":
        if "targetEntityId" not in obj or not isinstance(obj["targetEntityId"], str):
            errors.append("Entity.targetEntityId must be a string")
        if "segmentIndex" not in obj or not isinstance(obj["segmentIndex"], int):
            errors.append("Entity.segmentIndex must be an integer")
        if "offset" not in obj or not isinstance(obj["offset"], (int, float)):
            errors.append("Entity.offset must be a number")
    elif "type" not in obj:
        errors.append("Entity.type is required")
    else:
        errors.append(f"Unknown entity type: {obj['type']}")
    return errors


def validate_sketch(obj: object) -> list[str]:
    errors = []
    if not isinstance(obj, dict):
        return ["Sketch must be an object"]
    if "id" not in obj or not isinstance(obj["id"], str):
        errors.append("Sketch.id must be a string")
    if "name" not in obj or not isinstance(obj["name"], str):
        errors.append("Sketch.name must be a string")
    if "visible" not in obj or not isinstance(obj["visible"], bool):
        errors.append("Sketch.visible must be a boolean")
    entities = obj.get("entities", [])
    if not isinstance(entities, list):
        errors.append("Sketch.entities must be an array")
    else:
        for i, entity in enumerate(entities):
            errors.extend(
                [f"Sketch.entities[{i}]: {e}" for e in validate_entity(entity)]
            )
    return errors


def validate_document_data(data: object) -> list[str]:
    """Validate the data field of a Document. Returns a list of error strings."""
    errors = []
    if not isinstance(data, dict):
        return ["Document data must be an object"]
    if "id" not in data or not isinstance(data["id"], str):
        errors.append("data.id must be a string")
    if "name" not in data or not isinstance(data["name"], str):
        errors.append("data.name must be a string")
    if "activeSketchId" not in data or not isinstance(data["activeSketchId"], str):
        errors.append("data.activeSketchId must be a string")
    sketches = data.get("sketches", [])
    if not isinstance(sketches, list):
        errors.append("data.sketches must be an array")
    else:
        for i, sketch in enumerate(sketches):
            errors.extend(
                [f"data.sketches[{i}]: {e}" for e in validate_sketch(sketch)]
            )
    return errors
