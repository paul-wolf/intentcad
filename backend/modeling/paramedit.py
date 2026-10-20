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


# the P key a new extrude's depth gets: cut1_depth, join1_height, body1_height
_EXTRUDE_KEY = {"cut": ("cut", "depth"), "join": ("join", "height"), "new": ("body", "height")}
_EXTRUDE_SYM = {"cut": "-=", "join": "+=", "new": "="}
_BB = "part.bounding_box()"
_THROUGH = f"{_BB}.diagonal"                                  # a through cut, one way
_THROUGH_BOTH = f"{_BB}.diagonal + {_BB}.center().length"     # a base-plane sketch's, both ways


def _extrude_text(sketch: str, op: str, key: str | None, through: bool, flip: bool,
                  datum: bool, both: bool) -> str:
    """The script line of an extrude (add_extrude's doc says what each option
    does); `key` is the P key of its depth (None for a through cut)."""
    into = op == "cut" and not datum      # negative amount: into the part
    sign = "-" if into != flip else ""
    if op == "cut" and through:
        amount = f"{_THROUGH_BOTH}, both=True" if datum else f"{sign}{_THROUGH}"
    else:
        amount = f'P["{key}"], both=True' if both and datum else f'{sign}P["{key}"]'
    return f"part {_EXTRUDE_SYM[op]} extrude(sketch({json.dumps(sketch)}), amount={amount})"


def _read_extrude(stmt, call, pv: dict, datum_sketches) -> tuple[dict, str | None]:
    """An extrude line written as _extrude_text writes it, back into its
    options: ({"sketch", "op", "depth", "through", "flip", "both", "datum"},
    the depth's P key). A line in any other form raises ParamError.
    `datum_sketches`: the names of the sketches on a base plane (a cut's sign
    means the opposite on a face sketch and on a base plane)."""
    op = ("cut" if isinstance(stmt.op, ast.Sub) else "join") if isinstance(stmt, ast.AugAssign) else "new"
    bad = ParamError("this extrude isn't written the way the editor writes them: edit it in the code")
    kws = [k.arg for k in call.keywords]
    if len(call.args) != 1 or kws not in (["amount"], ["amount", "both"]):
        raise bad
    s = call.args[0]
    if not (isinstance(s, ast.Call) and isinstance(s.func, ast.Name) and s.func.id == "sketch"
            and len(s.args) == 1 and not s.keywords
            and isinstance(s.args[0], ast.Constant) and isinstance(s.args[0].value, str)):
        raise bad
    sketch = s.args[0].value
    kw = {k.arg: k.value for k in call.keywords}
    both = "both" in kw
    if both and not (isinstance(kw["both"], ast.Constant) and kw["both"].value is True):
        raise bad
    amt = kw["amount"]
    neg = isinstance(amt, ast.UnaryOp) and isinstance(amt.op, ast.USub)
    inner = amt.operand if neg else amt
    key = _p_key(inner)
    datum = both or sketch in datum_sketches
    through = False
    if key is not None:
        if both and neg:
            raise bad
    elif op == "cut" and not both and ast.unparse(inner) == _THROUGH:
        through = True
    elif op == "cut" and both and not neg and ast.unparse(inner) == _THROUGH_BOTH:
        through, both = True, False      # through both ways: implied by the base plane
    else:
        raise bad
    into = op == "cut" and not datum
    flip = False if both or (through and datum) else neg != into
    depth = pv.get(key) if key else None
    return ({"sketch": sketch, "op": op, "depth": depth, "through": through, "flip": flip,
             "both": both, "datum": datum}, key)


def _part_before(tree: ast.Module, line: int) -> bool:
    """Whether a statement before script line `line` makes `part`."""
    return any(n.lineno < line and (
        (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "part" for t in n.targets))
        or (isinstance(n, (ast.AnnAssign, ast.AugAssign)) and isinstance(n.target, ast.Name)
            and n.target.id == "part")) for n in tree.body)


