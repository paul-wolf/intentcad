"""Change values in a script's `params`/`P` dict, in place, preserving the rest.

Pure text/AST — no code execution. We locate each target key's value node in the
`P = dict(...)` (or `P = {...}`) assignment and replace just that value's source
span, so comments, formatting, and everything else are untouched.
"""

from __future__ import annotations

import ast
import functools
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
    return _renumber_skips(code, "\n".join(lines))


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


# A shared sketch (modeling/shared_sketch.py) in an extrude or revolve line, in
# place of sketch("name"):
#     SK["frame"]   SK["frame"].group("arm holes")   SK["frame"].named("outline")
# each maybe placed elsewhere with .on(face_ref({...})), .on(PLANES["Mid"]) or
# .on(Plane.XZ). The dialogs carry it as this source text where a face sketch
# has its name.

_BASE_PLANES = ("XY", "XZ", "YZ")


def is_shared_src(sketch: str) -> bool:
    return isinstance(sketch, str) and sketch.startswith("SK[")


def _shared_parts(node) -> dict | None:
    """An SK expression written as above → {"alias", "pick": (kind, name) or
    None, "on": the .on() argument's source or None}; anything else → None."""
    on = None
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "on"
            and len(node.args) == 1 and not node.keywords):
        a = node.args[0]
        if isinstance(a, ast.Call) and isinstance(a.func, ast.Name) and a.func.id == "face_ref":
            try:
                on = f"face_ref({_lit(_ref_arg(a, 'face_ref', 'face to put the sketch on'))})"
            except (ParamError, ValueError):
                return None
        elif (isinstance(a, ast.Subscript) and isinstance(a.value, ast.Name) and a.value.id == "PLANES"
              and isinstance(a.slice, ast.Constant) and isinstance(a.slice.value, str)):
            on = f"PLANES[{json.dumps(a.slice.value)}]"
        elif (isinstance(a, ast.Attribute) and isinstance(a.value, ast.Name) and a.value.id == "Plane"
              and a.attr in _BASE_PLANES):
            on = f"Plane.{a.attr}"
        else:
            return None
        node = node.func.value
    pick = None
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("group", "named")
            and len(node.args) == 1 and not node.keywords
            and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
        pick = (node.func.attr, node.args[0].value)
        node = node.func.value
    if not (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == "SK"
            and isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str)):
        return None
    return {"alias": node.slice.value, "pick": pick, "on": on}


def _shared_text(p: dict) -> str:
    out = f"SK[{json.dumps(p['alias'])}]"
    if p["pick"]:
        out += f".{p['pick'][0]}({json.dumps(p['pick'][1])})"
    if p["on"]:
        out += f".on({p['on']})"
    return out


def _shared_src(sketch: str) -> dict:
    try:
        node = ast.parse(sketch.strip(), mode="eval").body
    except SyntaxError:
        node = None
    p = _shared_parts(node) if node is not None else None
    if p is None:
        raise ParamError(f"{sketch[:60]!r} is not a shared sketch the editor writes "
                         '(SK["name"], with .group("…") / .named("…") and .on(…) after it)')
    return p


def _sketch_src(sketch: str) -> str:
    """The source of an operation's sketch: sketch("name"), or a shared
    sketch's SK[...] written the editor's way."""
    return _shared_text(_shared_src(sketch)) if is_shared_src(sketch) else f"sketch({json.dumps(sketch)})"


def _read_sketch_arg(node) -> str | None:
    """An operation's sketch argument back into its name or SK source, else None."""
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "sketch"
            and len(node.args) == 1 and not node.keywords
            and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
        return node.args[0].value
    p = _shared_parts(node)
    return _shared_text(p) if p else None


def _shared_datum(sketch: str) -> bool:
    """A shared sketch on its own plane or a construction plane has no
    outside (like a base-plane sketch); on a part's face it faces out of it."""
    return _shared_src(sketch)["on"] is None or not _shared_src(sketch)["on"].startswith("face_ref(")


def _keep_sketch(old: str, new: str) -> str:
    """A reopened line keeps its sketch, but a shared sketch may move (.on)
    or pick another group of the same SK sketch."""
    if is_shared_src(old) and is_shared_src(new) and _shared_src(old)["alias"] == _shared_src(new)["alias"]:
        return _shared_text(_shared_src(new))
    return old


EXTENTS = ("distance", "through", "next", "face")


def _extrude_text(sketch: str, op: str, key: str | None, through: bool, flip: bool,
                  datum: bool, both: bool, until: str | None = None, offset_src: str | None = None) -> str:
    """The script line of an extrude (add_extrude's doc says what each option
    does); `key` is the P key of its depth (None for a through cut or an
    until extrude). `until`: the source of its end, '"next"' or
    'face_ref({...})', with `offset_src` the offset's source (None: none)."""
    into = op == "cut" and not datum      # negative amount: into the part
    sign = "-" if into != flip else ""
    head = f"part {_EXTRUDE_SYM[op]} extrude({_sketch_src(sketch)}, "
    if until is not None:
        offset = f", offset={offset_src}" if offset_src else ""
        return head + f"until={until}{offset}" + (", dir=-1" if sign else "") + ")"
    if op == "cut" and through:
        amount = f"{_THROUGH_BOTH}, both=True" if datum else f"{sign}{_THROUGH}"
    else:
        amount = f'P["{key}"], both=True' if both and datum else f'{sign}P["{key}"]'
    return head + f"amount={amount})"


def _read_extrude(stmt, call, pv: dict, datum_sketches) -> tuple[dict, str | None, dict]:
    """An extrude line written as _extrude_text writes it, back into its
    options: ({"sketch", "op", "extent", "depth", "through", "flip", "both",
    "datum", "face", "offset"}, the depth's P key, exprs). "extent" is
    "distance", "through", "next" (until="next") or "face" (until=face_ref:
    "face" is its ref); "offset" the until offset (exprs["offset"] when it
    is an expression). A line in any other form raises ParamError.
    `datum_sketches`: the names of the sketches on a base plane (a cut's sign
    means the opposite on a face sketch and on a base plane)."""
    op = ("cut" if isinstance(stmt.op, ast.Sub) else "join") if isinstance(stmt, ast.AugAssign) else "new"
    bad = ParamError("this extrude isn't written the way the editor writes them: edit it in the code")
    kws = [k.arg for k in call.keywords]
    until = "until" in kws
    if len(call.args) != 1 or len(set(kws)) != len(kws) or not (
            set(kws) <= {"until", "offset", "dir"} if until else kws in (["amount"], ["amount", "both"])):
        raise bad
    sketch = _read_sketch_arg(call.args[0])
    if sketch is None:
        raise bad
    kw = {k.arg: k.value for k in call.keywords}
    datum = _shared_datum(sketch) if is_shared_src(sketch) else sketch in datum_sketches
    exprs: dict = {}
    if until:
        u = kw["until"]
        face = None
        if isinstance(u, ast.Constant) and u.value == "next":
            extent = "next"
        elif isinstance(u, ast.Call) and isinstance(u.func, ast.Name) and u.func.id == "face_ref":
            extent, face = "face", _ref_arg(u, "face_ref", "face to extrude up to")
        else:
            raise bad
        offset = 0.0
        if "offset" in kw:
            offset, e = _read_amount(kw["offset"], pv)
            if e is not None:
                exprs["offset"] = e
        d = kw.get("dir")
        neg = False
        if d is not None:
            try:
                dv = ast.literal_eval(d)
            except ValueError:
                raise bad from None
            if dv not in (1, -1) or isinstance(dv, bool):
                raise bad
            neg = dv == -1
        into = op == "cut" and not datum
        return ({"sketch": sketch, "op": op, "extent": extent, "depth": None, "through": False,
                 "flip": neg != into, "both": False, "datum": datum, "face": face, "offset": offset},
                None, exprs)
    both = "both" in kw
    if both and not (isinstance(kw["both"], ast.Constant) and kw["both"].value is True):
        raise bad
    amt = kw["amount"]
    neg = isinstance(amt, ast.UnaryOp) and isinstance(amt.op, ast.USub)
    inner = amt.operand if neg else amt
    key = _p_key(inner)
    datum = both or datum
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
    return ({"sketch": sketch, "op": op, "extent": "through" if through else "distance", "depth": depth,
             "through": through, "flip": flip, "both": both, "datum": datum, "face": None, "offset": 0.0},
            key, exprs)


def _part_before(tree: ast.Module, line: int) -> bool:
    """Whether a statement before script line `line` makes `part`."""
    return any(n.lineno < line and (
        (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "part" for t in n.targets))
        or (isinstance(n, (ast.AnnAssign, ast.AugAssign)) and isinstance(n.target, ast.Name)
            and n.target.id == "part")) for n in tree.body)


