"""Input/output schemas for the /build endpoint.

The request is intentionally self-contained: the referenced sketches are sent
inline (rather than looked up by id in the DB) so the modeler is a pure
function of its input and trivial to test / A-B against the old path.

These mirror the frontend's entity/feature shapes (frontend/src/types).
Coordinates arrive in the editor's Y-down screen convention; the builder
flips Y to the CAD/math Y-up convention (same as export/dxf.ts).
"""

from ninja import Schema


class Point(Schema):
    x: float
    y: float


class SketchEntityIn(Schema):
    type: str  # 'line' | 'circle' | 'rectangle' (others ignored for now)
    construction: bool = False
    # line
    points: list[Point] | None = None
    closed: bool | None = None
    bulge: list[float] | None = None
    # circle
    center: Point | None = None
    radius: float | None = None
    # rectangle
    width: float | None = None
    height: float | None = None
    anchor: str | None = None  # 'center' | 'corner'


class SketchIn(Schema):
    id: str
    entities: list[SketchEntityIn] = []


class AxisIn(Schema):
    """A revolve axis, as two points in sketch (screen) coordinates."""
    start: Point
    end: Point


class FeatureIn(Schema):
    id: str
    type: str  # extrude | revolve | fillet | chamfer | counterbore | trim; others warned
    sketchId: str
    operation: str | None = None  # 'add' | 'remove'
    # placement: base plane, then optional tilt about a world axis, then offset
    plane: str | None = None       # 'XY' (default) | 'XZ' | 'YZ'
    tilt: float | None = None      # degrees to rotate about tiltAxis after placing
    tiltAxis: str | None = None    # 'X' (default) | 'Y' | 'Z'
    offset: list[float] | None = None  # [dx, dy, dz] world translation
    # extrude
    distance: float | None = None
    direction: str | None = None  # 'forward' | 'reverse' | 'both'
    # revolve
    axis: AxisIn | None = None
    angle: float | None = None  # degrees; defaults to 360 in the builder
    # fillet / chamfer (modify the running result; no sketch)
    edges: str | None = None    # edge selector, e.g. 'all' | 'kind:line' | 'longest'
    radius: float | None = None  # fillet radius; chamfer uses `distance`
    # counterbore (recesses the top face at the sketch's circles)
    cboreDia: float | None = None
    cboreDepth: float | None = None
    # trim (cut past a plane)
    trimAxis: str | None = None   # 'X' | 'Y' | 'Z'
    at: float | None = None       # plane position on that axis
    keep: str | None = None       # 'min' (keep <= at) | 'max' (keep >= at)
    trimFace: str | None = None   # face tag ('back'|'front'|'left'|'right'|'top'|'bottom') — plane = that face


class BuildRequest(Schema):
    sketches: list[SketchIn] = []
    features: list[FeatureIn] = []
    # Tessellation linear deflection (world units). Smaller = finer mesh.
    tolerance: float = 0.1


class MeshOut(Schema):
    """Non-indexed triangle soup with per-face normals (flat shading).

    positions/normals are flat arrays of length 9*triangleCount (xyz per vertex,
    3 vertices per triangle). Kept renderer-agnostic on purpose.
    """

    positions: list[float]
    normals: list[float]
    triangle_count: int


class MetricsOut(Schema):
    """Coarse measurements of the built solid (CAD space). The first facts a
    validator or the agent reads about a result."""

    volume: float
    area: float
    bbox_min: list[float]  # [x, y, z]
    bbox_max: list[float]
    center: list[float]    # center of mass


class FaceOut(Schema):
    """A face of the result with coarse descriptors. Inventory v0 — positional
    index only; stable provenance ids come later (see docs/world-model.md)."""

    index: int
    kind: str            # 'plane' | 'cylinder' | 'cone' | 'sphere' | 'bspline' | ...
    area: float
    center: list[float]  # [x, y, z]
    normal: list[float]  # local surface normal at the center
    tags: list[str] = []  # coarse orientation tags: 'top' | 'bottom' | 'vertical'


class EdgeOut(Schema):
    """An edge of the result with coarse descriptors. Inventory v0."""

    index: int
    kind: str            # 'line' | 'circle' | 'bspline' | ...
    length: float
    center: list[float]
    start: list[float]
    end: list[float]
    faces: list[list[str]] = []  # tokens of the two faces this edge borders (adjacency)


class BuildResponse(Schema):
    mesh: MeshOut
    step: str  # STEP (AP214) as text, for download/export
    metrics: MetricsOut
    faces: list[FaceOut] = []
    edges: list[EdgeOut] = []
    warnings: list[str] = []
