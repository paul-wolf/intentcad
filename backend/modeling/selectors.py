"""Resolve a selector query against the face inventory (see docs/world-model.md).

v0: single-criterion selectors over faces. This is the mechanism that turns the
inventory into references — the first piece of "operations name their target".
Stays a pure function of the inventory dicts (no kernel dependency).
"""


class SelectorError(ValueError):
    """A selector query that can't be parsed."""


def resolve_faces(query: str, faces: list[dict]) -> list[int]:
    """Return the indices of faces matching `query`.

    Grammar (v0):
      all | *              every face
      largest | smallest   the single face with max / min area
      tag:<t> | face:<t>   faces whose tags contain <t>   (e.g. tag:top)
      kind:<k>             faces of geometric kind <k>     (e.g. kind:cylinder)
    """
    q = query.strip().lower()
    if not q:
        raise SelectorError("empty selector")

    if q in ("all", "*"):
        return [f["index"] for f in faces]

    if q in ("largest", "smallest"):
        if not faces:
            return []
        pick = max if q == "largest" else min
        return [pick(faces, key=lambda f: f["area"])["index"]]

    if ":" in q:
        field, _, value = q.partition(":")
        field, value = field.strip(), value.strip()
        if field in ("tag", "face"):
            return [f["index"] for f in faces if value in f.get("tags", [])]
        if field == "kind":
            return [f["index"] for f in faces if f["kind"] == value]
        raise SelectorError(f"unknown selector field: {field!r}")

    raise SelectorError(f"unrecognized selector: {query!r}")


def resolve_edges(query: str, edges: list[dict]) -> list[int]:
    """Return the indices of edges matching `query`.

    Grammar (v0):
      all | *              every edge
      longest | shortest   the single edge with max / min length
      kind:<k>             edges of geometric kind <k>   (e.g. kind:circle)
    """
    q = query.strip().lower()
    if not q:
        raise SelectorError("empty selector")

    if q in ("all", "*"):
        return [e["index"] for e in edges]

    if q in ("longest", "shortest"):
        if not edges:
            return []
        pick = max if q == "longest" else min
        return [pick(edges, key=lambda e: e["length"])["index"]]

    if ":" in q:
        field, _, value = q.partition(":")
        field, value = field.strip(), value.strip()
        if field == "kind":
            return [e["index"] for e in edges if e["kind"] == value]
        if field == "between":
            a, _, b = value.partition(",")
            a, b = a.strip(), b.strip()

            def matches(e: dict) -> bool:
                fs = [set(t) for t in e.get("faces", [])]
                # a on one face, b on a *different* face
                for i, fi in enumerate(fs):
                    for j, fj in enumerate(fs):
                        if i != j and a in fi and b in fj:
                            return True
                return False

            return [e["index"] for e in edges if matches(e)]
        if field == "faces":
            # precise: the edge bordering exactly these two face indices
            a, _, b = value.partition(",")
            try:
                pair = {int(a.strip()), int(b.strip())}
            except ValueError as exc:
                raise SelectorError(f"faces: needs two integer indices, got {value!r}") from exc
            return [e["index"] for e in edges if set(e.get("faceIndices", [])) == pair]
        raise SelectorError(f"unknown selector field: {field!r}")

    raise SelectorError(f"unrecognized selector: {query!r}")