def add_extrude(code: str, sketch: str, op: str, depth: float = 10.0,
                through: bool = False, flip: bool = False, datum: bool = False,
                both: bool = False, line: int | None = None, extent: str | None = None,
                face: dict | None = None, offset=0.0, key: str | None = None) -> tuple[str, str | None]:
    """Append an extrude of sketch `sketch` to the script: op "cut" removes
    it from `part`, "join" adds it, "new" makes it the part (a script with no
    `part` yet). The depth becomes a new P key (unless `through`: a cut
    through the whole part).

    A face sketch's plane faces out of the part, so cuts go into the part and
    joins grow out of the face. A `datum` sketch (on a base plane: Top, Front,
    Right) has no outside: everything goes along the plane's normal, and a
    through cut goes both ways. `flip` reverses the direction; `both` extrudes
    the depth to each side of a base plane (symmetric) instead.

    `extent` (default: "through" when `through`, else "distance") may also be
    "next" (until="next": up to the first face it meets, modeling/until.py)
    or "face" (until=face_ref(`face`): up to that face's surface, `offset`
    past it — a number or an expression of P names, negative: short of it).
    Neither goes both ways or makes the first body; their direction follows
    the same sign logic as a depth's (written as dir=-1).

    With `line`, rewrite the extrude line there instead (its sketch stays):
    the depth goes in the line's own P key, a new one when it had none, and
    a key the line no longer uses is dropped — except when it becomes an
    until extrude: the depth stays in P, and `key` (the depth key the dialog
    remembers) takes it back when it is switched back to a distance. New is
    only for the line that makes the part first.

    Returns (code, the depth's param name or None; for an until extrude the
    depth key kept in P, if any)."""
    if op not in _EXTRUDE_SYM:
        raise ParamError(f"unknown extrude operation {op!r}")
    if is_shared_src(sketch):
        datum = _shared_datum(sketch)
    extent = extent or ("through" if through else "distance")
    if extent not in EXTENTS:
        raise ParamError(f"unknown extrude extent {extent!r}")
    if extent == "through" and op != "cut":
        extent = "distance"
    through = extent == "through"
    until = None
    if extent in ("next", "face"):
        if op == "new":
            raise ParamError("Up to next / Up to face needs a part to reach: Cut or Join this sketch instead")
        if extent == "face" and not (isinstance(face, dict) and face):
            raise ParamError("pick the face to extrude up to")
        until = '"next"' if extent == "next" else f"face_ref({_lit(face)})"
        both = False
    elif not through and not float(depth) > 0:
        raise ParamError("the depth must be more than 0")
    names = param_names(code)
    offset_src = None
    if extent == "face" and offset not in (None, "", 0, 0.0):
        offset_src = _write_amount(offset, names, "offset")
        if offset_src in ("0.0", "-0.0"):
            offset_src = None
    tree = ast.parse(code)
    if line is None:
        if op == "new" and _assigns_part(tree):
            raise ParamError("the script already makes a part: Cut or Join this sketch instead")
        blank = not code.strip()
        new_key = None
        if extent == "distance":
            new_key = _unique(names, *_EXTRUDE_KEY[op])
            code = add_param(code, new_key, float(depth))
        text = _extrude_text(sketch, op, new_key, through, flip, datum, both, until, offset_src)
        code = code.strip() if blank else code.rstrip("\n")
        gap = "\n\n" if op == "new" else "\n"
        return code + gap + text + "\n", new_key

    hit = _op_stmt(tree, line)
    if hit is None or hit[2] != "extrude":
        raise ParamError(f"line {line} is not an extrude line any more")
    stmt, call, _ = hit
    old, old_key, _ = _read_extrude(stmt, call, _p_values(code), {sketch} if datum else set())
    before = _part_before(tree, stmt.lineno)
    if op == "new" and before:
        raise ParamError("New body is only for the first body: the part is made before this line")
    if op != "new" and not before:
        raise ParamError(f"there is no part before this line to {op} with: it can only be a New body")
    old_key = old_key or (key if key in names else None)     # a depth kept while it was an until extrude
    sk = _keep_sketch(old["sketch"], sketch)
    if is_shared_src(sk):
        datum = _shared_datum(sk)
    if until is not None:          # the old depth stays in P, for switching back
        code = _write_op(code, _extrude_text(sk, op, None, False, flip, datum, False, until, offset_src),
                         line, "extrude")
        return code, old_key
    new_key = None
    if not through:
        new_key = old_key if old_key in names else None
        # an editor-named key follows the operation: cut1_depth → join1_height
        if new_key and old["op"] != op and re.fullmatch(r"{}\d+_{}".format(*_EXTRUDE_KEY[old["op"]]), new_key):
            new_key = None
        if new_key is None:
            new_key = _unique(names, *_EXTRUDE_KEY[op])
    code = _write_op(code, _extrude_text(sk, op, new_key, through, flip, datum, both), line, "extrude")
    if new_key:
        code = set_params(code, {new_key: float(depth)}) if new_key in names else add_param(code, new_key, float(depth))
    if old_key and old_key != new_key:
        code = drop_param(code, old_key)
    return code, new_key


# --- Revolve: a sketch's closed shapes turned around an axis (modeling/revolve.py)
#     part += revolve(sketch("Knob"), axis=sketch_line("Knob", "axis-v"), angle=360)
#     part -= revolve(sketch("Groove"), axis=face_ref({...}), angle=P["groove_arc"], both=True, flip=True)
# The axis is, in the API's form, {"line": id} (a line of the same sketch),
# {"base": "X"}, {"edge": ref} or {"face": ref} (a cylinder's centre line).

_AXIS_WORDS = {"axis-h": "H axis", "axis-v": "V axis", "axis-fh": "face H axis", "axis-fv": "face V axis"}


def revolve_axis_label(axis: dict | None) -> str:
    """A revolve axis in a few words: "V axis", "line l3", "X axis", the edge's or cylinder's hint."""
    if not axis:
        return "?"
    if axis.get("line"):
        return _AXIS_WORDS.get(axis["line"], f"line {axis['line']}")
    if axis.get("base"):
        return f"{axis['base']} axis"
    ref = axis.get("edge") or axis.get("face") or {}
    return str(ref.get("hint") or ("edge" if "edge" in axis else "cylinder axis"))


def _revolve_axis_src(sketch: str, axis) -> str:
    if isinstance(axis, dict) and axis.get("line"):
        if is_shared_src(sketch):     # a line of the shared sketch, on its (moved) plane
            return f"{_sketch_src(sketch)}.line({json.dumps(str(axis['line']))})"
        return f"sketch_line({json.dumps(sketch)}, {json.dumps(str(axis['line']))})"
    if isinstance(axis, dict) and not any(axis.get(k) for k in ("base", "edge", "face")):
        raise ParamError("pick an axis: a line of the sketch, a straight edge, a cylinder, or X, Y, Z")
    return _dir_src(axis, "revolve axis")


def _revolve_text(sketch: str, op: str, axis_src: str, angle_src: str, both: bool, flip: bool) -> str:
    return (f"part {_EXTRUDE_SYM[op]} revolve({_sketch_src(sketch)}, axis={axis_src}, angle={angle_src}"
            + (", both=True" if both else "") + (", flip=True" if flip else "") + ")")


def _read_revolve(stmt, call, pv: dict) -> tuple[dict, dict]:
    """A revolve line written as _revolve_text writes it, back into (args
    {"sketch", "op", "axis", "angle", "both", "flip"}, exprs: the angle's
    expression when it is one). Any other form raises ParamError."""
    op = ("cut" if isinstance(stmt.op, ast.Sub) else "join") if isinstance(stmt, ast.AugAssign) else "new"
    bad = ParamError("this revolve isn't written the way the editor writes them: edit it in the code")
    kw = {k.arg: k.value for k in call.keywords}
    if len(call.args) != 1 or None in kw or not {"axis", "angle"} <= kw.keys() <= {"axis", "angle", "both", "flip"}:
        raise bad
    sketch = _read_sketch_arg(call.args[0])
    if sketch is None:
        raise bad
    ax = kw["axis"]
    if (is_shared_src(sketch) and isinstance(ax, ast.Call) and isinstance(ax.func, ast.Attribute)
            and ax.func.attr == "line"):
        if not (len(ax.args) == 1 and not ax.keywords and isinstance(ax.args[0], ast.Constant)
                and isinstance(ax.args[0].value, str) and _read_sketch_arg(ax.func.value) == sketch):
            raise bad
        axis = {"line": ax.args[0].value}
    elif isinstance(ax, ast.Call) and isinstance(ax.func, ast.Name) and ax.func.id == "sketch_line":
        if not (len(ax.args) == 2 and not ax.keywords
                and all(isinstance(a, ast.Constant) and isinstance(a.value, str) for a in ax.args)
                and ax.args[0].value == sketch):
            raise bad
        axis = {"line": ax.args[1].value}
    else:
        axis = _dir_arg(ax, "revolve axis")
    flags = {}
    for k in ("both", "flip"):
        if k in kw and not (isinstance(kw[k], ast.Constant) and isinstance(kw[k].value, bool)):
            raise bad
        flags[k] = bool(kw[k].value) if k in kw else False
    angle, expr = _read_amount(kw["angle"], pv)
    return ({"sketch": sketch, "op": op, "axis": axis, "angle": angle, **flags},
            {"angle": expr} if expr is not None else {})


def add_revolve(code: str, sketch: str, op: str, axis, angle=360, both: bool = False,
                flip: bool = False, line: int | None = None) -> str:
    """Append a revolve of sketch `sketch` about `axis` to the script: op
    "cut" removes it from `part`, "join" adds it, "new" makes it the part (a
    script with no `part` yet). `angle` (degrees, at most 360) is a number or
    an expression of P names; `both` spreads it evenly either side of the
    sketch plane, `flip` turns the other way.

    With `line`, rewrite the revolve line there instead (its sketch stays).
    New is only for the line that makes the part first."""
    if op not in _EXTRUDE_SYM:
        raise ParamError(f"unknown revolve operation {op!r}")
    if isinstance(angle, (int, float)) and not isinstance(angle, bool) and not 0 < float(angle) <= 360:
        raise ParamError("the angle must be more than 0° and at most 360°")
    angle_src = _write_amount(angle, param_names(code), "angle")
    tree = ast.parse(code)
    if line is None:
        if op == "new" and _assigns_part(tree):
            raise ParamError("the script already makes a part: Cut or Join this sketch instead")
        text = _revolve_text(sketch, op, _revolve_axis_src(sketch, axis), angle_src, both, flip)
        if not code.strip():
            return text + "\n"
        return code.rstrip("\n") + ("\n\n" if op == "new" else "\n") + text + "\n"
    hit = _op_stmt(tree, line)
    if hit is None or hit[2] != "revolve":
        raise ParamError(f"line {line} is not a revolve line any more")
    stmt, call, _ = hit
    old, _ = _read_revolve(stmt, call, _p_values(code))
    before = _part_before(tree, stmt.lineno)
    if op == "new" and before:
        raise ParamError("New body is only for the first body: the part is made before this line")
    if op != "new" and not before:
        raise ParamError(f"there is no part before this line to {op} with: it can only be a New body")
    sk = _keep_sketch(old["sketch"], sketch)
    text = _revolve_text(sk, op, _revolve_axis_src(sk, axis), angle_src, both, flip)
    return _write_op(code, text, line, "revolve")


# --- The operations: one script line each, written by the editor's dialogs (or
# the AI, in the same form) and read back (op_at) to reopen the dialog on it.
# Each has a reader (line → the dialog's values) and a writer (values → the
# line). Editing rewrites that line in place and sets the values of the P keys
# it uses; nothing else changes.

OPS = ("extrude", "revolve", "shell", "holes", "fillet", "chamfer", "auto_round", "truss_windows", "mirror_body",
       "pattern_body")
