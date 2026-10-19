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
    cornerRadius: float | None = None  # fillet on all four corners
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
    document_id: str = ""   # whose uploaded files ASSETS["<sha256>"] resolves to
    # name -> profile ({plane, loops, face?}), for sketch("name"); else the document's
    sketches: dict[str, dict] = {}


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
    radius: float | None = None   # radius of a cylindrical face (a hole/boss), else null
    size: list[float] = []        # bounding-box extents [dx, dy, dz] of the face
    axis: list[float] | None = None        # a cylinder's axis direction, else null
    axis_point: list[float] | None = None  # the point on that axis level with the face
    ref: dict | None = None       # face_ref({...}): how a script line names this face


class RunEdge(Schema):
    """An edge: the two faces it borders (an edge = the intersection of two
    faces) + a polyline for highlighting."""
    index: int
    kind: str
    faceIndices: list[int] = []
    polyline: list[list[float]] = []
    ref: dict | None = None       # edge_ref({...}): how a script line names this edge


class AutoRoundSkip(Schema):
    reason: str                     # 'failed' | 'protected' | 'timeout' | 'thin'
    kind: str                       # 'convex' | 'concave'
    polyline: list[list[float]] = []


class AutoRoundReport(Schema):
    """What auto_round did: edges rounded, the eligible ones it couldn't round,
    how many got less than the requested radius, how many a neighbouring
    fillet's chain took in, protected faces, seconds."""
    rounded: int = 0
    skipped: list[AutoRoundSkip] = []
    capped: int = 0
    merged: int = 0                 # of `rounded`: taken in by a neighbour's tangent chain
    protected: int = 0
    elapsed: float = 0.0


class OrganicWarning(Schema):
    kind: str                       # 'thin' | 'overhang' | 'blend'
    message: str
    at: list[float] = []            # where, when it's a place


class OrganicDrop(Schema):
    reason: str                     # 'small' | 'failed' | 'protected'
    at: list[float] = []


class OrganicReport(Schema):
    """What the organic helpers did: frame members joined and the ones left
    out, truss/window cuts made and dropped, the mass truss_windows removed,
    printability warnings."""
    members: int = 0
    failed_members: list[str] = []
    windows: int = 0
    dropped: list[OrganicDrop] = []
    removed_pct: float | None = None
    warnings: list[OrganicWarning] = []


class SketchPlaneOut(Schema):
    origin: list[float]
    normal: list[float]
    xAxis: list[float]


class SketchBinding(Schema):
    """Where a face sketch went in this build: it follows the face it was drawn
    on along that face's normal (modeling/sketch_profile.rebind)."""
    status: str                     # 'same' | 'moved' | 'ambiguous' | 'not_found'
    moved_by: float = 0.0           # mm along the sketch's normal
    plane: SketchPlaneOut           # the plane it was built on
    # the matched face's edges in the sketch's (x, y), y flipped like the
    # profile: lines {t, p: [a, b]}, circles {t, c, r}, arcs {t, c, r, p:
    # [start, mid, end]}, other curves {t: "poly", p}. None: no face matched
    outline: list[dict] | None = None


class FaceRefReport(Schema):
    """A face_ref() or edge_ref() lookup in this build (modeling/face_ref.py,
    edge_ref.py)."""
    hint: str                       # what the face is called: "top face"
    status: str                     # 'found' | 'ambiguous' | 'not_found'
    moved_by: float = 0.0           # mm along its normal from where it was


class RunResponse(Schema):
    mesh: MeshOut
    faces: list[RunFace] = []
    edges: list[RunEdge] = []
    params: dict[str, float] = {}   # editable scalar params from the script
    metrics: RunMetrics
    warning: str | None = None      # an op failed; the model is rendered up to it
    fix: dict | None = None         # for a fillet/chamfer that doesn't fit: the size that does
    auto_round: AutoRoundReport | None = None   # the script called auto_round
    organic: OrganicReport | None = None        # ... spoke/frame/window/truss_windows
    sketches: dict[str, SketchBinding] = {}     # name -> where each face sketch went
    face_refs: list[FaceRefReport] = []         # each face_ref() lookup, in order
    edge_refs: list[FaceRefReport] = []         # each edge_ref() lookup (moved_by: mm), in order


class ExportRequest(Schema):
    code: str
    format: str        # 'stl' | 'step' | 'stl-parts' | 'dxf'
    document_id: str = ""
    sketches: dict[str, dict] = {}


class ExportResponse(Schema):
    format: str
    data: str          # the exported file as text (ASCII STL / STEP / DXF)


