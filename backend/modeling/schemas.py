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
    faces: list[list[str]] = []       # tokens of the two faces this edge borders
    faceIndices: list[int] = []       # inventory indices of those two faces
    polyline: list[list[float]] = []  # points tracing the edge (for highlighting)


class BuildResponse(Schema):
    mesh: MeshOut
    step: str  # STEP (AP214) as text, for download/export
    metrics: MetricsOut
    faces: list[FaceOut] = []
    edges: list[EdgeOut] = []
    warnings: list[str] = []


class ResolveRequest(Schema):
    """Ask the reference resolver to turn a phrase into a selector, grounded in
    the inventory of an already-built result (sent inline, same as /build)."""

    reference: str
    faces: list[FaceOut] = []
    edges: list[EdgeOut] = []


class ResolveResponse(Schema):
    status: str            # 'resolved' | 'clarify'
    # when resolved:
    target: str | None = None      # 'face' | 'edge'
    selector: str | None = None    # the formal selector, e.g. 'between:cylinder,top'
    indices: list[int] = []        # concrete faces/edges it names
    rationale: str | None = None
    # when clarify:
    question: str | None = None


class SketchMeta(Schema):
    """Just enough about a sketch for the chat agent to reference it by name."""
    id: str
    name: str
    entityCount: int = 0


class ChatRequest(Schema):
    """Ask the chat agent to turn an instruction into feature-tree operations,
    grounded in the current tree + sketches + built inventory (all inline)."""

    instruction: str
    sketches: list[SketchMeta] = []
    features: list[FeatureIn] = []   # the current tree
    faces: list[FaceOut] = []        # inventory of the current result
    edges: list[EdgeOut] = []


class ChatResponse(Schema):
    status: str                          # 'ok' | 'clarify'
    reply: str | None = None
    operations: list[FeatureIn] = []     # features to append to the tree
    question: str | None = None


# ── build123d engine (the new modeler) ──
class RunRequest(Schema):
    """Execute a build123d script (the model is the script)."""
    code: str


class RunMetrics(Schema):
    volume: float
    area: float
    bbox_min: list[float]
    bbox_max: list[float]


class RunFace(Schema):
    """A face of the result: its triangle range in the mesh (for pick/highlight)
    and its plane (center + normal) — what selection & sketch-on-face need."""
    index: int
    start: int          # first vertex of this face's triangles in the mesh
    count: int          # number of vertices (3 per triangle)
    kind: str           # 'plane' | 'cylinder' | ...
    area: float
    center: list[float]
    normal: list[float]


class RunEdge(Schema):
    """An edge: the two faces it borders (an edge = the intersection of two
    faces) + a polyline for highlighting."""
    index: int
    kind: str
    faceIndices: list[int] = []
    polyline: list[list[float]] = []


class RunResponse(Schema):
    mesh: MeshOut
    faces: list[RunFace] = []
    edges: list[RunEdge] = []
    params: dict[str, float] = {}   # editable scalar params from the script
    step: str
    metrics: RunMetrics


class SetParamsRequest(Schema):
    code: str
    params: dict[str, float]        # name -> new value


class SetParamsResponse(Schema):
    code: str                       # the script with those values changed


class SensitivityRequest(Schema):
    code: str


class SensitivityResponse(Schema):
    params: dict[str, list[int]] = {}   # param name -> face indices it controls


class EditRequest(Schema):
    """Ask the assistant to edit the build123d script from an instruction, with
    the current selection (if any) as the target."""
    code: str
    instruction: str
    context: str = ""   # a description of the selected face(s)/edge


class EditResponse(Schema):
    code: str           # the full updated script (already validated to build)
    note: str | None = None