# the operations that make a solid from a sketch: part = / += / -= op(sketch(...), ...)
SKETCH_OPS = ("extrude", "revolve")
# construction planes: PLANES["name"] = offset_plane(...) / edge_plane(...) / tangent_plane(...)
PLANE_OPS = ("offset_plane", "edge_plane", "tangent_plane")
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
    fillet, chamfer, auto_round, truss_windows, mirror_body, extrude: a new
    body), `part -= / += extrude(...)` (or its mirrored copy, `part -=
    mirrored(extrude(...), PLANE)`: the call is the extrude) or a construction plane,
    `PLANES["name"] = offset_plane(...) / edge_plane(...) / tangent_plane(...)`. Else None."""
    if _plane_name(node) is not None and isinstance(node.value, ast.Call) \
            and isinstance(node.value.func, ast.Name) and node.value.func.id in PLANE_OPS:
        return node.value, node.value.func.id
    if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == "part" and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name) and node.value.func.id in OPS):
        return node.value, node.value.func.id
    if (isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and node.target.id == "part"
            and isinstance(node.op, (ast.Sub, ast.Add)) and isinstance(node.value, ast.Call)):
        value = node.value.args[0] if _is_copy(node.value) else node.value    # a mirrored / patterned copy
        if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id in SKETCH_OPS:
            return value, value.func.id
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
    """fillet()/chamfer()'s edges: edges_ref([...]) (or edge_ref({...})), or
    a mirrored copy's mirrored(edges_ref([...]), PLANE)."""
    if _is_copy(node):
        node = node.args[0]
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
    """holes(at=...): {"sketch": name} or {"face": ref} (of a mirrored
    copy's mirrored(..., PLANE) too)."""
    if _is_copy(node):
        node = node.args[0]
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
    edited). `datum`: the names of the sketches on a base plane. A mirrored
    copy also has "mirror": {"plane", "label", "of": the line of the step it
    is linked to, None when unlinked}. A line not in the form the editor
    writes raises ParamError."""
    tree = ast.parse(code)
    hit = _op_stmt(tree, line)
    if hit is None:
        raise ParamError(f"line {line} is not an operation the editor reopens")
    stmt, call, op = hit
    pv = _p_values(code)
    args, params, exprs = _read_op(code, stmt, call, op, pv, datum)
    out = {"op": op, "line": stmt.lineno, "end_line": stmt.end_lineno or stmt.lineno,
           "args": args, "params": {k: v for k, v in params.items() if v}, "exprs": exprs}
    wrap = _copy_node(stmt, call, op)
    if wrap is not None and wrap.func.id == "mirrored":
        plane = _mirror_plane_arg(wrap.args[1])
        link = _links(code).get(stmt.lineno)
        out["mirror"] = {"plane": plane, "label": plane_label(plane), "of": link["of"] if link else None}
    elif wrap is not None:
        pat, pparams, pexprs = _read_pattern(wrap.args[1], pv)
        link = _links(code).get(stmt.lineno)
        out["pattern"] = {"args": pat, "params": pparams, "exprs": pexprs, "label": pattern_label(pat),
                          "of": link["of"] if link else None,
                          "lines": _pattern_group(code, stmt.lineno)}
    return out


def _read_op(code: str, stmt, call, op: str, pv: dict, datum=()) -> tuple[dict, dict, dict]:
    """op_at's (args, params, exprs) of an operation statement in `code`."""
    kw = {k.arg: k.value for k in call.keywords if k.arg}
    args: dict = {}
    params: dict = {}
    exprs: dict = {}
    if op == "extrude":
        args, params["depth"], exprs = _read_extrude(stmt, call, pv, set(datum))
    elif op == "revolve":
        args, exprs = _read_revolve(stmt, call, pv)
    elif op in PLANE_OPS:
        args, exprs = _read_plane(stmt, call, op, pv)
    elif op == "mirror_body":
        plane = call.args[1] if len(call.args) > 1 else kw.get("plane")
        if plane is None:
            raise ParamError(f"line {stmt.lineno}: mirror_body() without a plane: edit this line in the code")
        args["plane"] = _mirror_plane_arg(plane)
        join = call.args[2] if len(call.args) > 2 else kw.get("join")
        args["join"] = True if join is None else bool(_value(join, pv)[0])
        gap = call.args[3] if len(call.args) > 3 else kw.get("gap")
        args["gap"], e = _read_amount(gap, pv) if gap is not None else (0.0, None)
        if e is not None:
            exprs["gap"] = e
    elif op == "pattern_body":
        pat = call.args[1] if len(call.args) > 1 else kw.get("pattern")
        if pat is None:
            raise ParamError(f"line {stmt.lineno}: pattern_body() without a pattern: edit this line in the code")
        args["pattern"], params, exprs = _read_pattern(pat, pv)
        join = call.args[2] if len(call.args) > 2 else kw.get("join")
        args["join"] = True if join is None else bool(_value(join, pv)[0])
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
    on `line`. A mirrored copy written there stays mirrored; the copies
    linked to the step there are written again from it (_copy_text)."""
    if line is None:
        return code.rstrip("\n") + "\n" + text + "\n"
    hit = _op_stmt(ast.parse(code), line)
    if hit is None or hit[2] != op:
        raise ParamError(f"line {line} is not a {op}() line any more")
    stmt, call, _ = hit
    wrap = _copy_node(stmt, call, op)
    copies: list[int] = []
    if wrap is not None:
        text = _copy_text(text, op, ast.get_source_segment(code, wrap.args[1]), wrap.func.id)
    elif op in MIRROR_OPS:
        copies = sorted((c for c, link in _links(code).items() if link["of"] == stmt.lineno), reverse=True)
    lines = code.split("\n")
    tail = _chars(lines[stmt.end_lineno - 1], stmt.end_col_offset)      # a comment after it stays
    lines[stmt.lineno - 1:stmt.end_lineno] = [lines[stmt.lineno - 1][:stmt.col_offset] + text
                                              + lines[stmt.end_lineno - 1][tail:]]
    code = "\n".join(lines)
    shift = text.count("\n") - (stmt.end_lineno - stmt.lineno)
    for c in copies:
        code = _rewrite_copy(code, c + shift, text, op)
    return code


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


# --- Construction planes (modeling/planes.py): one line each,
#     PLANES["Lid"] = offset_plane(face_ref({...}), distance=P["lid_gap"])
#     PLANES["Cam"] = edge_plane(edge_ref({...}), angle=30, from_face=face_ref({...}))
#     PLANES["Set screw"] = tangent_plane(face_ref({...}), angle=P["screw_angle"], ref="X")
# A distance or angle is a number, or an expression of P names that the
# dialog shows and takes with bare names ("-width / 2") and the line holds
# as Python ('-P["width"] / 2').

_EXPR_NODES = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Name, ast.Load,
               ast.Add, ast.Sub, ast.Mult, ast.Div, ast.USub, ast.UAdd, ast.Pow, ast.Mod, ast.FloorDiv)


def _plane_name(node) -> str | None:
    """The name of a `PLANES["name"] = ...` statement, else None."""
    if not (isinstance(node, ast.Assign) and len(node.targets) == 1):
        return None
    t = node.targets[0]
    if (isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == "PLANES"
            and isinstance(t.slice, ast.Constant) and isinstance(t.slice.value, str)):
        return t.slice.value
    return None


def plane_names(code: str) -> list[str]:
    """The construction planes the script defines, in order."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    return [n for n in map(_plane_name, tree.body) if n is not None]


class _Bare(ast.NodeTransformer):
    def visit_Subscript(self, node):
        key = _p_key(node)
        if key is None:
            raise ParamError(f"can't read {ast.unparse(node)!r}: edit this line in the code")
        if not key.isidentifier():
            raise ParamError(f"the parameter {key!r} isn't a plain name: edit this line in the code")
        return ast.copy_location(ast.Name(id=key, ctx=ast.Load()), node)


def _eval(tree, pv: dict) -> float | None:
    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool):
            return float(n.value)
        if isinstance(n, ast.Name):
            return float(pv[n.id])
        if isinstance(n, ast.UnaryOp):
            v = ev(n.operand)
            return -v if isinstance(n.op, ast.USub) else v
        if isinstance(n, ast.BinOp):
            a, b = ev(n.left), ev(n.right)
            ops = {ast.Add: lambda: a + b, ast.Sub: lambda: a - b, ast.Mult: lambda: a * b,
                   ast.Div: lambda: a / b, ast.Pow: lambda: a ** b, ast.Mod: lambda: a % b,
                   ast.FloorDiv: lambda: a // b}
            return ops[type(n.op)]()
        raise ValueError
    try:
        return ev(tree)
    except (KeyError, ValueError, TypeError, ZeroDivisionError, OverflowError):
        return None


def _read_amount(node, pv: dict) -> tuple[float | None, str | None]:
    """(value, expression) of a distance/angle argument: a number → (it, None);
    anything with P in it → (its value with P's, the bare-name expression)."""
    if isinstance(node, ast.UnaryOp) and isinstance(node.operand, ast.Constant):
        try:
            return float(ast.literal_eval(node)), None
        except (ValueError, TypeError):
            pass
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return float(node.value), None
    bare = _Bare().visit(ast.Expression(body=ast.parse(ast.unparse(node), mode="eval").body))
    if not all(isinstance(n, _EXPR_NODES) for n in ast.walk(bare)):
        raise ParamError(f"can't read {ast.unparse(node)!r}: edit this line in the code")
    return _eval(bare, pv), ast.unparse(bare.body)


def _write_amount(value, names: set[str], what: str) -> str:
    """A distance/angle for the line: a number as itself, an expression of P
    names ("-width / 2") as Python ('-P["width"] / 2')."""
    if isinstance(value, bool):
        raise ParamError(f"the {what} must be a number or an expression of parameters")
    if isinstance(value, (int, float)):
        return _lit(float(value))
    text = str(value).strip()
    if not text:
        raise ParamError(f"give the {what}")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError:
        raise ParamError(f"can't read the {what} {text!r}") from None
    if not all(isinstance(n, _EXPR_NODES) for n in ast.walk(tree)):
        raise ParamError(f"the {what} {text!r} may only use numbers, parameters and + - * / ( )")
    unknown = sorted({n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} - names)
    if unknown:
        raise ParamError(f"the {what} {text!r} uses {', '.join(map(repr, unknown))}, "
                         f"which {'is not a parameter' if len(unknown) == 1 else 'are not parameters'}")

    class _P(ast.NodeTransformer):
        def visit_Name(self, node):
            return ast.copy_location(ast.Subscript(value=ast.Name(id="P", ctx=ast.Load()),
                                                   slice=ast.Constant(value=node.id), ctx=ast.Load()), node)
    out = ast.unparse(_P().visit(tree).body)
    return out.replace("P['", 'P["').replace("']", '"]')


def _ref_arg(node, fn: str, what: str) -> dict:
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == fn and node.args):
        ref = ast.literal_eval(node.args[0])
        if isinstance(ref, dict):
            return ref
    raise ParamError(f"can't read the {what} {ast.unparse(node)[:60]!r}: edit this line in the code")