class SetParamsRequest(Schema):
    code: str
    params: dict[str, float]        # name -> new value


class SetParamsResponse(Schema):
    code: str                       # the script with those values changed


class AddExtrudeRequest(Schema):
    code: str
    sketch: str                     # the sketch's name
    op: str                         # 'cut' | 'join' | 'new' (the first body)
    depth: float = 10.0
    through: bool = False           # cut through the whole part (no depth param)
    flip: bool = False              # reverse the direction
    datum: bool = False             # sketched on a base plane, not a part face
    both: bool = False              # the depth to each side of a base plane


class AddExtrudeResponse(Schema):
    code: str
    param: str | None = None        # the new P key holding the depth


class OpAtRequest(Schema):
    code: str
    line: int                       # any script line the operation spans (1-based)


class OpAtResponse(Schema):
    """A Shell/Hole line read back for its dialog (paramedit.op_at)."""
    op: str                         # 'shell' | 'holes'
    line: int
    end_line: int
    args: dict                      # its values, P keys resolved
    params: dict[str, str] = {}     # argument -> the P key holding it


class AddShellRequest(Schema):
    code: str
    remove: list[dict] = []         # face refs (RunFace.ref + "hint") of the faces left open
    thickness: float = 2.0
    inside: bool = True             # walls grow in (outside kept) / out (inside kept)
    line: int | None = None         # rewrite the shell() line there instead of appending


class AddHolesRequest(Schema):
    code: str
    at: dict                        # {"sketch": name} (its points) or {"face": face ref + "hint"} (its centre)
    kind: str = "clearance"         # clearance | tapped | insert | counterbore | countersink
    size: str = "M3"                # M2 .. M5
    fit: str = "normal"             # clearance only: close | normal
    depth: float | None = None      # None: through
    standoff: dict | None = None    # {"h", "d", "fillet"}: on a boss
    sizes: dict[str, float] = {}    # preset sizes changed in the dialog: d, cbore_d, cbore_depth, csk_d
    line: int | None = None         # rewrite the holes() line there instead of appending


class AddOpResponse(Schema):
    code: str
    param: str | None = None        # the P key holding the main size


class SensitivityRequest(Schema):
    code: str
    document_id: str = ""
    sketches: dict[str, dict] = {}


class DimInfo(Schema):
    faces: list[int] = []               # face indices the param controls
    value: float = 0.0                  # its current value
    shifts: dict[int, list[float]] = {} # face index -> [dx,dy,dz] center motion per unit
    radial: dict[int, float] = {}       # cylinder face index -> radius change per unit
    anchor: list[float] | None = None   # a world point on the controlled geometry
    dir: list[float] | None = None      # unit direction it moves as the param grows
    kind: str = "callout"               # "length" (has dir) or "callout"


class SensitivityResponse(Schema):
    params: dict[str, DimInfo] = {}     # param name -> what it controls + its dimension


class UsageTotals(Schema):
    edits: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0


class UsageResponse(Schema):
    document: UsageTotals       # this document's AI spend
    all_time: UsageTotals       # this user's AI spend across all documents


class ChatTurn(Schema):
    role: str           # 'user' | 'assistant'
    text: str


class EditRequest(Schema):
    """Ask the assistant to edit the build123d script from an instruction, with
    the current selection (if any) as the target and recent conversation."""
    code: str
    instruction: str
    context: str = ""              # a description of the selected face(s)/edge
    document_id: str = ""          # to tally spend per document + resolve its uploaded files
    history: list[ChatTurn] = []   # recent conversation turns
    model: str = ""                # optional LLM override (else the default)
    production: str = ""           # target production process (e.g. FDM print) — standing context
    build_error: str = ""          # the error the current script fails with, if it doesn't build


class ModelInfo(Schema):
    id: str
    label: str            # short name for a menu, e.g. "Opus 5"
    tier: str             # fable | opus | sonnet | haiku
    note: str             # one line on when to pick it
    released: str         # YYYY-MM-DD
    input_per_m: float    # USD per 1M input tokens
    output_per_m: float   # USD per 1M output tokens


class ModelsResponse(Schema):
    """The models the AI edit can use right now (from the Models API), newest
    first within each tier, and which one is the default."""
    models: list[ModelInfo]
    default: str
    source: str           # "live" or "static" (API unreachable — snapshot)


class EditResponse(Schema):
    kind: str = "edit"           # 'edit' | 'question'
    code: str = ""               # (edit) the full updated script, validated to build
    note: str | None = None      # (edit) one-sentence description of the change
    question: str = ""           # (question) the assistant's clarifying question
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