def add_extrude(code: str, sketch: str, op: str, depth: float = 10.0,
                through: bool = False, flip: bool = False, datum: bool = False,
                both: bool = False, line: int | None = None) -> tuple[str, str | None]:
    """Append an extrude of sketch `sketch` to the script: op "cut" removes
    it from `part`, "join" adds it, "new" makes it the part (a script with no
    `part` yet). The depth becomes a new P key (unless `through`: a cut
    through the whole part).

    A face sketch's plane faces out of the part, so cuts go into the part and
    joins grow out of the face. A `datum` sketch (on a base plane: Top, Front,
    Right) has no outside: everything goes along the plane's normal, and a
    through cut goes both ways. `flip` reverses the direction; `both` extrudes
    the depth to each side of a base plane (symmetric) instead.

    With `line`, rewrite the extrude line there instead (its sketch stays):
    the depth goes in the line's own P key, a new one when it had none, and
    a key the line no longer uses is dropped. New is only for the line that
    makes the part first.

    Returns (code, the depth's param name or None)."""
    if op not in _EXTRUDE_SYM:
        raise ParamError(f"unknown extrude operation {op!r}")
    through = bool(through) and op == "cut"
    if not through and not float(depth) > 0:
        raise ParamError("the depth must be more than 0")
    tree = ast.parse(code)
    if line is None:
        if op == "new" and _assigns_part(tree):
            raise ParamError("the script already makes a part: Cut or Join this sketch instead")
        blank = not code.strip()
        key = None
        if not through:
            key = _unique(param_names(code), *_EXTRUDE_KEY[op])
            code = add_param(code, key, float(depth))
        text = _extrude_text(sketch, op, key, through, flip, datum, both)
        code = code.strip() if blank else code.rstrip("\n")
        gap = "\n\n" if op == "new" else "\n"
        return code + gap + text + "\n", key

    hit = _op_stmt(tree, line)
    if hit is None or hit[2] != "extrude":
        raise ParamError(f"line {line} is not an extrude line any more")
    stmt, call, _ = hit
    old, old_key = _read_extrude(stmt, call, _p_values(code), {sketch} if datum else set())
    before = _part_before(tree, stmt.lineno)
    if op == "new" and before:
        raise ParamError("New body is only for the first body: the part is made before this line")
    if op != "new" and not before:
        raise ParamError(f"there is no part before this line to {op} with: it can only be a New body")
    names = param_names(code)
    key = None
    if not through:
        key = old_key if old_key in names else None
        # an editor-named key follows the operation: cut1_depth → join1_height
        if key and old["op"] != op and re.fullmatch(r"{}\d+_{}".format(*_EXTRUDE_KEY[old["op"]]), key):
            key = None
        if key is None:
            key = _unique(names, *_EXTRUDE_KEY[op])
    code = _write_op(code, _extrude_text(old["sketch"], op, key, through, flip, datum, both), line, "extrude")
    if key:
        code = set_params(code, {key: float(depth)}) if key in names else add_param(code, key, float(depth))
    if old_key and old_key != key:
        code = drop_param(code, old_key)
    return code, key


# --- The operations: one script line each, written by the editor's dialogs (or
# the AI, in the same form) and read back (op_at) to reopen the dialog on it.
# Each has a reader (line → the dialog's values) and a writer (values → the
# line). Editing rewrites that line in place and sets the values of the P keys
# it uses; nothing else changes.

OPS = ("extrude", "shell", "holes", "fillet", "chamfer", "auto_round", "truss_windows")
# the P key base of each edge operation's size, and its argument
EDGE_OPS = {"fillet": ("fillet_r", "radius"), "chamfer": ("chamfer_d", "length")}


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


def _recognise(node):
    """(call, op) of an operation statement: `part = shell(...)` (holes,
    fillet, chamfer, auto_round, truss_windows, extrude: a new body) or
    `part -= / += extrude(...)`. Else None."""
    if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == "part" and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name) and node.value.func.id in OPS):
        return node.value, node.value.func.id
    if (isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and node.target.id == "part"
            and isinstance(node.op, (ast.Sub, ast.Add)) and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name) and node.value.func.id == "extrude"):
        return node.value, "extrude"
    return None


def _op_stmt(tree: ast.Module, line: int):
    """The top-level operation statement on script line `line` (1-based, any
    line it spans): (statement, call, op) or None."""
    for node in tree.body:
        if not (node.lineno <= line <= (node.end_lineno or node.lineno)):
            continue
        hit = _recognise(node)
        return (node, *hit) if hit else None
    return None