def _read_plane(stmt, call, op: str, pv: dict) -> tuple[dict, dict]:
    """A construction plane's (args, exprs): {"name", "base" (a face ref as
    {"face": ref}, or "XY" / "XZ" / "YZ"), "distance"} or {"name", "edge",
    "angle", "from_face" (a face ref or None)} or {"name", "face" (the
    cylinder's ref), "angle", "ref" (None: auto, "X" / "Y" / "Z", or a flat
    face as {"face": ref})}; exprs holds the distance or angle when it is an
    expression (bare P names)."""
    kw = {k.arg: k.value for k in call.keywords if k.arg}
    args: dict = {"name": _plane_name(stmt)}
    exprs: dict = {}
    if op == "offset_plane":
        base = call.args[0] if call.args else kw.get("base")
        if base is None:
            raise ParamError(f"line {stmt.lineno}: offset_plane() without a base: edit this line in the code")
        if isinstance(base, ast.Constant) and isinstance(base.value, str) and base.value.upper() in ("XY", "XZ", "YZ"):
            args["base"] = base.value.upper()
        else:
            args["base"] = {"face": _ref_arg(base, "face_ref", "face")}
        dist = call.args[1] if len(call.args) > 1 else kw.get("distance")
        args["distance"], e = _read_amount(dist, pv) if dist is not None else (0.0, None)
        if e is not None:
            exprs["distance"] = e
    elif op == "tangent_plane":
        face = call.args[0] if call.args else kw.get("face")
        if face is None:
            raise ParamError(f"line {stmt.lineno}: tangent_plane() without a face: edit this line in the code")
        args["face"] = _ref_arg(face, "face_ref", "face")
        ang = call.args[1] if len(call.args) > 1 else kw.get("angle")
        args["angle"], e = _read_amount(ang, pv) if ang is not None else (0.0, None)
        if e is not None:
            exprs["angle"] = e
        ref = call.args[2] if len(call.args) > 2 else kw.get("ref")
        if ref is None or (isinstance(ref, ast.Constant) and ref.value is None):
            args["ref"] = None
        elif isinstance(ref, ast.Constant) and isinstance(ref.value, str) and ref.value.upper() in ("X", "Y", "Z"):
            args["ref"] = ref.value.upper()
        else:
            args["ref"] = {"face": _ref_arg(ref, "face_ref", "reference face")}
    else:
        edge = call.args[0] if call.args else kw.get("edge")
        if edge is None:
            raise ParamError(f"line {stmt.lineno}: edge_plane() without an edge: edit this line in the code")
        args["edge"] = _ref_arg(edge, "edge_ref", "edge")
        ang = call.args[1] if len(call.args) > 1 else kw.get("angle")
        args["angle"], e = _read_amount(ang, pv) if ang is not None else (0.0, None)
        if e is not None:
            exprs["angle"] = e
        face = call.args[2] if len(call.args) > 2 else kw.get("from_face")
        args["from_face"] = None if face is None or (isinstance(face, ast.Constant) and face.value is None) \
            else _ref_arg(face, "face_ref", "face")
    return args, exprs


def _check_plane_name(code: str, name: str, keep: str | None = None) -> str:
    name = str(name or "").strip()
    if not name:
        raise ParamError("give the plane a name")
    if any(c in name for c in "\"\\\n"):
        raise ParamError("a plane's name can't have quotes, backslashes or line breaks in it")
    if name != keep and name in plane_names(code):
        raise ParamError(f"there is a plane named {name!r} already")
    return name


def add_plane(code: str, op: str, name: str, *, base=None, distance=0.0, edge: dict | None = None,
              angle=0.0, from_face: dict | None = None, face: dict | None = None, ref=None,
              line: int | None = None) -> tuple[str, str | None]:
    """Append a construction plane line — or, with `line`, rewrite the one
    there (a new name renames it everywhere: rename_plane). offset_plane:
    `base` is a face ref or "XY" / "XZ" / "YZ"; edge_plane: `edge` an edge
    ref, `from_face` the face ref that is 0°; tangent_plane: `face` the
    cylinder's ref, `ref` what 0° is (None: auto, "X" / "Y" / "Z", or
    {"face": a flat face's ref}). A distance or angle is a number or an
    expression of P names. Returns (code, the old name when renamed)."""
    if op not in PLANE_OPS:
        raise ParamError(f"unknown plane {op!r}")
    old = None
    old_key = None              # tangent_plane: the P key the line's angle is
    if line is not None:
        hit = _op_stmt(ast.parse(code), line)
        if hit is None or hit[2] != op:
            raise ParamError(f"line {line} is not an {op}() line any more")
        old = _plane_name(hit[0])
        kw = {k.arg: k.value for k in hit[1].keywords if k.arg}
        ang = hit[1].args[1] if len(hit[1].args) > 1 else kw.get("angle")
        old_key = _p_key(ang) if ang is not None else None
    name = _check_plane_name(code, name, old)
    names = param_names(code)
    key = None                  # tangent_plane: a number angle goes in P under this key
    if op == "offset_plane":
        if isinstance(base, str) and base.upper() in ("XY", "XZ", "YZ"):
            b = _lit(base.upper())
        elif isinstance(base, dict) and base:
            ref = base.get("face", base)
            b = f"face_ref({_lit(ref)})"
        else:
            raise ParamError("pick a flat face, or the XY, XZ or YZ plane, to offset from")
        text = f"PLANES[{_lit(name)}] = offset_plane({b}, distance={_write_amount(distance, names, 'distance')})"
    elif op == "tangent_plane":
        if not face:
            raise ParamError("select a cylindrical face for the plane")
        if ref is None or (isinstance(ref, str) and ref.strip().lower() in ("", "auto")):
            r = ""
        elif isinstance(ref, str) and ref.strip().upper() in ("X", "Y", "Z"):
            r = f", ref={_lit(ref.strip().upper())}"
        elif isinstance(ref, dict) and ref:
            r = f", ref=face_ref({_lit(ref.get('face', ref))})"
        else:
            raise ParamError("measure the angle from X, Y, Z or a flat face")
        if isinstance(angle, (int, float)) and not isinstance(angle, bool):
            # the angle in P: the line's own key, else a new one after the plane's name
            stem = re.sub(r"\W+", "_", name).strip("_").lower()
            stem = stem if stem.isidentifier() and stem not in ("p", "params") else "tangent"
            key = old_key if old_key in names else _name(names, f"{stem}_angle")
            amount = f"P[{_lit(key)}]"
        else:
            amount = _write_amount(angle, names, "angle")
        text = f"PLANES[{_lit(name)}] = tangent_plane(face_ref({_lit(face)}), angle={amount}{r})"
    else:
        if not edge:
            raise ParamError("select a straight edge for the plane")
        face = f", from_face=face_ref({_lit(from_face)})" if from_face else ""
        text = (f"PLANES[{_lit(name)}] = edge_plane(edge_ref({_lit(edge)}), "
                f"angle={_write_amount(angle, names, 'angle')}{face})")
    code = _write_op(code, text, line, op)
    if key:
        value = float(angle)
        code = set_params(code, {key: value}) if key in names else add_param(code, key, value)
    if old is not None and old != name:
        code = rename_plane(code, old, name, check=False)
        return code, old
    return code, None


def rename_plane(code: str, old: str, new: str, check: bool = True) -> str:
    """Every PLANES["old"] of the script (its definition, its uses and lines
    switched off) as PLANES["new"]. The editor renames the sketches' planeRef
    with it."""
    if check:
        if old not in plane_names(code):
            raise ParamError(f"there is no plane named {old!r}")
        new = _check_plane_name(code, new, old)
    pat = re.compile(r"""\bPLANES\[\s*(["'])""" + re.escape(old) + r"""\1\s*\]""")
    return pat.sub(lambda m: f"PLANES[{_lit(new)}]", code)


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


TITLES = {"extrude": "Extrude", "revolve": "Revolve", "shell": "Shell", "holes": "Holes", "fillet": "Fillet", "chamfer": "Chamfer",
          "auto_round": "Round", "truss_windows": "Lighten", "offset_plane": "Offset plane",
          "edge_plane": "Plane on edge", "tangent_plane": "Tangent plane", "mirror_body": "Mirror body",
          "pattern_body": "Pattern body"}
_EXTRUDE_TITLES = {"cut": "Cut", "join": "Join", "new": "New body"}


def _sk_words(sketch: str) -> str:
    """A step's sketch: 'Holes' (a face sketch), or the SK source as written."""
    return sketch if is_shared_src(sketch) else repr(sketch)


def _deg(v) -> str:
    try:
        return f"{round(float(v), 3):g}°"
    except (TypeError, ValueError):
        return "?"


