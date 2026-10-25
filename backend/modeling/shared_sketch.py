"""SK["alias"] and PP["name"]: a project's shared sketches and parameters in a
part's script.

A part lists the sketches it uses in its data, by id
(data.sketchRefs = {alias: {document, sketch}}); the server looks each one up
when the part builds (modeling/shared_defs.py) and the engine hands the
profiles here. A sketch document stores, for each of its sketches, a profile
the browser computes on save (frontend build/sharedSketch.ts):

    {"plane": {...},                 (its own plane, else XY of the project frame)
     "loops": [...], "points": [...], "lines": {...},
                                     (as a face sketch's: modeling/sketch_profile.py)
     "items": {"points":  [{"id", "p": [x, y]}],
               "circles": [{"id", "c": [x, y], "r": r}],
               "lines":   [{"id", "p": [[x, y], [x, y]]}]},
                                     (its real geometry, element by element)
     "names":  {name: id},           (elements given a name in the sketcher)
     "groups": {name: [id, ...]},
     "sub":    {"g:<group>": loops, "n:<name>": loops}}
                                     (the closed shapes of each group and named element)

SK["frame"] is a build123d Sketch on the sketch's plane (its closed shapes as
faces), so extrude(SK["frame"], amount=2) works as with any sketch. It adds:

    .group(name) / .named(name)   the part of the sketch in a group / one named element
    .circles                      its circles: .center (a Vector), .radius, .diameter
    .lines                        its straight lines, as Edges
    .points                       its points and circle centres (for holes(part, ...))
    .plane                        the plane it is on
    .on(plane_or_face)            the same shapes on another plane (a PLANES entry,
                                  Plane.XY, a flat face such as face_ref(...))

PP["arm_od"] is a project parameter: a number in mm or degrees, or text
such as "M3".
"""

from __future__ import annotations

from build123d import Edge, Face, GeomType, Plane, Sketch, Vector

from modeling.sketch_profile import Points, SketchError, profile_faces

XY_PLANE = {"origin": [0, 0, 0], "normal": [0, 0, 1], "xAxis": [1, 0, 0]}


class SharedSketchError(SketchError):
    pass


class SketchCircle:
    """A circle of a shared sketch, in 3D on its plane."""

    def __init__(self, center: Vector, radius: float, normal: Vector, id: str, name: str = ""):
        self.center, self.radius, self.normal, self.id, self.name = center, radius, normal, id, name

    @property
    def diameter(self) -> float:
        return 2 * self.radius

    def __repr__(self) -> str:
        c = self.center
        return f"SketchCircle(center=({c.X:g}, {c.Y:g}, {c.Z:g}), diameter={self.diameter:g})"


def _plane(spec: dict) -> Plane:
    return Plane(origin=tuple(spec["origin"]), x_dir=tuple(spec["xAxis"]), z_dir=tuple(spec["normal"]))


def _spec(pl: Plane) -> dict:
    return {"origin": list(pl.origin.to_tuple()), "normal": list(pl.z_dir.to_tuple()),
            "xAxis": list(pl.x_dir.to_tuple())}


def _target_plane(target) -> Plane:
    if isinstance(target, Plane):
        return target
    if isinstance(target, Face):
        if target.geom_type != GeomType.PLANE:
            raise SharedSketchError(".on(): the face is curved; put a sketch on a flat face or a plane")
        c = target.center()
        return Plane(origin=c, z_dir=target.normal_at(c))
    raise SharedSketchError(".on() takes a plane (PLANES[\"name\"], Plane.XY, …) or a flat face, "
                            f"not {type(target).__name__}")


