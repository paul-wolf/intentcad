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


class FeatureIn(Schema):
    id: str
    type: str  # 'extrude' supported; others rejected with a warning for now
    sketchId: str
    distance: float | None = None
    direction: str | None = None  # 'forward' | 'reverse' | 'both'
    operation: str | None = None  # 'add' | 'remove'


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


class BuildResponse(Schema):
    mesh: MeshOut
    step: str  # STEP (AP214) as text, for download/export
    warnings: list[str] = []
