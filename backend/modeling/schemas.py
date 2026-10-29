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
class SharedIn(Schema):
    """The part's shared-sketch refs and pinned inputs as the editor has them
    (saved or not); None for either means the saved ones (shared_defs.py)."""
    refs: dict | None = None
    pinned: dict | None = None


class RunRequest(Schema):
    """Execute a build123d script (the model is the script)."""
    code: str
    document_id: str = ""   # whose uploaded files ASSETS["<sha256>"] resolves to
    # name -> profile ({plane, loops, face?}), for sketch("name"); else the document's
    sketches: dict[str, dict] = {}
    # the print bed face set in the editor (a face ref), else the bed is -Z
    bed: dict | None = None
    shared: SharedIn | None = None


class InputsRequest(Schema):
    code: str
    document_id: str = ""
    shared: SharedIn | None = None


class InputsResponse(Schema):
    key: str = ""                  # changes when any input does (the browser's build cache key)
    inputs: dict = {}              # {"sk": {alias: {document, sketch, version}}, "pp": {name: value}}
    errors: dict[str, str] = {}    # alias -> why its sketch couldn't be read
    # alias -> a project sketch not solved for the project's parameters:
    # {document, sketch, name, state "pending"|"failed", names, message, held}
    unsolved: dict = {}


class RebuildResponse(Schema):
    ok: bool
    error: str = ""
    warning: str = ""
    stale: list[str] = []          # still out of date (only when it failed)


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
    line: int | None = None         # the script line of the call that warned


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
    planeRef: str | None = None     # on a construction plane: its name (the plane came from PLANES)


class FaceRefReport(Schema):
    """A face_ref() or edge_ref() lookup in this build (modeling/face_ref.py,
    edge_ref.py)."""
    hint: str                       # what the face is called: "top face"
    status: str                     # 'found' | 'ambiguous' | 'not_found'
    moved_by: float = 0.0           # mm along its normal from where it was
    length: float | None = None     # edge_ref: the length of the edge found (mm)
    midpoint: list[float] | None = None  # edge_ref: and where its middle is
    radius: float | None = None     # edge_ref: and its radius (circle, arc)
    line: int | None = None         # edge_ref: the script line that looked it up


class KeptFaces(Schema):
    """Item `item` of the keep list of the auto_round() on `line`: the faces
    it named (face refs), as the part was when the line ran."""
    line: int | None = None
    item: int
    faces: list[dict] = []


class TangentCylinder(Schema):
    """The cylinder a tangent plane touches, as the build found it."""
    center: list[float]             # on the axis, at the face's start
    axis: list[float]               # as the face_ref stores it
    radius: float
    zero: list[float]               # the direction across the axis that is 0°
    length: float
    inward: bool                    # a bore: the plane faces the axis


class PlaneReport(Schema):
    """A construction plane as the build put it (modeling/planes.py)."""
    kind: str = "script"            # offset | edge | tangent | script (a Plane the script made itself)
    status: str = "same"            # same | moved | ambiguous (from its face_ref / edge_ref)
    line: int | None = None
    origin: list[float]
    normal: list[float]
    xAxis: list[float]
    cylinder: TangentCylinder | None = None  # tangent planes


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
    planes: dict[str, PlaneReport] = {}         # name -> each construction plane in PLANES
    kept: list[KeptFaces] = []                  # the faces each auto_round keep item is
    patterns: list[dict] = []                   # each linear()/circular() used: its instances (pattern.py)
    revolves: list[dict] = []                   # each revolve(): its axis and reach, or why it failed (revolve.py)
    bed: dict | None = None                     # the print bed face found again: {status, face, normal}
    inputs: dict | None = None                  # the shared sketches/parameters it read (shared_defs.py)


class ExportRequest(Schema):
    code: str
    format: str        # 'stl' | 'step' | 'stl-parts' | 'dxf'
    document_id: str = ""
    sketches: dict[str, dict] = {}
    bed: dict | None = None
    shared: SharedIn | None = None


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
    line: int | None = None         # rewrite the extrude line there instead of appending
    extent: str | None = None       # 'distance' | 'through' | 'next' | 'face' (default from `through`)
    face: dict | None = None        # the face ref to extrude up to (extent 'face')
    offset: float | str = 0.0       # past the face (negative: short of it): a number or an expression of P names
    key: str | None = None          # the depth key kept in P while it was an until extrude