def op_lines(code: str) -> list[dict]:
    """Every operation line of the script: [{"op", "line", "end_line"}]."""
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


def _edge_refs(node) -> list[dict]:
    """fillet()/chamfer()'s edges: edges_ref([...]) (or edge_ref({...}))."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.args:
        if node.func.id == "edges_ref":
            refs = ast.literal_eval(node.args[0])
            if isinstance(refs, (list, tuple)) and all(isinstance(r, dict) for r in refs):
                return list(refs)
        elif node.func.id == "edge_ref":
            ref = ast.literal_eval(node.args[0])
            if isinstance(ref, dict):
                return [ref]
    raise ParamError(f"can't read the edges {ast.unparse(node)[:60]!r}: edit this line in the code")


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


def op_at(code: str, line: int, datum=()) -> dict:
    """The operation on script line `line`, for its dialog: {"op", "line",
    "end_line", "args", "params", "exprs"} where args holds the values (P keys
    resolved), params which P key holds each ("standoff.h" for a standoff's)
    and exprs the source of each value written as an expression (shown, not
    edited). `datum`: the names of the sketches on a base plane. A line not
    in the form the editor writes raises ParamError."""
    tree = ast.parse(code)
    hit = _op_stmt(tree, line)
    if hit is None:
        raise ParamError(f"line {line} is not an operation the editor reopens")
    stmt, call, op = hit
    pv = _p_values(code)
    args, params, exprs = _read_op(code, stmt, call, op, pv, datum)
    return {"op": op, "line": stmt.lineno, "end_line": stmt.end_lineno or stmt.lineno,
            "args": args, "params": {k: v for k, v in params.items() if v}, "exprs": exprs}


def _read_op(code: str, stmt, call, op: str, pv: dict, datum=()) -> tuple[dict, dict, dict]:
    """op_at's (args, params, exprs) of an operation statement in `code`."""
    kw = {k.arg: k.value for k in call.keywords if k.arg}
    args: dict = {}
    params: dict = {}
    exprs: dict = {}
    if op == "extrude":
        args, params["depth"] = _read_extrude(stmt, call, pv, set(datum))
    elif op in ARG_OPS:
        args, params, exprs = _read_args(code, op, call, pv)
    elif op in EDGE_OPS:
        _, arg = EDGE_OPS[op]
        edges = call.args[1] if len(call.args) > 1 else kw.get("edges")
        if edges is None:
            raise ParamError(f"line {stmt.lineno}: {op}() without edges: edit this line in the code")
        args["edges"] = _edge_refs(edges)
        size = call.args[2] if len(call.args) > 2 else kw.get(arg)
        if size is None:
            raise ParamError(f"line {stmt.lineno}: {op}() without a {arg}: edit this line in the code")
        args["size"], params["size"] = _value(size, pv)
    elif op == "shell":
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
    return args, params, exprs


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
    tail = _chars(lines[stmt.end_lineno - 1], stmt.end_col_offset)      # a comment after it stays
    lines[stmt.lineno - 1:stmt.end_lineno] = [lines[stmt.lineno - 1][:stmt.col_offset] + text
                                              + lines[stmt.end_lineno - 1][tail:]]
    return "\n".join(lines)


def _chars(row: str, col: int) -> int:
    """The character index in `row` of ast's UTF-8 byte offset `col`."""
    return len(row.encode()[:col].decode(errors="ignore"))


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


def add_edge_op(code: str, op: str, edges: list[dict], size: float,
                line: int | None = None) -> tuple[str, str]:
    """Append `part = fillet(part, edges_ref([...]), radius=P[...])` (or
    chamfer(..., length=P[...])) — or, with `line`, rewrite that line. The
    edges are edge refs (edge_ref.describe), one per edge: a loop is stored
    as its edges. The size lives in P (a new key, or the line's own).
    Returns (code, key)."""
    if op not in EDGE_OPS:
        raise ParamError(f"unknown edge operation {op!r}")
    base, arg = EDGE_OPS[op]
    if not _assigns_part(ast.parse(code)):
        raise ParamError(f"there is no part to {op} yet")
    if float(size) <= 0:
        raise ParamError(f"the {op} {arg} must be more than 0")
    if not edges:
        raise ParamError(f"select the edges to {op}")
    key = op_at(code, line)["params"].get("size") if line is not None else None
    names = param_names(code)
    key = key if key in names else _name(names, base)
    refs = ", ".join(_lit(r) for r in edges)
    text = f'part = {op}(part, edges_ref([{refs}]), {arg}=P["{key}"])'
    code = _write_op(code, text, line, op)
    code, key = _number(code, size, key, base, names)
    return code, key


def drop_param(code: str, key: str) -> str:
    """`code` without P's `key`, unless something still uses it (or its entry
    spans lines: then it is left)."""
    tree = ast.parse(code)
    if any(_p_key(n) == key for n in ast.walk(tree)):
        return code
    use = re.compile(rf"""\b(P|params)\[\s*["']{re.escape(key)}["']\s*\]""")
    if any(use.search(text) for _, _, text in _off_blocks(code)):     # a step switched off uses it
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


# --- auto_round and truss_windows: the AI writes them (Round, Lighten) and so can
# people. Their dialogs edit the arguments they know where they are: a
# P["key"] value sets P, a literal is rewritten in place, and every other
# argument stays exactly as written.

# each one's parameters in signature order, and those its dialog edits:
# {name: (kind, default, the P key a literal moved into P gets)}
ARG_OPS = {
    "auto_round": (
        ("part", "convex", "concave", "keep", "keep_bed", "protect_holes", "hole_max_r", "min_edge",
         "max_thickness_frac", "time_budget"),
        {"convex": ("num", 1.0, "round_r"), "concave": ("num", 2.0, "blend_r"),
         "keep": ("faces", None, None), "keep_bed": ("bool", True, None),
         "protect_holes": ("bool", True, None)}),
    "truss_windows": (
        ("part", "face", "rim", "rib", "anchors", "corner_r", "keep_clear", "pattern", "max_span",
         "keep", "keep_bed", "protect_holes", "hole_max_r", "min_wall"),
        {"rim": ("num", None, "truss_rim"), "rib": ("num", None, "truss_rib"),
         "corner_r": ("num", None, "truss_corner_r"), "keep_clear": ("num", 3.0, "truss_clear"),
         "pattern": ("choice", "fan", None)}),
}
PATTERNS = ("fan", "triangulate")
# these may be 0 (auto_round: leave that kind of edge sharp); the rest must be more
_ZERO_OK = {"convex", "concave", "keep_clear"}


def _call_args(call, sig) -> dict:
    """A call's argument nodes by parameter name."""
    out = {sig[i]: a for i, a in enumerate(call.args) if i < len(sig) and not isinstance(a, ast.Starred)}
    out.update({k.arg: k.value for k in call.keywords if k.arg})
    return out


def _keep_items(code: str, node) -> list[dict]:
    """A keep list: [{"src": the item as written, "ref": its face_ref's dict,
    or None for a selector}]."""
    out = []
    for it in node.elts:
        ref = None
        if isinstance(it, ast.Call) and isinstance(it.func, ast.Name) and it.func.id == "face_ref" and it.args:
            try:
                ref = ast.literal_eval(it.args[0])
            except ValueError:
                pass
        out.append({"src": ast.get_source_segment(code, it), "ref": ref if isinstance(ref, dict) else None})
    return out


def _read_args(code: str, op: str, call, pv: dict) -> tuple[dict, dict, dict]:
    sig, fields = ARG_OPS[op]
    nodes = _call_args(call, sig)
    args: dict = {}
    params: dict = {}
    exprs: dict = {}
    for f, (kind, default, _) in fields.items():
        node = nodes.get(f)
        if node is None:
            args[f] = [] if kind == "faces" else default
        elif kind == "faces":
            if isinstance(node, (ast.List, ast.Tuple)):
                args[f] = _keep_items(code, node)
            else:
                args[f], exprs[f] = None, ast.get_source_segment(code, node)
        elif _p_key(node) is not None and _p_key(node) in pv:
            args[f], params[f] = pv[_p_key(node)], _p_key(node)
        else:
            try:
                if _p_key(node) is not None:
                    raise ValueError
                args[f] = ast.literal_eval(node)
            except ValueError:
                args[f], exprs[f] = None, ast.get_source_segment(code, node)
    return args, params, exprs


def _coerce(f: str, kind: str, v):
    if kind == "bool":
        return bool(v)
    if kind == "choice":
        if v not in PATTERNS:
            raise ParamError(f"{f} must be one of {', '.join(PATTERNS)}, not {v!r}")
        return v
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise ParamError(f"{f} must be a number") from None
    if v < 0 or (v == 0 and f not in _ZERO_OK):
        raise ParamError(f"{f} must be more than 0")
    return v


def edit_args(code: str, line: int, op: str, values: dict | None = None, keep: list | None = None,
              make_param=()) -> tuple[str, list[str]]:
    """Rewrite the auto_round() / truss_windows() line on `line` with its
    dialog's `values` ({argument: value}), `keep` (auto_round's kept faces,
    each {"src": an item as written} or {"ref": a face_ref's dict}; None
    leaves them) and `make_param` (arguments written as literals to move
    into P, under a new key). An argument given as P["key"] sets that key;
    a literal is rewritten where it is, or added when it wasn't written and
    isn't the default; everything else stays as written. Returns (code, the
    new P keys)."""
    if op not in ARG_OPS:
        raise ParamError(f"{op}() has no dialog")
    tree = ast.parse(code)
    hit = _op_stmt(tree, line)
    if hit is None or hit[2] != op:
        raise ParamError(f"line {line} is not a {op}() line any more")
    _, call, _ = hit
    sig, fields = ARG_OPS[op]
    nodes = _call_args(call, sig)
    pv, names = _p_values(code), param_names(code)
    values = dict(values or {})
    rows = code.split("\n")
    starts = [0]
    for row in rows:
        starts.append(starts[-1] + len(row) + 1)

    def span(n) -> tuple[int, int]:
        return (starts[n.lineno - 1] + _chars(rows[n.lineno - 1], n.col_offset),
                starts[n.end_lineno - 1] + _chars(rows[n.end_lineno - 1], n.end_col_offset))

    edits: list[tuple[int, int, str]] = []
    adds: list[str] = []
    p_set: dict = {}
    p_new: list[tuple[str, float]] = []
    for f in [*values, *(m for m in make_param if m not in values)]:
        if f not in fields or fields[f][0] == "faces":
            raise ParamError(f"{op}() has no {f!r} its dialog edits")
        kind, default, base = fields[f]
        node = nodes.get(f)
        key = _p_key(node) if node is not None else None
        if key is not None:
            if key not in pv:
                raise ParamError(f'P["{key}"] is an expression: edit it in the code')
            if f in values and pv[key] != _coerce(f, kind, values[f]):
                p_set[key] = _coerce(f, kind, values[f])
            continue
        old = default
        if node is not None:
            try:
                old = ast.literal_eval(node)
            except ValueError:
                raise ParamError(f"{f} is written as an expression: edit it in the code") from None
        v = _coerce(f, kind, values[f] if f in values else old)
        if f in make_param:
            if kind != "num":
                raise ParamError(f"{f} can't be a parameter")
            k = _name(names, base)
            names.add(k)
            p_new.append((k, v))
            text = f'P["{k}"]'
        elif old == v:
            continue
        else:
            text = _lit(v)
        if node is not None:
            edits.append((*span(node), text))
        else:
            adds.append(f"{f}={text}")
    if keep is not None:
        if "keep" not in fields:
            raise ParamError(f"{op}() has no keep list its dialog edits")
        texts = []
        for it in keep:
            if it.get("src"):
                texts.append(it["src"])
            elif isinstance(it.get("ref"), dict):
                texts.append(f"face_ref({_lit(it['ref'])})")
            else:
                raise ParamError("a kept face needs its source or a face reference")
        node = nodes.get("keep")
        if node is None:
            if texts:
                adds.append(f"keep=[{', '.join(texts)}]")
        elif not isinstance(node, (ast.List, ast.Tuple)):
            raise ParamError("keep is written as an expression: edit it in the code")
        elif [ast.get_source_segment(code, e) for e in node.elts] != texts:
            edits.append((*span(node), f"[{', '.join(texts)}]"))
    if adds:
        last = max([*call.args, *call.keywords], key=lambda n: (n.end_lineno, n.end_col_offset), default=None)
        at = span(last)[1] if last is not None else span(call)[1] - 1
        edits.append((at, at, (", " if last is not None else "") + ", ".join(adds)))
    for a, b, text in sorted(edits, reverse=True):
        code = code[:a] + text + code[b:]
    if p_set:
        code = set_params(code, p_set)
    for k, v in p_new:
        code = add_param(code, k, v)
    return code, [k for k, _ in p_new]


# --- The steps list: the script's operations in order, each summed up in a few
# words. A step can be switched off (its lines commented out behind OFF, and
# put back exactly) or deleted (with the P keys only it used).

OFF = "# off: "


def _off_text(row: str) -> str | None:
    """A switched-off line's own text, else None."""
    if row.startswith(OFF):
        return row[len(OFF):]
    return "" if row.rstrip() == OFF.rstrip() else None


def _off_blocks(code: str) -> list[tuple[int, int, str]]:
    """The switched-off statements: [(first line, last line, its text)],
    one per statement (a run of off lines is split where a statement ends)."""
    rows = code.split("\n")
    out = []
    i = 0
    while i < len(rows):
        if _off_text(rows[i]) is None:
            i += 1
            continue
        j, body = i, []
        while j < len(rows) and _off_text(rows[j]) is not None:
            body.append(_off_text(rows[j]))
            j += 1
            try:
                ast.parse("\n".join(body))
                break
            except SyntaxError:
                continue
        out.append((i + 1, j, "\n".join(body)))
        i = j
    return out


def _mm(v) -> str:
    try:
        return f"{round(float(v), 3):g} mm"
    except (TypeError, ValueError):
        return "?"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


TITLES = {"extrude": "Extrude", "shell": "Shell", "holes": "Holes", "fillet": "Fillet", "chamfer": "Chamfer",
          "auto_round": "Round", "truss_windows": "Lighten"}
_EXTRUDE_TITLES = {"cut": "Cut", "join": "Join", "new": "New body"}


def _summary(op: str, a: dict, points: dict) -> str:
    if op == "extrude":
        how = "through all" if a["through"] else _mm(a["depth"])
        return (f"{_EXTRUDE_TITLES[a['op']]} {a['sketch']!r} {how}" + (" both ways" if a["both"] else "")
                + (" · flipped" if a["flip"] else ""))
    if op == "shell":
        opens = [str(r.get("hint") or "face").removesuffix(" face") for r in a["remove"]]
        where = f"{', '.join(opens)} open" if opens else "closed"
        return f"Shell {_mm(a['thickness'])}, {where}" + ("" if a["inside"] else " · walls outward")
    if op in EDGE_OPS:
        return f"{TITLES[op]} {_mm(a['size'])} · {_plural(len(a['edges']), 'edge')}"
    if op == "holes":
        at = a["at"] or {}
        n = points.get(at["sketch"]) if "sketch" in at else 1 if "face" in at else None
        return (f"Holes {a['size']} {a['kind']}" + (f" ×{n}" if n else "")
                + (" + standoffs" if a["standoff"] else ""))
    if op == "auto_round":
        def r(f):
            return _mm(a[f]) if a[f] is not None else "?"
        kept = f" · {len(a['keep'])} kept" if a["keep"] else ""
        return f"Round {r('convex')}, blends {r('concave')}{kept}"
    def t(f):
        return _mm(a[f]) if a[f] is not None else "?"
    return f"Lighten: rim {t('rim')}, rib {t('rib')}, {a['pattern'] or '?'}"


def _variant(stmt) -> str | None:
    if isinstance(stmt, ast.AugAssign):
        return "cut" if isinstance(stmt.op, ast.Sub) else "join"
    return "new" if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Call) \
        and getattr(stmt.value.func, "id", None) == "extrude" else None