def _summary(op: str, a: dict, points: dict) -> str:
    if op == "pattern_body":
        return f"Pattern body {pattern_label(a['pattern'])} · " + ("joined" if a["join"] else "separate bodies")
    if op == "mirror_body":
        if a["join"]:
            return f"Mirror body across {plane_label(a['plane'])} · joined"
        gap = f" · {_mm(a['gap'])} apart" if a.get("gap") else ""
        return f"Mirror body across {plane_label(a['plane'])} · separate body{gap}"
    if op == "offset_plane":
        base = a["base"]
        where = f"{base} plane" if isinstance(base, str) else str(base["face"].get("hint") or "face")
        return f"Plane {a['name']!r} · {_mm(a['distance'])} from {where}"
    if op == "edge_plane":
        edge = str(a["edge"].get("hint") or "edge")
        return f"Plane {a['name']!r} · {_deg(a['angle'])} on {edge}"
    if op == "tangent_plane":
        face = str(a["face"].get("hint") or "cylinder")
        ref = a["ref"]
        frm = "" if ref is None else f" from {ref}" if isinstance(ref, str) \
            else f" from {ref['face'].get('hint') or 'face'}"
        return f"Plane {a['name']!r} · tangent at {_deg(a['angle'])}{frm} on {face}"
    if op == "extrude":
        how = "through all" if a["through"] else _mm(a["depth"])
        if a.get("extent") == "next":
            how = "up to next"
        elif a.get("extent") == "face":
            how = f"up to {(a['face'] or {}).get('hint') or 'face'}"
            off = a.get("offset") or 0
            if off:
                how += f" {_mm(abs(off))} {'past' if off > 0 else 'short'}"
        return (f"{_EXTRUDE_TITLES[a['op']]} {_sk_words(a['sketch'])} {how}" + (" both ways" if a["both"] else "")
                + (" · flipped" if a["flip"] else ""))
    if op == "revolve":
        return (f"{_EXTRUDE_TITLES[a['op']]} {_sk_words(a['sketch'])} revolved {_deg(a['angle'])} about the "
                f"{revolve_axis_label(a['axis'])}" + (" both ways" if a["both"] else "")
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
        and getattr(stmt.value.func, "id", None) in SKETCH_OPS else None


def _op_step(code: str, stmt, call, op: str, pv: dict, datum, points: dict, shift: int, off: bool) -> dict:
    step = {"kind": "op", "op": op, "variant": _variant(stmt), "line": stmt.lineno + shift,
            "end_line": (stmt.end_lineno or stmt.lineno) + shift, "off": off, "reopenable": False,
            "sketch": None, "faces": [], "edges": [], "plane": _plane_name(stmt),
            "mirror_of": None, "mirror_plane": None, "pattern_of": None, "pattern": None}
    wrap = _copy_node(stmt, call, op)
    if wrap is not None and wrap.func.id == "mirrored":
        try:
            step["mirror_plane"] = plane_label(_mirror_plane_arg(wrap.args[1]))
        except (ParamError, ValueError, SyntaxError):
            step["mirror_plane"] = "?"
    elif wrap is not None:
        try:
            step["pattern"] = pattern_label(_read_pattern(wrap.args[1], pv)[0])
        except (ParamError, ValueError, SyntaxError, KeyError, TypeError):
            step["pattern"] = "?"
    try:
        a, _, _ = _read_op(code, stmt, call, op, pv, datum)
    except (ValueError, KeyError, TypeError, SyntaxError):
        title = _EXTRUDE_TITLES.get(step["variant"] or "", TITLES[op])
        step["summary"] = f"{title} · written in code"
        if wrap is not None and step["pattern"]:
            step["summary"] += f" · pattern {step['pattern']}"
        elif wrap is not None and step["mirror_plane"]:
            step["summary"] += f" · mirrored across {step['mirror_plane']}"
        return step
    step["summary"] = _summary(op, a, points)
    step["reopenable"] = not off
    if wrap is not None and step["pattern"]:     # copies elsewhere: nothing of its own to show
        step["summary"] += f" · pattern {step['pattern']}"
    elif wrap is not None:            # it works on the other side: nothing of its own to show
        step["summary"] += f" · mirrored across {step['mirror_plane']}"
    elif op == "extrude":
        step["sketch"] = a["sketch"]
        step["faces"] = [a["face"]] if a.get("face") else []
    elif op == "revolve":
        step["sketch"] = a["sketch"]
        step["edges"] = [a["axis"]["edge"]] if a["axis"].get("edge") else []
        step["faces"] = [a["axis"]["face"]] if a["axis"].get("face") else []
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
    elif op == "offset_plane":
        step["faces"] = [a["base"]["face"]] if isinstance(a["base"], dict) else []
    elif op == "edge_plane":
        step["edges"] = [a["edge"]]
        step["faces"] = [a["from_face"]] if a["from_face"] else []
    elif op == "tangent_plane":
        step["faces"] = [a["face"]] + ([a["ref"]["face"]] if isinstance(a["ref"], dict) else [])
    return step


def steps(code: str, datum=(), points: dict | None = None) -> list[dict]:
    """The steps list: every operation of the script in order, switched off
    or not, as {"kind": "op", "op", "variant" (an extrude's cut / join /
    new), "line", "end_line", "summary", "reopenable", "off", "sketch",
    "faces", "edges" (what it works on, to show), "mirror_plane" (a mirrored
    copy's plane, else None), "mirror_of" (the line of the step a copy is
    linked to, else None)}, and each run of other
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
                        "reopenable": False, "summary": "Script", "sketch": None, "faces": [], "edges": [],
                        "plane": None, "mirror_of": None, "mirror_plane": None, "pattern_of": None,
                        "pattern": None})
    links = _links(code)
    for st in raw:
        if st["kind"] == "op" and st.get("mirror_plane"):
            st["mirror_of"] = (links.get(st["line"]) or {}).get("of")
        if st["kind"] == "op" and st.get("pattern"):
            st["pattern_of"] = (links.get(st["line"]) or {}).get("of")
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


def suppress(code: str, line: int, off: bool = True, copies: bool = False) -> str:
    """Switch the step on `line` off (each of its lines behind OFF) or back
    on (exactly as it was); with `copies`, its mirrored copies too."""
    if copies:
        start = _step_start(code, line)
        for c, link in sorted(_links(code).items(), reverse=True):
            if link["of"] == start and link["off"] != off:
                code = _suppress(code, c, off)
    return _suppress(code, line, off)


def _suppress(code: str, line: int, off: bool) -> str:
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


def delete_step(code: str, line: int, copies: str | None = None) -> str:
    """The script without the step on `line` (switched off or not), and
    without the P keys only it used. Its mirrored copies are deleted with it
    (copies="delete") or kept, unlinked (copies="keep", the default)."""
    if copies not in (None, "keep", "delete"):
        raise ParamError(f"copies must be 'keep' or 'delete', not {copies!r}")
    start = _step_start(code, line)
    for c, link in sorted(_links(code).items(), reverse=True):     # they come after it
        if link["of"] == start:
            code = _delete(code, c) if copies == "delete" else unlink(code, c)
    return _delete(code, line)


def _delete(code: str, line: int) -> str:
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


# --- Mirror (modeling/mirror.py). A whole body: `part = mirror_body(part,
# PLANE, join=True)`. A step's copy on the other side of a plane is the same
# operation with its input wrapped in mirrored(..., PLANE), on a line after
# it, with a link comment naming it:
#     part -= mirrored(extrude(sketch("USB"), amount=-P["usb_depth"]), PLANES["Mid"])  # mirror of line 7 across Mid
#     part = holes(part, at=mirrored(sketch_points("Posts"), "YZ"), ...)  # mirror of line 8 across YZ
#     part = fillet(part, mirrored(edges_ref([...]), PLANES["Mid"]), radius=P["fillet_r"])  # mirror of line 9 across Mid
# A linked copy is written again whenever its step is (_write_op), and every
# writer keeps the comments' line numbers right (relink). The PLANE is a flat
# face (face_ref), "XY" / "XZ" / "YZ" or PLANES["name"]; the API passes it as
# {"face": ref}, {"base": "XY"} or {"plane": "name"}.

MIRROR_OPS = ("extrude", "revolve", "holes", "fillet", "chamfer")
# a copy's link comment: "# mirror of line 7 across Mid" or "# pattern of line 7"
_LINK = re.compile(r"\s*#\s*(mirror|pattern) of line (\d+)(?: across (.+?))?\s*$")
# the call that wraps a copy's input, and what its link comment says it is
COPY_FNS = {"mirrored": "mirror", "patterned": "pattern"}


def _is_copy(node) -> bool:
    """A mirrored(x, PLANE) or patterned(x, PATTERN) call."""
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in COPY_FNS
            and len(node.args) == 2 and not node.keywords)


def _copy_node(stmt, call, op: str):
    """The mirrored(..., PLANE) or patterned(..., PATTERN) call of a copy, else None."""
    if op in SKETCH_OPS:
        return stmt.value if isinstance(stmt, ast.AugAssign) and _is_copy(stmt.value) else None
    if op == "holes":
        node = next((k.value for k in call.keywords if k.arg == "at"), None)
    elif op in EDGE_OPS:
        node = call.args[1] if len(call.args) > 1 else next((k.value for k in call.keywords if k.arg == "edges"), None)
    else:
        return None
    return node if _is_copy(node) else None


def _mirror_plane_arg(node) -> dict:
    """A plane argument as the API has it: {"base"}, {"plane"} or {"face"}."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.upper() in ("XY", "XZ", "YZ"):
        return {"base": node.value.upper()}
    if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == "PLANES"
            and isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str)):
        return {"plane": node.slice.value}
    return {"face": _ref_arg(node, "face_ref", "plane to mirror across")}


def plane_label(plane: dict) -> str:
    """A plane argument in a few words: "XY", the plane's name, the face's hint."""
    if plane.get("base"):
        return plane["base"]
    if plane.get("plane"):
        return plane["plane"]
    return str((plane.get("face") or {}).get("hint") or "face")


def _plane_src(code: str, plane) -> tuple[str, dict]:
    """(the line's text, the API form) of a plane argument: {"base": "XY"}
    (or "XY"), {"plane": name} (one the script defines) or {"face": ref}."""
    if isinstance(plane, str):
        plane = {"base": plane}
    if not isinstance(plane, dict):
        raise ParamError("pick a flat face, a construction plane or XY, XZ, YZ to mirror across")
    if plane.get("base"):
        base = str(plane["base"]).upper()
        if base not in ("XY", "XZ", "YZ"):
            raise ParamError(f"mirror across XY, XZ or YZ, not {plane['base']!r}")
        return _lit(base), {"base": base}
    if plane.get("plane"):
        name = str(plane["plane"])
        if name not in plane_names(code):
            raise ParamError(f"there is no plane named {name!r}")
        return f"PLANES[{_lit(name)}]", {"plane": name}
    if isinstance(plane.get("face"), dict) and plane["face"]:
        return f"face_ref({_lit(plane['face'])})", {"face": plane["face"]}
    raise ParamError("pick a flat face, a construction plane or XY, XZ, YZ to mirror across")