class AddRevolveRequest(Schema):
    code: str
    sketch: str                     # the sketch's name
    op: str                         # 'cut' | 'join' | 'new' (the first body)
    axis: dict | str                # {"line": id} | {"base": "X"} | {"edge": ref} | {"face": ref} | "X"
    angle: float | str = 360        # degrees, or an expression of P names
    both: bool = False              # spread the angle either side of the sketch plane
    flip: bool = False              # turn the other way
    line: int | None = None         # rewrite the revolve line there instead of appending


class AddExtrudeResponse(Schema):
    code: str
    param: str | None = None        # the new P key holding the depth


class OpAtRequest(Schema):
    code: str
    line: int                       # any script line the operation spans (1-based)
    datum: list[str] = []           # the sketches on a base plane (an extrude's sign depends on it)


class OpAtResponse(Schema):
    """An operation line read back for its dialog (paramedit.op_at)."""
    op: str                         # extrude | shell | holes | fillet | chamfer | auto_round | truss_windows | mirror_body
    line: int
    end_line: int
    args: dict                      # its values, P keys resolved
    params: dict[str, str] = {}     # argument -> the P key holding it
    exprs: dict[str, str] = {}      # argument -> its source, when written as an expression
    mirror: dict | None = None      # a mirrored copy: {"plane", "label", "of": its step's line, None unlinked}
    pattern: dict | None = None     # a pattern copy: {"args", "params", "exprs", "label", "of", "lines": its group}


class EditArgsRequest(Schema):
    code: str
    line: int
    op: str                         # 'auto_round' | 'truss_windows'
    values: dict = {}               # argument -> its new value
    keep: list[dict] | None = None  # auto_round: the kept faces, {"src"} or {"ref"} each; None: as they are
    make_param: list[str] = []      # literal arguments to move into P


class EditArgsResponse(Schema):
    code: str
    params: list[str] = []          # the P keys it added


class StepsRequest(Schema):
    code: str
    datum: list[str] = []           # the sketches on a base plane
    points: dict[str, int] = {}     # sketch -> its number of hole points


class Step(Schema):
    """A row of the steps list (paramedit.steps)."""
    kind: str                       # 'op' | 'script' (a run of other lines)
    line: int
    end_line: int
    op: str | None = None           # extrude | shell | ... ('script': a switched-off non-operation)
    variant: str | None = None      # an extrude's cut | join | new
    summary: str | None = None
    reopenable: bool = False
    off: bool = False               # switched off: commented out behind "# off: "
    count: int = 0                  # 'script': its lines
    sketch: str | None = None       # what it works on, to show
    faces: list[dict] = []
    edges: list[dict] = []
    plane: str | None = None        # a construction plane's name
    mirror_of: int | None = None    # a mirrored copy: the line of the step it is linked to
    mirror_plane: str | None = None  # a mirrored copy: its plane, in a few words
    pattern_of: int | None = None   # a pattern copy: the line of the step it is linked to
    pattern: str | None = None      # a pattern copy: its pattern, in a few words ("8 × 3")


class StepsResponse(Schema):
    steps: list[Step]


class StepLineRequest(Schema):
    code: str
    line: int                       # any line of the step
    off: bool = True                # suppress: off, or back on
    copies: str | None = None       # its mirrored copies: delete: 'keep' (unlinked) | 'delete';
                                    # suppress: 'with' switches them too


class CodeResponse(Schema):
    code: str


# a plane to mirror across: {"face": face ref}, {"base": "XY" | "XZ" | "YZ"} or {"plane": name}
class AddMirrorBodyRequest(Schema):
    code: str
    plane: dict | str
    join: bool = True               # fuse with the part / keep as a separate body
    gap: float | str = 0.0          # separate: how far apart (a number, or an expression of P names)
    line: int | None = None         # rewrite the mirror_body() line there instead of appending


class MirrorStepsRequest(Schema):
    code: str
    lines: list[int]                # a line of each step to mirror
    plane: dict | str


class MirrorStepsResponse(Schema):
    code: str
    made: list[dict] = []           # [{"of": the step's line, "line": its copy's}]
    skipped: list[dict] = []        # [{"line", "reason"}]: steps that can't be mirrored


