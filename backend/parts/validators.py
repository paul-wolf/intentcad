"""Validate part JSON structure."""


def _validate_plane(plane: object) -> list[str]:
    errors = []
    if not isinstance(plane, dict):
        return ["Feature.plane must be an object"]
    for field in ("origin", "normal", "xAxis"):
        val = plane.get(field)
        if not isinstance(val, list) or len(val) != 3:
            errors.append(f"Feature.plane.{field} must be an array of 3 numbers")
        elif not all(isinstance(v, (int, float)) for v in val):
            errors.append(f"Feature.plane.{field} must contain only numbers")
    return errors


def validate_feature(obj: object) -> list[str]:
    errors = []
    if not isinstance(obj, dict):
        return ["Feature must be an object"]
    if "id" not in obj or not isinstance(obj["id"], str):
        errors.append("Feature.id must be a string")
    feat_type = obj.get("type")
    if feat_type == "extrude":
        if "sketchDocumentId" not in obj or not isinstance(obj["sketchDocumentId"], str):
            errors.append("Feature.sketchDocumentId must be a string")
        if "sketchId" not in obj or not isinstance(obj["sketchId"], str):
            errors.append("Feature.sketchId must be a string")
        if "distance" not in obj or not isinstance(obj["distance"], (int, float)):
            errors.append("Feature.distance must be a number")
        if "operation" not in obj or obj["operation"] not in ("add", "remove"):
            errors.append("Feature.operation must be 'add' or 'remove'")
        errors.extend(_validate_plane(obj.get("plane")))
    elif feat_type == "revolve":
        if "sketchDocumentId" not in obj or not isinstance(obj["sketchDocumentId"], str):
            errors.append("Feature.sketchDocumentId must be a string")
        if "sketchId" not in obj or not isinstance(obj["sketchId"], str):
            errors.append("Feature.sketchId must be a string")
        if "axisEntityId" not in obj or not isinstance(obj["axisEntityId"], str):
            errors.append("Feature.axisEntityId must be a string")
        if "angle" not in obj or not isinstance(obj["angle"], (int, float)):
            errors.append("Feature.angle must be a number")
        if "operation" not in obj or obj["operation"] not in ("add", "remove"):
            errors.append("Feature.operation must be 'add' or 'remove'")
        errors.extend(_validate_plane(obj.get("plane")))
    elif feat_type == "shell":
        if "thickness" not in obj or not isinstance(obj["thickness"], (int, float)):
            errors.append("Feature.thickness must be a number")
        fd = obj.get("faceDirection")
        if not isinstance(fd, list) or len(fd) != 3:
            errors.append("Feature.faceDirection must be an array of 3 numbers")
        elif not all(isinstance(v, (int, float)) for v in fd):
            errors.append("Feature.faceDirection must contain only numbers")
    elif "type" not in obj:
        errors.append("Feature.type is required")
    else:
        errors.append(f"Unknown feature type: {feat_type}")
    return errors


def validate_part_data(data: object) -> list[str]:
    """Validate the data field of a Part. Returns a list of error strings."""
    errors = []
    if not isinstance(data, dict):
        return ["Part data must be an object"]
    features = data.get("features")
    if features is not None:
        if not isinstance(features, list):
            errors.append("data.features must be an array")
        else:
            for i, feature in enumerate(features):
                errors.extend(
                    [f"data.features[{i}]: {e}" for e in validate_feature(feature)]
                )
    return errors