def _span(text: str, node) -> tuple[int, int]:
    """`node`'s (start, end) character offsets in `text`."""
    rows = text.split("\n")
    starts = [0]
    for row in rows:
        starts.append(starts[-1] + len(row) + 1)
    return (starts[node.lineno - 1] + _chars(rows[node.lineno - 1], node.col_offset),
            starts[node.end_lineno - 1] + _chars(rows[node.end_lineno - 1], node.end_col_offset))


def _copy_text(text: str, op: str, arg_src: str, fn: str = "mirrored") -> str:
    """The statement `text` of an `op` step as a copy: the same operation
    with its input (the extruded solid, where the holes go, the edges)
    wrapped in fn(..., arg_src) — mirrored across a plane, or patterned."""
    body = ast.parse(text).body
    hit = _recognise(body[0]) if len(body) == 1 else None
    verb = "mirror" if fn == "mirrored" else "pattern"
    if hit is None or hit[1] != op:
        raise ParamError(f"can't {verb} {text[:60]!r}")
    stmt, (call, _) = body[0], hit
    if _copy_node(stmt, call, op) is not None:
        raise ParamError(f"it is a copy already: {verb} its original")
    if op in SKETCH_OPS:
        sym = "-=" if isinstance(stmt, ast.AugAssign) and isinstance(stmt.op, ast.Sub) else "+="
        a, b = _span(text, call)
        return f"part {sym} {fn}({text[a:b]}, {arg_src})"
    if op == "holes":
        node = next((k.value for k in call.keywords if k.arg == "at"), None)
    else:
        node = call.args[1] if len(call.args) > 1 else next((k.value for k in call.keywords if k.arg == "edges"), None)
    if node is None:
        raise ParamError(f"can't tell what to {verb} in {text[:60]!r}")
    a, b = _span(text, node)
    return f"{text[:a]}{fn}({text[a:b]}, {arg_src}){text[b:]}"


class _Unwrap(ast.NodeTransformer):
    def visit_Call(self, node):
        self.generic_visit(node)
        return node.args[0] if _is_copy(node) else node


def _link_key(stmt, op: str):
    """What a step and its copy have in common: the statement with
    mirrored() / patterned() taken off (an extrude: whether it adds or cuts,
    and the extrude)."""
    bare = _Unwrap().visit(ast.parse(ast.unparse(stmt)).body[0])
    if op in SKETCH_OPS:
        cut = isinstance(bare, ast.AugAssign) and isinstance(bare.op, ast.Sub)
        return (op, cut, ast.dump(bare.value))
    return (op, ast.dump(bare))


def _stmts(code: str) -> list[dict]:
    """Every operation statement, switched off or not: [{"line", "end",
    "stmt", "call", "op", "off", "tail" (the comment after it), "src" (the
    text it was parsed from), "shift" (its line offset in it)}], in order."""
    tree = ast.parse(code)
    found = [(n, 0, code, False) for n in tree.body]
    for a, _, text in _off_blocks(code):
        try:
            found += [(n, a - 1, text, True) for n in ast.parse(text).body[:1]]
        except SyntaxError:
            pass
    out = []
    for node, shift, src, off in found:
        hit = _recognise(node)
        if hit is None:
            continue
        row = src.split("\n")[node.end_lineno - 1]
        out.append({"line": node.lineno + shift, "end": node.end_lineno + shift, "stmt": node, "call": hit[0],
                    "op": hit[1], "off": off, "tail": row[_chars(row, node.end_col_offset):],
                    "src": src, "shift": shift})
    return sorted(out, key=lambda s: s["line"])


def _links(code: str) -> dict[int, dict]:
    """The copies with a link comment: {copy's line: {"kind" ("mirror" /
    "pattern"), "of" (its step's line), "stated" (the comment's line number),
    "label" (the comment's plane), "plane" (a mirrored copy's plane, in a few
    words), "end", "off"}}. A copy belongs to the nearest step before it that
    it copies (so the link survives lines moving), else to the step its
    comment names when that is the same operation."""
    try:
        ss = _stmts(code)
    except SyntaxError:
        return {}
    keys = {}
    for s in ss:
        try:
            keys[s["line"]] = _link_key(s["stmt"], s["op"])
        except (SyntaxError, ValueError):
            keys[s["line"]] = None
    out = {}
    for s in ss:
        m = _LINK.search(s["tail"])
        wrap = _copy_node(s["stmt"], s["call"], s["op"]) if m else None
        if wrap is None or COPY_FNS[wrap.func.id] != m.group(1):
            continue
        stated = int(m.group(2))
        origs = [o for o in ss if o["line"] < s["line"] and o["op"] == s["op"]
                 and _copy_node(o["stmt"], o["call"], o["op"]) is None]
        same = [o["line"] for o in origs if keys[o["line"]] is not None and keys[o["line"]] == keys[s["line"]]]
        of = stated if stated in same else same[-1] if same else \
            stated if any(o["line"] == stated for o in origs) else None
        if of is None:
            continue
        label = None
        if m.group(1) == "mirror":
            try:
                label = plane_label(_mirror_plane_arg(wrap.args[1]))
            except (ParamError, ValueError, SyntaxError):
                label = m.group(3) or ""
        out[s["line"]] = {"kind": m.group(1), "of": of, "stated": stated, "label": m.group(3), "plane": label,
                          "end": s["end"], "off": s["off"]}
    return out


def _link_comment(of: int, label: str | None, kind: str = "mirror") -> str:
    if kind == "pattern":
        return f"  # pattern of line {of}"
    return f"  # mirror of line {of} across {label}"


def relink(code: str) -> str:
    """`code` with each link comment naming its step's line (and a mirrored
    copy's plane) as they are now."""
    links = _links(code)
    if not links:
        return code
    rows = code.split("\n")
    for link in links.values():
        if link["stated"] != link["of"] or link["label"] != link["plane"]:
            i = link["end"] - 1
            text = _link_comment(link["of"], link["plane"], link["kind"])
            rows[i] = _LINK.sub(lambda _m, t=text: t, rows[i], count=1)
    return "\n".join(rows)


def _copy_parts(code: str, line: int, op: str | None = None):
    """The copy statement on `line` (switched off or not): (its _stmts
    entry, its own text, the wrapping call parsed from that text), else None."""
    s = next((s for s in _stmts(code) if s["line"] <= line <= s["end"]), None)
    if s is None or (op is not None and s["op"] != op) or _copy_node(s["stmt"], s["call"], s["op"]) is None:
        return None
    rows = code.split("\n")
    src = "\n".join(_off_text(r) for r in rows[s["line"] - 1:s["end"]]) if s["off"] else \
        "\n".join(rows[s["line"] - 1:s["end"]])
    sub = ast.parse(src).body[0]
    return s, src, _copy_node(sub, _recognise(sub)[0], s["op"])


def _put(code: str, s: dict, text: str) -> str:
    """`code` with the statement `s` (a _stmts entry) replaced by `text`
    (its comment, and whether it is switched off, stay)."""
    rows = code.split("\n")
    new = (text + s["tail"]).split("\n")
    if s["off"]:
        new = [OFF + r for r in new]
    rows[s["line"] - 1:s["end"]] = new
    return "\n".join(rows)


def _rewrite_copy(code: str, line: int, text: str, op: str) -> str:
    """The copy on `line` written again from its step's new statement `text`
    (across the same plane, or with the same pattern; its comment and
    whether it is switched off stay)."""
    got = _copy_parts(code, line, op)
    if got is None:
        return code
    s, src, wrap = got
    arg = ast.get_source_segment(src, wrap.args[1])
    return _put(code, s, _copy_text(text, op, arg, wrap.func.id))


def _step_start(code: str, line: int) -> int:
    """The first line of the step on `line` (switched off or not)."""
    block = next((a for a, b, _ in _off_blocks(code) if a <= line <= b), None)
    if block is not None:
        return block
    node = next((n for n in ast.parse(code).body if n.lineno <= line <= (n.end_lineno or n.lineno)), None)
    return node.lineno if node is not None else line


def mirror_steps(code: str, lines: list[int], plane) -> tuple[str, list[dict], list[dict]]:
    """A mirrored copy across `plane` of each step on `lines` (extrudes,
    holes, fillets and chamfers), one line each after the last of them (and
    after the plane's own line), each with its link comment. Returns (code,
    the copies [{"of", "line"}], the steps left out [{"line", "reason"}])."""
    plane_src, plane = _plane_src(code, plane)
    label = plane_label(plane)
    tree = ast.parse(code)
    offs = _off_blocks(code)
    todo, skipped = [], []
    for ln in sorted(set(int(x) for x in lines)):
        if any(a <= ln <= b for a, b, _ in offs):
            skipped.append({"line": ln, "reason": "it is switched off"})
            continue
        hit = _op_stmt(tree, ln)
        if hit is None:
            skipped.append({"line": ln, "reason": "it isn't a step the editor can mirror"})
            continue
        stmt, call, op = hit
        if op not in MIRROR_OPS:
            skipped.append({"line": ln, "reason": f"{TITLES.get(op, op)} can't be mirrored"})
            continue
        if (wrap := _copy_node(stmt, call, op)) is not None:
            what = "mirrored copy" if wrap.func.id == "mirrored" else "pattern copy"
            skipped.append({"line": ln, "reason": f"it is a {what} already: mirror its original"})
            continue
        try:
            todo.append((stmt, _copy_text(ast.get_source_segment(code, stmt), op, plane_src)))
        except ParamError as exc:
            skipped.append({"line": ln, "reason": str(exc)})
    if not todo:
        return code, [], skipped
    after = max(stmt.end_lineno for stmt, _ in todo)
    if "plane" in plane:
        pdef = next(n for n in tree.body if _plane_name(n) == plane["plane"])
        after = max(after, pdef.end_lineno)
    rows = code.split("\n")
    new, made = [], []
    for stmt, text in todo:
        made.append({"of": stmt.lineno, "line": after + len(new) + 1})
        new += (text + _link_comment(stmt.lineno, label)).split("\n")
    rows[after:after] = new
    return "\n".join(rows), made, skipped