# a pattern: {"type": "linear", "dir": DIR, "count", "mode": "spacing" | "extent", "spacing" | "extent",
# "symmetric", "flip", "dir2": DIR | None, "count2", "mode2", "spacing2" | "extent2", "flip2", "skip"}
# or {"type": "circular", "axis": DIR, "count", "angle", "symmetric", "flip", "skip"}; DIR is
# {"base": "X" | "Y" | "Z"}, {"edge": edge ref} or {"face": face ref}; numbers may be P expressions
class AddPatternBodyRequest(Schema):
    code: str
    pattern: dict
    join: bool = True               # fuse the copies / keep them as separate bodies
    line: int | None = None         # rewrite the pattern_body() line there instead of appending


class PatternStepsRequest(Schema):
    code: str
    lines: list[int]                # a line of each step to pattern
    pattern: dict


class SetPatternRequest(Schema):
    code: str
    line: int                       # a pattern copy: it and the copies made with it get `pattern`
    pattern: dict


class PatternResponse(Schema):
    code: str
    made: list[dict] = []           # pattern_steps: [{"of": the step's line, "line": its copies'}]
    skipped: list[dict] = []        # pattern_steps: [{"line", "reason"}]
    params: list[str] = []          # the P keys holding the pattern's numbers


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


class AddEdgeOpRequest(Schema):
    code: str
    op: str                         # 'fillet' | 'chamfer'
    edges: list[dict]               # edge refs (RunEdge.ref), one per edge
    size: float                     # the fillet radius / chamfer length
    line: int | None = None         # rewrite the fillet()/chamfer() line there instead of appending


class AddPlaneRequest(Schema):
    code: str
    op: str                         # 'offset_plane' | 'edge_plane' | 'tangent_plane'
    name: str
    base: dict | str | None = None  # offset_plane: {"face": face ref} or "XY" | "XZ" | "YZ"
    distance: float | str = 0.0     # a number, or an expression of P names ("-width / 2")
    edge: dict | None = None        # edge_plane: the straight edge's ref
    angle: float | str = 0.0        # degrees, positive away from the material; or an expression
    from_face: dict | None = None   # edge_plane: the face that is 0° (default the edge's first)
    face: dict | None = None        # tangent_plane: the cylindrical face's ref
    ref: dict | str | None = None   # tangent_plane: 0° from "X" | "Y" | "Z" or {"face": a flat face's ref}; None auto
    line: int | None = None         # rewrite the plane line there instead of appending


class AddPlaneResponse(Schema):
    code: str
    renamed: str | None = None      # the plane's old name, when the line was renamed


class RenamePlaneRequest(Schema):
    code: str
    old: str
    new: str


class AddOpResponse(Schema):
    code: str
    param: str | None = None        # the P key holding the main size


class SensitivityRequest(Schema):
    code: str
    document_id: str = ""
    sketches: dict[str, dict] = {}
    shared: SharedIn | None = None


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
    cache_read_tokens: int = 0
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
    skip_context: list[str] = []   # context file ids left out of this message only
    mentions: list[str] = []       # ids of the project's parts the user @-mentioned
    sketch_refs: dict | None = None   # the part's SK aliases as the editor has them (else the saved ones)
    # the version of the saved script the editor had when asking (DocumentOut.code_version):
    # if the saved script isn't that version when the edit is ready, the reply says so
    code_base: str | None = None


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


class BriefProposal(Schema):
    text: str
    reason: str = ""


class EditResponse(Schema):
    kind: str = "edit"           # 'edit' | 'question' | 'answer'
    code: str = ""               # (edit) the full updated script, validated to build
    note: str | None = None      # (edit) one-sentence description of the change
    question: str = ""           # (question) the assistant's clarifying question
    answer: str = ""             # (answer) a reply that leaves the script as it is
    brief_proposal: BriefProposal | None = None   # a new project brief, for the user to accept
    sketch_refs: dict | None = None               # aliases use_sketch added: merge into data.sketchRefs
    parameter_proposals: list[dict] | None = None # project parameters, for the user to accept
    changed_elsewhere: bool | None = None         # (edit) the saved script changed since code_base: hold the edit
    # the spend, for staff only: left out of the response for everyone else
    tokens_in: int | None = None           # all input read, cached or not
    tokens_out: int | None = None
    cache_read_tokens: int | None = None   # of tokens_in, read from the prompt cache
    cache_write_tokens: int | None = None  # of tokens_in, written to it
    context_files: list[str] = []   # ids of the context files sent
    cost_usd: float | None = None
