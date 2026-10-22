OP_KINDS = ("profile", "drill", "pocket", "facing")
TOOL_TYPES = ("flat", "ball", "vbit", "drill")


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _version(config: dict) -> tuple[int, list[str]]:
    """1 for a config without a version key, 2 for version 2; else an error."""
    if "version" not in config:
        return 1, []
    if config["version"] == 2:
        return 2, []
    return 0, ["config.version must be 2 (or left out for the first form)"]


def _validate_machine_v2(machine) -> list[str]:
    """The machine of a version 2 profile: its limits, safety heights, tools and presets."""
    if not isinstance(machine, dict):
        return ["config.machine must be a dict"]
    errors = []
    post = machine.get("post")
    if post is not None:
        if not isinstance(post, dict):
            errors.append("config.machine.post must be a dict")
        elif post.get("dialect") is not None and post["dialect"] != "grbl":
            errors.append("config.machine.post.dialect must be: grbl")
    for field in ("maxRpm", "rapidRate", "safeZ", "clearanceZ", "spoilboardAllowance"):
        val = machine.get(field)
        if val is not None and not _is_number(val):
            errors.append(f"config.machine.{field} must be a number")
    safe_z, clearance_z = machine.get("safeZ"), machine.get("clearanceZ")
    if _is_number(safe_z) and safe_z <= 0:
        errors.append("config.machine.safeZ must be above the stock (more than 0)")
    if _is_number(safe_z) and _is_number(clearance_z) and clearance_z < safe_z:
        errors.append("config.machine.clearanceZ must be at least safeZ")
    allowance = machine.get("spoilboardAllowance")
    if _is_number(allowance) and not 0 <= allowance <= 5:
        errors.append("config.machine.spoilboardAllowance must be between 0 and 5 mm")
    if machine.get("toolChange") is not None and machine["toolChange"] not in ("M0", "M6", "ATC"):
        errors.append("config.machine.toolChange must be one of: M0, M6, ATC")
    if machine.get("coolant") is not None and machine["coolant"] not in ("none", "M7", "M8"):
        errors.append("config.machine.coolant must be one of: none, M7, M8")
    tools = machine.get("tools")
    if tools is not None:
        if not isinstance(tools, list):
            errors.append("config.machine.tools must be a list")
        else:
            for i, tool in enumerate(tools):
                if not isinstance(tool, dict):
                    errors.append(f"config.machine.tools[{i}] must be a dict")
                    continue
                if not _is_number(tool.get("diameter")) or tool["diameter"] <= 0:
                    errors.append(f"config.machine.tools[{i}].diameter must be a positive number")
                if tool.get("type") not in TOOL_TYPES:
                    errors.append(f"config.machine.tools[{i}].type must be one of: flat, ball, vbit, drill")
    presets = machine.get("presets")
    if presets is not None and not isinstance(presets, list):
        errors.append("config.machine.presets must be a list")
    return errors


def validate_cam_profile_config(config: dict) -> list[str]:
    """Validate a CamProfile config dict (the first form, or version 2: {"version": 2, "machine": {...}})."""
    if not isinstance(config, dict):
        return ["config must be a dict"]
    version, errors = _version(config)
    if version == 2:
        return _validate_machine_v2(config.get("machine"))
    if errors:
        return errors

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


def _validate_operations(operations, overrides: bool = False) -> list[str]:
    errors = []
    if operations is None:
        return errors
    if not isinstance(operations, list):
        return ["config.operations must be a list"]
    for i, op in enumerate(operations):
        if not isinstance(op, dict):
            errors.append(f"config.operations[{i}] must be a dict")
            continue
        if op.get("kind") not in OP_KINDS:
            errors.append(f"config.operations[{i}].kind must be one of: profile, drill, pocket, facing")
        if overrides and op.get("overrides") is not None and not isinstance(op["overrides"], dict):
            errors.append(f"config.operations[{i}].overrides must be a dict")
    return errors


def _validate_job_v2(config: dict) -> list[str]:
    """A version 2 job: its setup (stock, clamps), operations (overrides only), thread and migration notes."""
    errors = _validate_operations(config.get("operations"), overrides=True)
    setup = config.get("setup")
    if setup is not None:
        if not isinstance(setup, dict):
            errors.append("config.setup must be a dict")
        else:
            stock = setup.get("stock")
            if stock is not None:
                if not isinstance(stock, dict):
                    errors.append("config.setup.stock must be a dict")
                elif stock.get("thickness") is not None and (
                    not _is_number(stock["thickness"]) or stock["thickness"] <= 0
                ):
                    errors.append("config.setup.stock.thickness must be a positive number")
            clamps = setup.get("clamps")
            if clamps is not None:
                if not isinstance(clamps, list):
                    errors.append("config.setup.clamps must be a list")
                else:
                    for i, clamp in enumerate(clamps):
                        if not isinstance(clamp, dict):
                            errors.append(f"config.setup.clamps[{i}] must be a dict")
                            continue
                        for field in ("x", "y", "width", "height", "zHeight"):
                            if not _is_number(clamp.get(field)):
                                errors.append(f"config.setup.clamps[{i}].{field} must be a number")
    for field in ("thread", "migrationNotes"):
        if config.get(field) is not None and not isinstance(config[field], list):
            errors.append(f"config.{field} must be a list")
    return errors


def validate_cam_job_config(config: dict) -> list[str]:
    """Validate a CamJob config dict (the first form, or version 2 with setup and operations)."""
    if not isinstance(config, dict):
        return ["config must be a dict"]
    version, errors = _version(config)
    if version == 2:
        return _validate_job_v2(config)
    if errors:
        return errors

    errors = _validate_operations(config.get("operations"))

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
