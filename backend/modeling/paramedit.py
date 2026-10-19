"""Change values in a script's `params`/`P` dict, in place, preserving the rest.

Pure text/AST — no code execution. We locate each target key's value node in the
`P = dict(...)` (or `P = {...}`) assignment and replace just that value's source
span, so comments, formatting, and everything else are untouched.
"""

from __future__ import annotations

import ast
import json
import re


class ParamError(ValueError):
    """The script has no editable params dict, or a value couldn't be located."""


def _params_assignment(tree: ast.Module):
    for node in tree.body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id in ("P", "params")):
            return node.value
    return None


def set_params(code: str, overrides: dict[str, float]) -> str:
    """Return `code` with the given param keys set to new numeric values."""
    if not overrides:
        return code
    tree = ast.parse(code)
    target = _params_assignment(tree)
    if target is None:
        raise ParamError("no `P`/`params` dict found to edit")

    # gather (value_node, new_literal) for each override present in the dict
    spans: list[tuple[int, int, int, int, str]] = []
    if isinstance(target, ast.Call) and isinstance(target.func, ast.Name) and target.func.id == "dict":
        items = [(kw.arg, kw.value) for kw in target.keywords if kw.arg is not None]
    elif isinstance(target, ast.Dict):
        items = [(k.value, v) for k, v in zip(target.keys, target.values)
                 if isinstance(k, ast.Constant) and isinstance(k.value, str)]
    else:
        raise ParamError("params must be a dict(...) or {...} literal")

    for name, val in items:
        if name in overrides:
            v = overrides[name]
            lit = repr(int(v) if isinstance(v, float) and v.is_integer() else v)
            spans.append((val.lineno, val.col_offset, val.end_lineno or val.lineno,
                          val.end_col_offset or val.col_offset, lit))

    # apply span replacements last-first so earlier offsets stay valid
    lines = code.split("\n")
    for lineno, c0, end_lineno, c1, lit in sorted(spans, reverse=True):
        if lineno != end_lineno:
            continue  # skip multi-line values (shouldn't happen for numbers)
        line = lines[lineno - 1]
        lines[lineno - 1] = line[:c0] + lit + line[c1:]
    return "\n".join(lines)


def _unique(names: set[str], stem: str, suffix: str) -> str:
    n = 1
    while f"{stem}{n}_{suffix}" in names:
        n += 1
    return f"{stem}{n}_{suffix}"


def add_param(code: str, name: str, value: float) -> str:
    """Return `code` with a new key in its `P` dict (creating `P = dict(...)`
    before the first statement that isn't an import, if there is none)."""
    tree = ast.parse(code)
    lit = repr(int(value) if isinstance(value, float) and value.is_integer() else value)
    lines = code.split("\n")
    target = _params_assignment(tree)
    if target is None:
        at = next((n.lineno - 1 for n in tree.body if not isinstance(n, (ast.Import, ast.ImportFrom))),
                  len(lines))
        lines[at:at] = [f"P = dict({name}={lit})", ""]
        return "\n".join(lines)
    if isinstance(target, ast.Call) and isinstance(target.func, ast.Name) and target.func.id == "dict":
        items, entry = target.keywords, f"{name}={lit}"
    elif isinstance(target, ast.Dict):
        items, entry = target.values, f'"{name}": {lit}'
    else:
        raise ParamError("params must be a dict(...) or {...} literal")
    end_line, end_col = target.end_lineno - 1, target.end_col_offset - 1   # the closing ) or }
    if items:
        last = items[-1]
        last_end = (last.end_lineno - 1, last.end_col_offset)
        if last.lineno != target.lineno and last_end[0] < end_line:
            # one entry per line: add ours on its own line, indented like the last
            row = lines[last.lineno - 1]
            indent = row[:len(row) - len(row.lstrip())]
            ln, col = last_end
            rest = lines[ln][col:]
            comma = "" if rest.lstrip().startswith(",") else ","
            if comma:
                lines[ln] = lines[ln][:col] + "," + rest
            lines.insert(ln + 1, f"{indent}{entry},")
            return "\n".join(lines)
        ln, col = last_end
        lines[ln] = lines[ln][:col] + f", {entry}" + lines[ln][col:]
        return "\n".join(lines)
    row = lines[end_line]
    lines[end_line] = row[:end_col] + entry + row[end_col:]
    return "\n".join(lines)


