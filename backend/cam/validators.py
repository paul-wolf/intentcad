def validate_cam_profile_config(config: dict) -> list[str]:
    """Validate a CamProfile config dict."""
    errors = []
    if not isinstance(config, dict):
        return ["config must be a dict"]

    tool = config.get("tool")
    if tool:
        if not isinstance(tool, dict):
            errors.append("config.tool must be a dict")
        else:
            if not isinstance(tool.get("diameter"), (int, float)) or tool["diameter"] <= 0:
                errors.append("config.tool.diameter must be a positive number")
            if tool.get("type") not in ("flat", "ball", "vbit", "drill"):
                errors.append("config.tool.type must be one of: flat, ball, vbit, drill")

    machine = config.get("machine")
    if machine:
        if not isinstance(machine, dict):
            errors.append("config.machine must be a dict")
        else:
            for field in ("spindleSpeed", "feedRate", "plungeRate", "safeZ"):
                val = machine.get(field)
                if val is not None and not isinstance(val, (int, float)):
                    errors.append(f"config.machine.{field} must be a number")

    post = config.get("postProcessor")
    if post:
        if not isinstance(post, dict):
            errors.append("config.postProcessor must be a dict")
        else:
            if post.get("dialect") and post["dialect"] not in ("grbl",):
                errors.append("config.postProcessor.dialect must be: grbl")

    return errors


def validate_cam_job_config(config: dict) -> list[str]:
    """Validate a CamJob config dict."""
    errors = []
    if not isinstance(config, dict):
        return ["config must be a dict"]

    operations = config.get("operations")
    if operations is not None:
        if not isinstance(operations, list):
            errors.append("config.operations must be a list")
        else:
            for i, op in enumerate(operations):
                if not isinstance(op, dict):
                    errors.append(f"config.operations[{i}] must be a dict")
                    continue
                kind = op.get("kind")
                if kind not in ("profile", "drill", "pocket", "facing"):
                    errors.append(
                        f"config.operations[{i}].kind must be one of: profile, drill, pocket, facing"
                    )

    depth = config.get("depth")
    if depth:
        if not isinstance(depth, dict):
            errors.append("config.depth must be a dict")
        else:
            for field in ("totalDepth", "depthPerPass"):
                val = depth.get(field)
                if val is not None and (
                    not isinstance(val, (int, float)) or val <= 0
                ):
                    errors.append(f"config.depth.{field} must be a positive number")

    return errors
