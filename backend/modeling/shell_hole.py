"""shell() and holes(): the part editor's Shell and Hole operations as script
functions. Each is one readable script line written by the editor's dialogs
(paramedit.add_shell / add_holes) and read back by them to edit it
(paramedit.op_at_line).

    part = shell(part, remove=[face_ref({...})], thickness=P["wall"], inside=True)
"""

from __future__ import annotations

from build123d import Face, Kind, offset


class ShellError(ValueError):
    pass


def _faces(remove) -> list[Face]:
    if remove is None:
        return []
    if isinstance(remove, Face):
        return [remove]
    out = []
    for f in remove:
        out.extend(_faces(f) if not isinstance(f, Face) else [f])
    return out


def shell(part, remove=(), thickness: float = 2.0, inside: bool = True):
    """Hollow `part` out to walls `thickness` thick, open where the `remove`
    faces were. inside=True keeps the outside where it is (the walls grow
    in); inside=False keeps the inside (the walls grow out, corners sharp).

    A thickness the part can't take raises SizeError with the largest that
    works, measured."""
    from modeling._engine_runner import _largest_ok, _size_error

    if part is None or not hasattr(part, "faces"):
        raise ShellError("shell(): there is no part to shell yet")
    t = float(thickness)
    if t <= 0:
        raise ShellError(f"shell(): the wall thickness must be more than 0 (got {thickness:g})")
    openings = _faces(remove)
    vol = float(part.volume)
    closed = None

    def attempt(th: float):
        nonlocal closed
        r = offset(part, amount=-th if inside else th, openings=openings, kind=Kind.INTERSECTION)
        if not r.is_valid or r.volume <= 1e-9:
            raise ShellError("the shell is not a valid solid")
        if inside:
            # too thick, OCCT gives the part back unhollowed
            if vol - r.volume <= 1e-3 * vol:
                raise ShellError("the walls fill the part")
        else:
            outer = offset(part, amount=th, kind=Kind.INTERSECTION).volume
            if r.volume > outer - 0.5 * vol:
                raise ShellError("the part was not hollowed")
        return r

    try:
        return attempt(t)
    except Exception as exc:  # noqa: BLE001 - OCCT raises plain Standard_Failure
        mx = _largest_ok(attempt, t)
        n = len(openings)
        what = "this part" + (f" with {n} face{'s' if n > 1 else ''} open" if n else "")
        raise _size_error(exc, "shell", what, t, mx) from exc


def bind() -> dict:
    return {"shell": shell}