def add_mirror_body(code: str, plane, join: bool = True, line: int | None = None, gap=0.0) -> str:
    """Append `part = mirror_body(part, PLANE, join=True)` — or, with `line`,
    rewrite the mirror_body() line there. join=False keeps the mirror image
    as a separate body, `gap` (a number or an expression of P names) away:
    `part = mirror_body(part, PLANE, join=False, gap=10.0)`."""
    if not _assigns_part(ast.parse(code)):
        raise ParamError("there is no part to mirror yet")
    plane_src, _ = _plane_src(code, plane)
    gap_src = "" if join else f", gap={_write_amount(gap, param_names(code), 'gap')}"
    return _write_op(code, f"part = mirror_body(part, {plane_src}, join={bool(join)}{gap_src})", line, "mirror_body")


def unlink(code: str, line: int) -> str:
    """The copy (mirrored or patterned) on `line` without its link comment:
    a step of its own, no longer written again from the one it copied."""
    s = next((s for s in _stmts(code) if s["line"] <= line <= s["end"]), None)
    if s is None or _copy_node(s["stmt"], s["call"], s["op"]) is None or not _LINK.search(s["tail"]):
        raise ParamError(f"line {line} is not a linked copy")
    rows = code.split("\n")
    rows[s["end"] - 1] = _LINK.sub("", rows[s["end"] - 1], count=1)
    return "\n".join(rows)


# --- Pattern (modeling/pattern.py). A whole body: `part = pattern_body(part,
# PATTERN, join=True)`. A step's copies are the same operation with its input
# wrapped in patterned(..., PATTERN), on a line after it, with a link comment:
#     part -= patterned(extrude(sketch("Vent"), amount=-P["vent_depth"]),
#                       linear("X", P["vent_count"], spacing=P["vent_pitch"]))  # pattern of line 7
# PATTERN is linear(...) or circular(...); the API passes it as
#     {"type": "linear", "dir": DIR, "count", "spacing" | "extent", "symmetric", "flip",
#      "dir2": DIR | None, "count2", "spacing2" | "extent2", "flip2", "skip": [...]}
#     {"type": "circular", "axis": DIR, "count", "angle", "symmetric", "flip", "skip": [...]}
# DIR being {"base": "X"}, {"edge": edge ref} or {"face": face ref}, and each
# number a number (held in P, named after the step: vent_count, vent_pitch) or
# an expression of P names.

# linear() / circular()'s arguments in order, and the P key suffix of each number
_PATTERN_ARGS = {"linear": ("dir", "count", "spacing", "extent", "symmetric", "flip", "dir2", "count2",
                            "spacing2", "extent2", "flip2", "skip"),
                 "circular": ("axis", "count", "angle", "symmetric", "flip", "skip")}
_PATTERN_KEYS = {"count": "count", "spacing": "pitch", "extent": "extent", "count2": "count2",
                 "spacing2": "pitch2", "extent2": "extent2", "angle": "angle"}


def _is_pattern(node) -> bool:
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _PATTERN_ARGS


def _dir_arg(node, what: str) -> dict:
    """A direction or axis argument as the API has it: {"base"}, {"edge"} or {"face"}."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.upper() in ("X", "Y", "Z"):
        return {"base": node.value.upper()}
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "edge_ref":
        return {"edge": _ref_arg(node, "edge_ref", what)}
    return {"face": _ref_arg(node, "face_ref", what)}


def _dir_src(d, what: str) -> str:
    if isinstance(d, str):
        d = {"base": d}
    if not isinstance(d, dict):
        raise ParamError(f"pick an edge or a face for the {what}, or X, Y, Z")
    if d.get("base"):
        base = str(d["base"]).upper()
        if base not in ("X", "Y", "Z"):
            raise ParamError(f"the {what} is X, Y or Z, not {d['base']!r}")
        return _lit(base)
    if isinstance(d.get("edge"), dict) and d["edge"]:
        return f"edge_ref({_lit(d['edge'])})"
    if isinstance(d.get("face"), dict) and d["face"]:
        return f"face_ref({_lit(d['face'])})"
    raise ParamError(f"pick an edge or a face for the {what}, or X, Y, Z")


def dir_label(d: dict | None) -> str:
    """A direction or axis in a few words: "X", the edge's or face's hint."""
    if not d:
        return "?"
    if d.get("base"):
        return d["base"]
    ref = d.get("edge") or d.get("face") or {}
    return str(ref.get("hint") or ("edge" if "edge" in d else "face"))


def _read_pattern(node, pv: dict) -> tuple[dict, dict, dict]:
    """linear(...) / circular(...) as (args, params, exprs): the API's form
    (numbers with P's values), the P key of each number written as one, and
    the expression (bare P names) of each written as one."""
    if not _is_pattern(node):
        raise ParamError(f"can't read the pattern {ast.unparse(node)[:60]!r}: edit this line in the code")
    kind = node.func.id
    names = _PATTERN_ARGS[kind]
    if len(node.args) > len(names):
        raise ParamError(f"{kind}() has too many arguments: edit this line in the code")
    given = dict(zip(names, node.args))
    for k in node.keywords:
        if k.arg not in names:
            raise ParamError(f"{kind}() has no argument {k.arg!r}: edit this line in the code")
        given[k.arg] = k.value
    args: dict = {"type": kind}
    params: dict = {}
    exprs: dict = {}
    for name in names:
        n = given.get(name)
        if name in ("dir", "axis", "dir2"):
            args[name] = None if n is None or (isinstance(n, ast.Constant) and n.value is None) \
                else _dir_arg(n, "pattern direction" if name != "axis" else "pattern axis")
        elif name in ("symmetric", "flip", "flip2"):
            args[name] = bool(_value(n, pv)[0]) if n is not None else False
        elif name == "skip":
            v = ast.literal_eval(n) if n is not None else []
            args[name] = sorted({int(x) for x in v})
        elif n is None or (isinstance(n, ast.Constant) and n.value is None):
            args[name] = 360.0 if name == "angle" else 1 if name == "count2" else None
        else:
            args[name], e = _read_amount(n, pv)
            key = _p_key(n)
            if key is not None:
                params[name] = key
            elif e is not None:
                exprs[name] = e
    if kind == "linear":
        args["mode"] = "extent" if args["extent"] is not None else "spacing"
        args["mode2"] = "extent" if args["extent2"] is not None else "spacing"
    for k in ("count", "count2"):
        if isinstance(args.get(k), float) and args[k].is_integer():
            args[k] = int(args[k])
    return args, params, exprs


def _grid(a: dict) -> list[tuple[int, int]] | None:
    """Each instance's (step along dir, step along dir2), in index order, as
    pattern.py numbers them; None when a count isn't known."""
    from .pattern import _steps
    try:
        n = int(round(float(a["count"])))
        n2 = int(round(float(a.get("count2") or 1))) if a.get("type") == "linear" else 1
    except (TypeError, ValueError, KeyError):
        return None
    if n < 1 or n2 < 1:
        return None
    sym = bool(a.get("symmetric"))
    if a.get("type") == "circular" and float(a.get("angle") or 360) % 360 == 0:
        sym = False
    return [(i, j) for j in _steps(n2, sym) for i in _steps(n, sym)]


def _renumber_skips(old: str, new: str) -> str:
    """After a P change, keep each pattern's skip on the same copies: skip
    holds instance indices, and a count change renumbers the instances (a
    grid's second row starts at the new count). A copy no longer there drops
    out. Round the full circle the indices stay (the angles move instead)."""
    try:
        tree = ast.parse(new)
    except SyntaxError:
        return new
    pv_old, pv_new = _p_values(old), _p_values(new)
    if pv_old == pv_new:
        return new
    spans = []
    for node in ast.walk(tree):
        if not _is_pattern(node):
            continue
        skip = next((k.value for k in node.keywords if k.arg == "skip"), None)
        if skip is None:
            continue
        try:
            a, _, _ = _read_pattern(node, pv_old)
            b, _, _ = _read_pattern(node, pv_new)
        except (ParamError, ValueError, SyntaxError):
            continue
        ga, gb = _grid(a), _grid(b)
        if not a["skip"] or ga is None or gb is None or ga == gb:
            continue
        if b["type"] == "circular" and float(b.get("angle") or 360) % 360 == 0:
            keep = sorted(i for i in a["skip"] if 0 < i < len(gb))
        else:
            at = {g: k for k, g in enumerate(gb)}
            keep = sorted({at[ga[i]] for i in a["skip"] if i < len(ga) and at.get(ga[i])})
        if keep != a["skip"]:
            spans.append((skip, repr(keep)))
    lines = new.split("\n")
    for node, text in sorted(spans, key=lambda s: (s[0].lineno, s[0].col_offset), reverse=True):
        if node.lineno != node.end_lineno:
            continue
        row = lines[node.lineno - 1]
        c0, c1 = _chars(row, node.col_offset), _chars(row, node.end_col_offset)
        lines[node.lineno - 1] = row[:c0] + text + row[c1:]
    return "\n".join(lines)


def _instances(a: dict) -> int:
    def one(n, sym):
        n = int(round(float(n or 1)))
        return 2 * n - 1 if sym else n
    if a.get("type") == "circular":
        full = abs(abs(float(a.get("angle") or 360)) - 360) < 1e-9
        return one(a.get("count"), a.get("symmetric") and not full)
    return one(a.get("count"), a.get("symmetric")) * (one(a.get("count2"), a.get("symmetric")) if a.get("dir2") else 1)


def pattern_label(a: dict) -> str:
    """A pattern in a few words: "8 × 3", "4 along X", "6 round the cylinder face"."""
    def n(k):
        v = int(round(float(a.get(k) or 1)))
        return 2 * v - 1 if a.get("symmetric") else v
    skipped = f", {len(a['skip'])} skipped" if a.get("skip") else ""
    if a.get("type") == "circular":
        full = abs(abs(float(a.get("angle") or 360)) - 360) < 1e-9
        count = int(round(float(a.get("count") or 1)))
        count = 2 * count - 1 if a.get("symmetric") and not full else count
        over = "" if full else f" over {_deg(a.get('angle'))}" + (" each way" if a.get("symmetric") else "")
        return f"{count} round {dir_label(a.get('axis'))}{over}{skipped}"
    if a.get("dir2"):
        return f"{n('count')} × {n('count2')}{skipped}"
    return f"{n('count')} along {dir_label(a.get('dir'))}{skipped}"


def _stem(name: str | None) -> str:
    """The start of a pattern's P keys: the step's sketch name ("Vent" → vent)."""
    stem = re.sub(r"\W+", "_", str(name or "")).strip("_").lower()
    return stem if stem and stem.isidentifier() and stem not in ("p", "params") else "pattern"


def _pattern_src(code: str, pattern: dict, stem: str, old: dict | None = None) -> tuple[str, str, list[str]]:
    """(code, the linear(...) / circular(...) text, its P keys): each number
    held in P — in the key the old pattern had for it (`old`: its params), or
    a new one named stem_count, stem_pitch, ... — and each expression written
    as it is."""
    if not isinstance(pattern, dict) or pattern.get("type") not in _PATTERN_ARGS:
        raise ParamError("give the pattern: linear or circular")
    kind = pattern["type"]
    old = old or {}
    names = param_names(code)
    keys: list[str] = []
    parts: list[str] = []

    def num(field: str, what: str, integer: bool = False) -> str:
        nonlocal code
        v = pattern.get(field)
        if isinstance(v, str):
            return _write_amount(v, names, what)
        if v is None or isinstance(v, bool):
            raise ParamError(f"give the {what}")
        v = float(v)
        if integer:
            if v < 1 or not v.is_integer():
                raise ParamError(f"the {what} must be a whole number, at least 1 (got {v:g})")
        code, key = _number(code, v, old.get(field), f"{stem}_{_PATTERN_KEYS[field]}", names)
        keys.append(key)
        return f'P["{key}"]'

    if kind == "linear":
        parts.append(_dir_src(pattern.get("dir"), "pattern direction"))
        parts.append(num("count", "count", True))
        mode = pattern.get("mode") or ("extent" if pattern.get("extent") is not None else "spacing")
        parts.append(f"{mode}={num(mode, mode)}")
        if pattern.get("symmetric"):
            parts.append("symmetric=True")
        if pattern.get("flip"):
            parts.append("flip=True")
        if pattern.get("dir2"):
            parts.append(f"dir2={_dir_src(pattern['dir2'], 'second direction')}")
            parts.append(f"count2={num('count2', 'second count', True)}")
            mode2 = pattern.get("mode2") or ("extent" if pattern.get("extent2") is not None else "spacing")
            parts.append(f"{mode2}2={num(mode2 + '2', 'second ' + mode2)}")
            if pattern.get("flip2"):
                parts.append("flip2=True")
    else:
        parts.append(_dir_src(pattern.get("axis"), "pattern axis"))
        parts.append(num("count", "count", True))
        angle = pattern.get("angle", 360)
        if isinstance(angle, str) or abs(abs(float(angle if angle is not None else 360)) - 360) > 1e-9:
            parts.append(f"angle={num('angle', 'angle')}")
        if pattern.get("symmetric"):
            parts.append("symmetric=True")
        if pattern.get("flip"):
            parts.append("flip=True")
    skip = sorted({int(x) for x in pattern.get("skip") or []})
    if 0 in skip:
        raise ParamError("instance 0 is the original: it can't be skipped")
    if skip:
        parts.append(f"skip={_lit(skip)}")
    return code, f"{kind}({', '.join(parts)})", keys


def _drop_unused(code: str, keys) -> str:
    for k in sorted(set(keys)):
        code = drop_param(code, k)
    return code


def _step_stem(code: str, stmt, call, op: str) -> str:
    try:
        a, _, _ = _read_op(code, stmt, call, op, _p_values(code))
    except (ParamError, ValueError, KeyError, TypeError, SyntaxError):
        # written by hand: still named after the sketch it uses, if it says
        named = [n.args[0].value for n in ast.walk(call) if isinstance(n, ast.Call)
                 and getattr(n.func, "id", None) in ("sketch", "sketch_points") and n.args
                 and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str)]
        return _stem(named[0]) if named else "pattern"
    if op in SKETCH_OPS:
        return _stem(a.get("sketch"))
    if op == "holes":
        return _stem((a.get("at") or {}).get("sketch") or "holes")
    return _stem(op)


