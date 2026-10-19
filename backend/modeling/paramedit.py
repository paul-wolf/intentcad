"""Change values in a script's `params`/`P` dict, in place, preserving the rest.

Pure text/AST — no code execution. We locate each target key's value node in the
`P = dict(...)` (or `P = {...}`) assignment and replace just that value's source
span, so comments, formatting, and everything else are untouched.
"""

from __future__ import annotations

import ast
import json


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

OPS = ("shell",)


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


def op_at(code: str, line: int) -> dict:
    """The Shell/Hole operation on script line `line`, for its dialog:
    {"op", "line", "end_line", "args", "params"} where args holds the values
    (P keys resolved) and params which P key holds each."""
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