def param_names(code: str) -> set[str]:
    target = _params_assignment(ast.parse(code))
    if isinstance(target, ast.Call):
        return {kw.arg for kw in target.keywords if kw.arg}
    if isinstance(target, ast.Dict):
        return {k.value for k in target.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)}
    return set()


def _assigns_part(tree: ast.Module) -> bool:
    return any(isinstance(n, (ast.Assign, ast.AnnAssign))
               and any(isinstance(t, ast.Name) and t.id == "part"
                       for t in (n.targets if isinstance(n, ast.Assign) else [n.target]))
               for n in tree.body)


def add_extrude(code: str, sketch: str, op: str, depth: float = 10.0,
                through: bool = False, flip: bool = False, datum: bool = False,
                both: bool = False) -> tuple[str, str | None]:
    """Append an extrude of sketch `sketch` to the script: op "cut" removes
    it from `part`, "join" adds it, "new" makes it the part (a script with no
    `part` yet). The depth becomes a new P key (unless `through`: a cut
    through the whole part).

    A face sketch's plane faces out of the part, so cuts go into the part and
    joins grow out of the face. A `datum` sketch (on a base plane: Top, Front,
    Right) has no outside: everything goes along the plane's normal, and a
    through cut goes both ways. `flip` reverses the direction; `both` extrudes
    the depth to each side of a base plane (symmetric) instead.

    Returns (code, the new param name or None)."""
    if op not in ("cut", "join", "new"):
        raise ParamError(f"unknown extrude operation {op!r}")
    tree = ast.parse(code)
    blank = not code.strip()
    if op == "new" and _assigns_part(tree):
        raise ParamError("the script already makes a part: Cut or Join this sketch instead")
    into = op == "cut" and not datum      # negative amount: into the part
    sign = "-" if into != flip else ""
    ref = f"sketch({json.dumps(sketch)})"
    param = None
    if op == "cut" and through:
        bb = "part.bounding_box()"
        amount = f"{bb}.diagonal + {bb}.center().length, both=True" if datum else f"{sign}{bb}.diagonal"
    else:
        stem, suffix = {"cut": ("cut", "depth"), "join": ("join", "height"), "new": ("body", "height")}[op]
        param = _unique(param_names(code), stem, suffix)
        code = add_param(code, param, float(depth))
        amount = f'P["{param}"], both=True' if both and datum else f'{sign}P["{param}"]'
    sym = {"cut": "-=", "join": "+=", "new": "="}[op]
    line = f"part {sym} extrude({ref}, amount={amount})"
    code = code.strip() if blank else code.rstrip("\n")
    gap = "\n\n" if op == "new" else "\n"
    return code + gap + line + "\n", param


# --- Shell and Hole: one script line each, written by the editor's dialogs and
# read back (op_at) to reopen the dialog on it. Editing rewrites that line in
# place and sets the values of the P keys it uses; nothing else changes.

OPS = ("shell", "holes")


def _lit(v) -> str:
    """`v` as a short Python literal: 25 rather than 25.0, dicts with "keys"."""
    if isinstance(v, bool) or v is None:
        return repr(v)
    if isinstance(v, float):
        return repr(int(v)) if v.is_integer() else repr(round(v, 6))
    if isinstance(v, int):
        return repr(v)
    if isinstance(v, str):
        return json.dumps(v)
    if isinstance(v, dict):
        return "{" + ", ".join(f"{json.dumps(str(k))}: {_lit(x)}" for k, x in v.items()) + "}"
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_lit(x) for x in v) + "]"
    raise ParamError(f"can't write {v!r} into the script")


def _name(names: set[str], base: str) -> str:
    """`base` if the P dict doesn't have it yet, else base with a number:
    wall, shell2_wall, shell3_wall..."""
    if base not in names:
        return base
    stem, _, suffix = base.partition("_")
    n = 2
    while f"{stem}{n}_{suffix}" in names:
        n += 1
    return f"{stem}{n}_{suffix}" if suffix else f"{stem}{n}"


