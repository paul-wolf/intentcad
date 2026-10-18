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


def add_extrude(code: str, sketch: str, op: str, depth: float = 10.0,
                through: bool = False, flip: bool = False) -> tuple[str, str | None]:
    """Append an extrude of face sketch `sketch` to the script: op "cut"
    removes it from `part`, "join" adds it. The depth becomes a new P key
    (unless `through`: a cut through the whole part). Cuts go into the part
    and joins grow out of the face; `flip` reverses that.

    Returns (code, the new param name or None)."""
    if op not in ("cut", "join"):
        raise ParamError(f"unknown extrude operation {op!r}")
    ast.parse(code)
    into = (op == "cut") != flip          # negative amount: into the part
    sign = "-" if into else ""
    ref = f"sketch({json.dumps(sketch)})"
    param = None
    if op == "cut" and through:
        amount = f"{sign}part.bounding_box().diagonal"
    else:
        param = _unique(param_names(code), op, "depth" if op == "cut" else "height")
        code = add_param(code, param, float(depth))
        amount = f'{sign}P["{param}"]'
    sym = "-=" if op == "cut" else "+="
    line = f"part {sym} extrude({ref}, amount={amount})"
    return code.rstrip("\n") + "\n" + line + "\n", param