def _op_step(code: str, stmt, call, op: str, pv: dict, datum, points: dict, shift: int, off: bool) -> dict:
    step = {"kind": "op", "op": op, "variant": _variant(stmt), "line": stmt.lineno + shift,
            "end_line": (stmt.end_lineno or stmt.lineno) + shift, "off": off, "reopenable": False,
            "sketch": None, "faces": [], "edges": []}
    try:
        a, _, _ = _read_op(code, stmt, call, op, pv, datum)
    except (ValueError, KeyError, TypeError, SyntaxError):
        title = _EXTRUDE_TITLES.get(step["variant"] or "", TITLES[op])
        step["summary"] = f"{title} · written in code"
        return step
    step["summary"] = _summary(op, a, points)
    step["reopenable"] = not off
    if op == "extrude":
        step["sketch"] = a["sketch"]
    elif op == "shell":
        step["faces"] = a["remove"]
    elif op in EDGE_OPS:
        step["edges"] = a["edges"]
    elif op == "holes":
        at = a["at"] or {}
        step["sketch"] = at.get("sketch")
        step["faces"] = [at["face"]] if "face" in at else []
    elif op == "auto_round":
        step["faces"] = [k["ref"] for k in a["keep"] or [] if k["ref"]]
    return step


def steps(code: str, datum=(), points: dict | None = None) -> list[dict]:
    """The steps list: every operation of the script in order, switched off
    or not, as {"kind": "op", "op", "variant" (an extrude's cut / join /
    new), "line", "end_line", "summary", "reopenable", "off", "sketch",
    "faces", "edges" (what it works on, to show)}, and each run of other
    statements as {"kind": "script", "line", "end_line", "count"} (the
    imports and P left out). `datum`: the sketches on a base plane; `points`:
    each sketch's number of hole points."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    points = points or {}
    pv = _p_values(code)
    p_node = _params_assignment(tree)
    raw = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)) or (isinstance(node, ast.Assign) and node.value is p_node):
            continue
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            continue       # a docstring
        hit = _recognise(node)
        if hit:
            raw.append(_op_step(code, node, *hit, pv, datum, points, 0, False))
        else:
            raw.append({"kind": "script", "line": node.lineno, "end_line": node.end_lineno or node.lineno, "off": False})
    for a, b, text in _off_blocks(code):
        try:
            sub = ast.parse(text).body
        except SyntaxError:
            sub = []
        hit = _recognise(sub[0]) if len(sub) == 1 else None
        if hit:
            raw.append(_op_step(text, sub[0], *hit, pv, datum, points, a - 1, True))
        else:
            raw.append({"kind": "op", "op": "script", "variant": None, "line": a, "end_line": b, "off": True,
                        "reopenable": False, "summary": "Script", "sketch": None, "faces": [], "edges": []})
    raw.sort(key=lambda st: st["line"])
    out: list[dict] = []
    for st in raw:
        n = st["end_line"] - st["line"] + 1
        if st["kind"] == "script" and out and out[-1]["kind"] == "script":
            out[-1]["end_line"] = st["end_line"]
            out[-1]["count"] += n
        elif st["kind"] == "script":
            out.append({**st, "count": n})
        else:
            out.append(st)
    return out


def suppress(code: str, line: int, off: bool = True) -> str:
    """Switch the step on `line` off (each of its lines behind OFF) or back
    on (exactly as it was)."""
    rows = code.split("\n")
    if off:
        node = next((n for n in ast.parse(code).body if n.lineno <= line <= (n.end_lineno or n.lineno)), None)
        if node is None:
            raise ParamError(f"line {line} has no step to switch off")
        for i in range(node.lineno - 1, node.end_lineno or node.lineno):
            rows[i] = OFF + rows[i]
        return "\n".join(rows)
    block = next(((a, b) for a, b, _ in _off_blocks(code) if a <= line <= b), None)
    if block is None:
        raise ParamError(f"line {line} is not switched off")
    for i in range(block[0] - 1, block[1]):
        rows[i] = _off_text(rows[i])
    return "\n".join(rows)


def delete_step(code: str, line: int) -> str:
    """The script without the step on `line` (switched off or not), and
    without the P keys only it used."""
    rows = code.split("\n")
    block = next(((a, b, text) for a, b, text in _off_blocks(code) if a <= line <= b), None)
    if block is not None:
        a, b, text = block
        keys = set(re.findall(r"""\b(?:P|params)\[\s*["']([^"']+)["']\s*\]""", text))
    else:
        node = next((n for n in ast.parse(code).body if n.lineno <= line <= (n.end_lineno or n.lineno)), None)
        if node is None:
            raise ParamError(f"line {line} has no step to delete")
        a, b = node.lineno, node.end_lineno or node.lineno
        keys = {k for k in map(_p_key, ast.walk(node)) if k}
    del rows[a - 1:b]
    code = "\n".join(rows)
    for k in sorted(keys):
        code = drop_param(code, k)
    return code