def _pattern_group(code: str, line: int) -> list[int]:
    """The pattern copies made together with the one on `line` (the same
    pattern, word for word): their lines, in order."""
    got = _copy_parts(code, line)
    if got is None or got[2].func.id != "patterned":
        return []
    text = ast.unparse(got[2].args[1])
    out = []
    for s in _stmts(code):
        other = _copy_parts(code, s["line"])
        if other is not None and other[2].func.id == "patterned" and ast.unparse(other[2].args[1]) == text:
            out.append(s["line"])
    return out


def pattern_steps(code: str, lines: list[int], pattern: dict) -> tuple[str, list[dict], list[dict], list[str]]:
    """The copies in `pattern` of each step on `lines` (extrudes, holes,
    fillets and chamfers), one line each after the last of them, each with
    its link comment; the pattern's numbers go in P, named after the first
    step (vent_count, vent_pitch). Returns (code, the copies [{"of",
    "line"}], the steps left out [{"line", "reason"}], the P keys)."""
    tree = ast.parse(code)
    offs = _off_blocks(code)
    todo, skipped = [], []
    for ln in sorted(set(int(x) for x in lines)):
        if any(a <= ln <= b for a, b, _ in offs):
            skipped.append({"line": ln, "reason": "it is switched off"})
            continue
        hit = _op_stmt(tree, ln)
        if hit is None:
            skipped.append({"line": ln, "reason": "it isn't a step the editor can pattern"})
            continue
        stmt, call, op = hit
        if op not in MIRROR_OPS:
            skipped.append({"line": ln, "reason": f"{TITLES.get(op, op)} can't be patterned"})
            continue
        if (wrap := _copy_node(stmt, call, op)) is not None:
            what = "mirrored copy" if wrap.func.id == "mirrored" else "pattern copy"
            skipped.append({"line": ln, "reason": f"it is a {what} already: pattern its original"})
            continue
        todo.append((stmt, call, op))
    if not todo:
        return code, [], skipped, []
    stmt0, call0, op0 = todo[0]
    n0 = len(code.split("\n"))
    code, src, keys = _pattern_src(code, pattern, _step_stem(code, stmt0, call0, op0))
    grown = len(code.split("\n")) - n0           # P got a line for a new key (it is above the steps)
    tree = ast.parse(code)
    texts = []
    for stmt, _, op in todo:
        moved = _op_stmt(tree, stmt.lineno + grown)
        try:
            texts.append((moved[0], _copy_text(ast.get_source_segment(code, moved[0]), op, src, "patterned")))
        except (ParamError, TypeError) as exc:
            skipped.append({"line": stmt.lineno, "reason": str(exc)})
    if not texts:
        return _drop_unused(code, keys), [], skipped, []
    after = max(s.end_lineno for s, _ in texts)
    rows = code.split("\n")
    new, made = [], []
    for s, text in texts:
        made.append({"of": s.lineno, "line": after + len(new) + 1})
        new += (text + _link_comment(s.lineno, None, "pattern")).split("\n")
    rows[after:after] = new
    return "\n".join(rows), made, skipped, keys


def add_pattern_body(code: str, pattern: dict, join: bool = True, line: int | None = None) -> tuple[str, list[str]]:
    """Append `part = pattern_body(part, PATTERN, join=True)` — or, with
    `line`, rewrite the pattern_body() line there (its P keys kept). Returns
    (code, the P keys)."""
    if not _assigns_part(ast.parse(code)):
        raise ParamError("there is no part to pattern yet")
    old: dict = {}
    if line is not None:
        got = op_at(code, line)
        if got["op"] != "pattern_body":
            raise ParamError(f"line {line} is not a pattern_body() line any more")
        old = got["params"]
    before = set(old.values())
    n0 = len(code.split("\n"))
    code, src, keys = _pattern_src(code, pattern, "pattern", old)
    if line is not None:
        line += len(code.split("\n")) - n0           # P got a line for a new key (it is above the step)
    code = _write_op(code, f"part = pattern_body(part, {src}, join={bool(join)})", line, "pattern_body")
    return _drop_unused(code, before - set(keys)), keys


def set_pattern(code: str, line: int, pattern: dict) -> tuple[str, list[str]]:
    """The pattern of the copy on `line` — and of the copies made with it
    (_pattern_group) — written as `pattern` (its P keys kept). Returns
    (code, the P keys)."""
    got = _copy_parts(code, line)
    if got is None or got[2].func.id != "patterned":
        raise ParamError(f"line {line} is not a pattern copy")
    s0, _, wrap0 = got
    _, old, _ = _read_pattern(wrap0.args[1], _p_values(code))
    group = _pattern_group(code, s0["line"])
    stem = "pattern"
    if old:
        k = next(iter(old.values()))
        stem = k.rsplit("_", 1)[0] if "_" in k else k
    else:
        orig = (_links(code).get(s0["line"]) or {}).get("of")
        hit = _op_stmt(ast.parse(code), orig) if orig else None
        if hit is not None:
            stem = _step_stem(code, *hit)
    n0 = len(code.split("\n"))
    code, src, keys = _pattern_src(code, pattern, stem, old)
    grown = len(code.split("\n")) - n0           # P got a line for a new key (it is above the steps)
    for ln in reversed(group):
        got = _copy_parts(code, ln + grown)
        if got is None:
            continue
        s, text, wrap = got
        text = text[:len(text) - len(s["tail"])]       # _put keeps the comment
        a, b = _span(text, wrap.args[1])
        code = _put(code, s, text[:a] + src + text[b:])
    return _drop_unused(code, set(old.values()) - set(keys)), keys


def _relinked(fn):
    @functools.wraps(fn)
    def run(*args, **kwargs):
        out = fn(*args, **kwargs)
        if isinstance(out, str):
            return relink(out)
        if isinstance(out, tuple) and out and isinstance(out[0], str):
            return (relink(out[0]), *out[1:])
        return out
    return run


# every writer leaves the link comments naming the right lines
for _fn in (set_params, add_param, drop_param, add_extrude, add_revolve, add_shell, add_edge_op, add_holes, edit_args,
            add_plane, rename_plane, suppress, delete_step, mirror_steps, add_mirror_body, unlink,
            pattern_steps, add_pattern_body, set_pattern):
    globals()[_fn.__name__] = _relinked(_fn)
del _fn