def _p_values(code: str) -> dict:
    """The P dict's literal values (an expression's is left out)."""
    target = _params_assignment(ast.parse(code))
    if isinstance(target, ast.Call):
        items = [(kw.arg, kw.value) for kw in target.keywords if kw.arg]
    elif isinstance(target, ast.Dict):
        items = [(k.value, v) for k, v in zip(target.keys, target.values)
                 if isinstance(k, ast.Constant) and isinstance(k.value, str)]
    else:
        return {}
    out = {}
    for k, v in items:
        try:
            out[k] = ast.literal_eval(v)
        except ValueError:
            pass
    return out


def _p_key(node) -> str | None:
    """The key of a P["key"] (or params["key"]) expression, else None."""
    if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name)
            and node.value.id in ("P", "params") and isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, str)):
        return node.slice.value
    return None


def _op_stmt(tree: ast.Module, line: int):
    """The top-level `part = shell(...)`/`holes(...)` statement on script
    line `line` (1-based, any line it spans): (statement, call, op) or None."""
    for node in tree.body:
        if not (node.lineno <= line <= (node.end_lineno or node.lineno)):
            continue
        if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Name) and node.value.func.id in OPS):
            return node, node.value, node.value.func.id
        return None
    return None


def op_lines(code: str) -> list[dict]:
    """Every Shell/Hole line of the script: [{"op", "line", "end_line"}]."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    out = []
    for node in tree.body:
        hit = _op_stmt(tree, node.lineno)
        if hit:
            out.append({"op": hit[2], "line": node.lineno, "end_line": node.end_lineno or node.lineno})
    return out


def _value(node, pv: dict):
    """(value, P key) of an argument: P["k"] → (P's value, "k"), a literal →
    (it, None)."""
    key = _p_key(node)
    if key is not None:
        return pv.get(key), key
    try:
        return ast.literal_eval(node), None
    except ValueError:
        raise ParamError(f"can't read {ast.unparse(node)!r}: edit this line in the code") from None


def _face_refs(node) -> list[dict]:
    items = node.elts if isinstance(node, (ast.List, ast.Tuple)) else [node]
    out = []
    for it in items:
        if not (isinstance(it, ast.Call) and isinstance(it.func, ast.Name)
                and it.func.id == "face_ref" and it.args):
            raise ParamError(f"can't read the face {ast.unparse(it)!r}: edit this line in the code")
        out.append(ast.literal_eval(it.args[0]))
    return out


# holes() arguments that override a preset size (hole_presets), and the base
# of the P key each gets
HOLE_SIZES = {"d": "hole_d", "cbore_d": "cbore_d", "cbore_depth": "cbore_depth", "csk_d": "csk_d"}


def _at(node) -> dict:
    """holes(at=...): {"sketch": name} or {"face": ref}."""
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.args
            and node.func.id == "sketch_points" and isinstance(node.args[0], ast.Constant)):
        return {"sketch": node.args[0].value}
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "face_ref":
        return {"face": _face_refs(node)[0]}
    raise ParamError(f"can't read where the holes go ({ast.unparse(node)!r}): edit this line in the code")


def _dict_items(node) -> list[tuple[str, ast.AST]]:
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "dict":
        return [(k.arg, k.value) for k in node.keywords if k.arg]
    if isinstance(node, ast.Dict):
        return [(k.value, v) for k, v in zip(node.keys, node.values)
                if isinstance(k, ast.Constant) and isinstance(k.value, str)]
    raise ParamError(f"can't read {ast.unparse(node)!r}: edit this line in the code")


def op_at(code: str, line: int) -> dict:
    """The Shell/Hole operation on script line `line`, for its dialog:
    {"op", "line", "end_line", "args", "params"} where args holds the values
    (P keys resolved) and params which P key holds each ("standoff.h" for
    a standoff's)."""
    tree = ast.parse(code)
    hit = _op_stmt(tree, line)
    if hit is None:
        raise ParamError(f"line {line} is not a shell() or holes() line")
    stmt, call, op = hit
    pv = _p_values(code)
    kw = {k.arg: k.value for k in call.keywords if k.arg}
    args: dict = {}
    params: dict = {}
    if op == "shell":
        args["remove"] = _face_refs(kw["remove"]) if "remove" in kw else []
        args["thickness"], params["thickness"] = _value(kw["thickness"], pv) if "thickness" in kw else (2.0, None)
        args["inside"] = _value(kw["inside"], pv)[0] if "inside" in kw else True
    else:
        args["at"] = _at(kw["at"]) if "at" in kw else None
        for k, default in (("kind", "clearance"), ("size", "M3"), ("fit", "normal")):
            args[k] = _value(kw[k], pv)[0] if k in kw else default
        args["depth"], params["depth"] = _value(kw["depth"], pv) if "depth" in kw else ("through", None)
        if args["depth"] == "through":
            args["depth"] = None
        args["sizes"] = {}
        for k in HOLE_SIZES:
            if k in kw:
                args["sizes"][k], params[k] = _value(kw[k], pv)
        args["standoff"] = None
        if "standoff" in kw and not (isinstance(kw["standoff"], ast.Constant) and kw["standoff"].value is None):
            args["standoff"] = {}
            for k, node in _dict_items(kw["standoff"]):
                args["standoff"][k], params[f"standoff.{k}"] = _value(node, pv)
    return {"op": op, "line": stmt.lineno, "end_line": stmt.end_lineno or stmt.lineno,
            "args": args, "params": {k: v for k, v in params.items() if v}}


def _write_op(code: str, text: str, line: int | None, op: str) -> str:
    """Append the statement `text`, or put it in place of the `op` statement
    on `line`."""
    if line is None:
        return code.rstrip("\n") + "\n" + text + "\n"
    hit = _op_stmt(ast.parse(code), line)
    if hit is None or hit[2] != op:
        raise ParamError(f"line {line} is not a {op}() line any more")
    stmt = hit[0]
    lines = code.split("\n")
    lines[stmt.lineno - 1:stmt.end_lineno] = [lines[stmt.lineno - 1][:stmt.col_offset] + text]
    return "\n".join(lines)


def _number(code: str, value: float, key: str | None, base: str, names: set[str]) -> tuple[str, str]:
    """Hold `value` in P: in `key` (the line's own, set to it) or a new key
    named after `base`. Returns (code, key)."""
    if key and key in names:
        return set_params(code, {key: float(value)}), key
    key = _name(names, base)
    names.add(key)
    return add_param(code, key, float(value)), key


def add_shell(code: str, remove: list[dict], thickness: float = 2.0, inside: bool = True,
              line: int | None = None) -> tuple[str, str]:
    """Append `part = shell(part, remove=[face_ref(...)], thickness=P[...],
    inside=...)` — or, with `line`, rewrite the shell() line there. The
    thickness lives in P (a new key, or the line's own). Returns (code, key)."""
    if not _assigns_part(ast.parse(code)):
        raise ParamError("there is no part to shell yet")
    if float(thickness) <= 0:
        raise ParamError("the wall thickness must be more than 0")
    key = op_at(code, line)["params"].get("thickness") if line is not None else None
    names = param_names(code)
    key = key if key in names else _name(names, "wall")
    refs = ", ".join(f"face_ref({_lit(r)})" for r in remove)
    text = f'part = shell(part, remove=[{refs}], thickness=P["{key}"], inside={bool(inside)})'
    code = _write_op(code, text, line, "shell")
    code, key = _number(code, thickness, key, "wall", names)
    return code, key


def drop_param(code: str, key: str) -> str:
    """`code` without P's `key`, unless something still uses it (or its entry
    spans lines: then it is left)."""
    tree = ast.parse(code)
    if any(_p_key(n) == key for n in ast.walk(tree)):
        return code
    target = _params_assignment(tree)
    if isinstance(target, ast.Call):
        items = [(kw.arg, kw, kw.value) for kw in target.keywords if kw.arg]
    elif isinstance(target, ast.Dict):
        items = [(k.value, k, v) for k, v in zip(target.keys, target.values)
                 if isinstance(k, ast.Constant) and isinstance(k.value, str)]
    else:
        return code
    i = next((i for i, it in enumerate(items) if it[0] == key), None)
    if i is None:
        return code
    _, start, end = items[i]
    if start.lineno != end.end_lineno:
        return code
    lines = code.split("\n")
    row = lines[start.lineno - 1]
    if i > 0 and items[i - 1][2].end_lineno == start.lineno:      # ", key=v" after the one before
        a, b = items[i - 1][2].end_col_offset, end.end_col_offset
    elif i + 1 < len(items) and items[i + 1][1].lineno == start.lineno:   # "key=v, " before the next
        a, b = start.col_offset, items[i + 1][1].col_offset
    elif row[:start.col_offset].strip() == "" :                      # on a line of its own
        del lines[start.lineno - 1]
        return "\n".join(lines)
    else:
        a, b = start.col_offset, end.end_col_offset
    lines[start.lineno - 1] = row[:a] + row[b:]
    return "\n".join(lines)


def add_holes(code: str, at: dict, kind: str = "clearance", size: str = "M3",
              depth: float | None = None, fit: str = "normal", standoff: dict | None = None,
              sizes: dict | None = None, line: int | None = None) -> tuple[str, str | None]:
    """Append `part = holes(part, at=..., kind=..., size=..., depth=..., ...)`
    — or, with `line`, rewrite the holes() line there. `at` is {"sketch":
    name} or {"face": ref}; depth None is through. A blind depth, the
    standoff's h and d and each preset size the dialog changed (`sizes`: d,
    cbore_d, cbore_depth, csk_d) live in P: the line's own keys, or new ones.
    P gets hole_comp=0 if it has no hole_comp yet. Returns (code, the depth's
    key or None)."""
    from modeling import hole_presets

    if not _assigns_part(ast.parse(code)):
        raise ParamError("there is no part to put holes in yet")
    try:
        hole_presets.preset(kind, size, fit)
    except ValueError as exc:
        raise ParamError(str(exc)) from None
    if depth is not None and float(depth) <= 0:
        raise ParamError("the hole depth must be more than 0 (or through)")
    sizes = {k: float(v) for k, v in (sizes or {}).items() if v is not None}
    if set(sizes) - HOLE_SIZES.keys():
        raise ParamError(f"unknown hole size {sorted(set(sizes) - HOLE_SIZES.keys())[0]!r}")
    if standoff is not None and (float(standoff.get("h", 0)) <= 0 or float(standoff.get("d", 0)) <= 0):
        raise ParamError("a standoff needs a height and a diameter more than 0")
    old = op_at(code, line)["params"] if line is not None else {}
    names = param_names(code)

    # the P key of each number: the line's own if its name still fits, else a new one
    want: dict[str, tuple[float, str]] = {}
    if depth is not None:
        want["depth"] = (float(depth), f"{kind if kind in ('insert', 'tapped') else 'hole'}_depth")
    for k, v in sizes.items():
        want[k] = (v, HOLE_SIZES[k])
    if standoff is not None:
        want["standoff.h"] = (float(standoff["h"]), "standoff_h")
        want["standoff.d"] = (float(standoff["d"]), "standoff_d")
    keys: dict[str, str] = {}
    for slot, (_, base) in want.items():
        k = old.get(slot)
        stem, _, suffix = base.partition("_")
        same = k in names and re.fullmatch(rf"{stem}\d*_{suffix}", k)   # insert_depth stays insert_depth
        keys[slot] = k if same else _name(names | set(keys.values()), base)

    where = (f"sketch_points({json.dumps(at['sketch'])})" if "sketch" in at
             else f"face_ref({_lit(at['face'])})")
    parts = [f"at={where}", f"kind={json.dumps(kind)}", f"size={json.dumps(size)}"]
    if kind == "clearance":
        parts.append(f"fit={json.dumps(fit)}")
    parts.append(f'depth=P["{keys["depth"]}"]' if "depth" in keys else 'depth="through"')
    parts += [f'{k}=P["{keys[k]}"]' for k in HOLE_SIZES if k in keys]
    if standoff is not None:
        fil = _lit(float(standoff.get("fillet", hole_presets.STANDOFF_FILLET)))
        parts.append(f'standoff=dict(h=P["{keys["standoff.h"]}"], d=P["{keys["standoff.d"]}"], fillet={fil})')
    text = f"part = holes(part, {', '.join(parts)})"
    code = _write_op(code, text, line, "holes")
    for slot, (v, _) in want.items():
        k = keys[slot]
        code = set_params(code, {k: v}) if k in names else add_param(code, k, v)
    if "hole_comp" not in param_names(code):
        code = add_param(code, "hole_comp", 0.0)
    for k in set(old.values()) - set(keys.values()):
        code = drop_param(code, k)
    return code, keys.get("depth")