class SharedSketch(Sketch):
    """SK["alias"]: a shared sketch's closed shapes as faces on its plane."""

    @classmethod
    def build(cls, profile: dict, label: str, ids: set[str] | None = None, loops=None):
        plane = profile.get("plane") or XY_PLANE
        loops = (profile.get("loops") or []) if loops is None else loops
        faces = profile_faces({"plane": plane, "loops": loops}, label) if loops else []
        out = cls(faces)
        out._profile, out._label, out._ids, out._loops = profile, label, ids, loops
        return out

    # ── parts of the sketch ──

    def _names(self) -> dict:
        return self._profile.get("names") or {}

    def _groups(self) -> dict:
        return self._profile.get("groups") or {}

    def _sub(self, key: str, ids: set[str], label: str) -> "SharedSketch":
        loops = (self._profile.get("sub") or {}).get(key) or []
        if self._ids is not None:
            ids = ids & self._ids
        return SharedSketch.build(self._profile, label, ids, loops)

    def group(self, name: str) -> "SharedSketch":
        """The shapes in group `name` (made with Group… in the sketcher)."""
        groups = self._groups()
        if name not in groups:
            have = ", ".join(repr(g) for g in groups) or "none"
            raise SharedSketchError(f"{self._label} has no group {name!r} (its groups: {have})")
        return self._sub(f"g:{name}", set(groups[name]), f"{self._label}.group({name!r})")

    def named(self, name: str) -> "SharedSketch":
        """The one element called `name` (named in the sketcher's properties)."""
        names = self._names()
        if name not in names:
            have = ", ".join(repr(n) for n in names) or "none"
            raise SharedSketchError(f"{self._label} has no element named {name!r} (its names: {have})")
        return self._sub(f"n:{name}", {names[name]}, f"{self._label}.named({name!r})")

    # ── its geometry, element by element ──

    @property
    def plane(self) -> Plane:
        return _plane(self._profile.get("plane") or XY_PLANE)

    def _items(self, kind: str) -> list[dict]:
        items = (self._profile.get("items") or {}).get(kind) or []
        return [i for i in items if self._ids is None or i.get("id") in self._ids]

    def _at(self, p) -> Vector:
        return self.plane.from_local_coords((float(p[0]), -float(p[1])))

    def _name_of(self, id_: str) -> str:
        return next((n for n, i in self._names().items() if i == id_), "")

    @property
    def circles(self) -> list[SketchCircle]:
        n = self.plane.z_dir
        return [SketchCircle(self._at(c["c"]), float(c["r"]), n, c["id"], self._name_of(c["id"]))
                for c in self._items("circles")]

    @property
    def lines(self) -> list[Edge]:
        out = []
        for ln in self._items("lines"):
            a, b = (self._at(p) for p in ln["p"])
            if (a - b).length > 1e-9:
                out.append(Edge.make_line(a, b))
        return out

    @property
    def points(self) -> Points:
        """Its points and circle centres, each place once, with the plane's
        normal: holes(part, SK["frame"].group("arm holes").points, ...)."""
        out: list[Vector] = []
        for v in [self._at(p["p"]) for p in self._items("points")] + [c.center for c in self.circles]:
            if all((v - o).length > 1e-6 for o in out):
                out.append(v)
        return Points(out, self.plane.z_dir, self._label)

    def on(self, target) -> "SharedSketch":
        """The same shapes, at the same sketch coordinates, on another plane
        or flat face."""
        profile = {**self._profile, "plane": _spec(_target_plane(target))}
        return SharedSketch.build(profile, f"{self._label}.on(...)", self._ids, self._loops)

    def __repr__(self) -> str:
        return f"<{self._label}: {len(self.faces())} shape(s)>"


class _Shared(dict):
    """SK / PP in the script: a dict whose missing keys explain themselves."""

    def __init__(self, values: dict, missing):
        super().__init__(values)
        self._missing = missing

    def __missing__(self, key):
        raise SharedSketchError(self._missing(key))


def bind(shared: dict | None) -> dict:
    """The script namespace's SK and PP, from what the engine sends:
    {"sk": {alias: profile}, "pp": {name: value},
     "errors": {alias: why it couldn't be loaded}}."""
    shared = shared or {}
    profiles = shared.get("sk") or {}
    errors = shared.get("errors") or {}
    pp = shared.get("pp") or {}

    def sk_missing(alias):
        if alias in errors:
            return errors[alias]
        have = ", ".join(repr(a) for a in profiles) or "none yet"
        return (f"SK[{alias!r}]: this part uses no shared sketch called {alias!r} "
                f"(its shared sketches: {have}; add one with Use project sketch…)")

    class SK(_Shared):
        def __missing__(self, alias):
            if alias in profiles and alias not in errors:
                try:
                    self[alias] = SharedSketch.build(profiles[alias], f"SK[{alias!r}]")
                except SketchError as exc:
                    raise SharedSketchError(f"SK[{alias!r}]: {exc}") from None
                return self[alias]
            raise SharedSketchError(sk_missing(alias))

    def pp_missing(name):
        have = ", ".join(repr(n) for n in pp) or "none"
        return (f"PP[{name!r}]: the project has no parameter called {name!r} "
                f"(Parameters on the project page; this script can see: {have})")

    return {"SK": SK({}, sk_missing), "PP": _Shared(dict(pp), pp_missing)}
