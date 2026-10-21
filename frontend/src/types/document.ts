export interface Point {
  x: number;
  y: number;
}

export type SourceTransform =
  | { type: 'mirror'; lineA: Point; lineB: Point }
  | { type: 'rotate'; center: Point; angle: number }
  | { type: 'translate'; dx: number; dy: number }
  /** a curve moved `distance` to one side: `side` 1 is outside a closed
   *  shape (the left of an open chain), -1 inside (the right). Corners
   *  that open up are joined with arcs or miters. `chain`: the polylines
   *  followed when there are several, joined end to end (sourceId is the
   *  first). */
  | { type: 'offset'; distance: number; side: 1 | -1; join: 'arc' | 'miter'; chain?: string[] };

type Vec3 = [number, number, number];

/** A part's edge as the build describes it (api EdgeRefSpec, backend
 *  modeling/edge_ref.describe): its two faces, kind, middle and length, and
 *  its direction (a line) or centre, radius and axis (a circle or arc). */
export interface ProjectedEdgeRef {
  faces: { center: Vec3; normal: Vec3; area: number; kind?: string; hint?: string; box?: number[] }[];
  kind: string;
  midpoint: Vec3;
  length: number;
  direction?: Vec3;
  center?: Vec3;
  radius?: number;
  axis?: Vec3;
  hint?: string;
}

export interface LineEntity {
  id: string;
  type: 'line';
  points: Point[];
  closed?: boolean;
  bulge?: number[];
  polygonCenter?: Point;
  construction?: boolean;
  /** Reference/datum feature (e.g. a CNC touch-off marker). Real geometry —
   *  exported and built like anything else — but excluded from the bounding
   *  box used to align a sketch, so a marker outside the outline cannot skew it. */
  reference?: boolean;
  /** A face sketch's reference edge whose face edge is gone (the part
   *  changed): kept where it was so what uses it isn't lost, but the
   *  constraints on it are left out of the solve (see utils/brokenRefs.ts). */
  broken?: boolean;
  /** A part edge projected onto the sketch (build/projectEdges.ts): the
   *  edge as the build last described it, to find it again when the part
   *  changes. */
  edgeRef?: ProjectedEdgeRef;
  fill?: boolean;
  sourceId?: string;
  sourceTransform?: SourceTransform;
}

export interface CircleEntity {
  id: string;
  type: 'circle';
  center: Point;
  radius: number;
  construction?: boolean;
  /** Reference/datum feature (e.g. a CNC touch-off marker). Real geometry —
   *  exported and built like anything else — but excluded from the bounding
   *  box used to align a sketch, so a marker outside the outline cannot skew it. */
  reference?: boolean;
  /** A face sketch's reference edge whose face edge is gone (the part
   *  changed): kept where it was so what uses it isn't lost, but the
   *  constraints on it are left out of the solve (see utils/brokenRefs.ts). */
  broken?: boolean;
  /** A part edge projected onto the sketch (build/projectEdges.ts): the
   *  edge as the build last described it, to find it again when the part
   *  changes. */
  edgeRef?: ProjectedEdgeRef;
  fill?: boolean;
  sourceId?: string;
  sourceTransform?: SourceTransform;
}

export interface RectangleEntity {
  id: string;
  type: 'rectangle';
  center: Point;
  width: number;
  height: number;
  /** Fillet radius applied to all four corners. 0/undefined = square corners.
   *  Clamped to min(width, height) / 2 when drawn; see utils/rectPath.ts. */
  cornerRadius?: number;
  anchor?: 'center' | 'corner';
  construction?: boolean;
  /** Reference/datum feature (e.g. a CNC touch-off marker). Real geometry —
   *  exported and built like anything else — but excluded from the bounding
   *  box used to align a sketch, so a marker outside the outline cannot skew it. */
  reference?: boolean;
  fill?: boolean;
  sourceId?: string;
  sourceTransform?: SourceTransform;
}

export interface PointEntity {
  id: string;
  type: 'point';
  position: Point;
  construction?: boolean;
  /** Reference/datum feature (e.g. a CNC touch-off marker). Real geometry —
   *  exported and built like anything else — but excluded from the bounding
   *  box used to align a sketch, so a marker outside the outline cannot skew it. */
  reference?: boolean;
  sourceId?: string;
  sourceTransform?: SourceTransform;
}

export interface DimensionEntity {
  id: string;
  type: 'dimension';
  targetEntityId: string;
  segmentIndex: number;
  offset: number;
  // First target is a vertex (resolved via getEntityPoint) instead of a segment:
  pointIndex?: number;
  // Two-segment distance dimension (perpendicular distance between segments):
  targetEntityId2?: string;
  segmentIndex2?: number;
  // Second target is a vertex:
  pointIndex2?: number;
  // Angle dimension between two non-parallel segments:
  angleMode?: boolean;
  // Radius of an arc: arc segment `segmentIndex` of a line (a fillet), or a
  // rectangle's corner radius (drawn at corner `segmentIndex`, 0=TL…3=BL):
  radius?: boolean;
  // The distance of an offset (the target is the offset entity):
  offsetDistance?: boolean;
  // Expression that drives this dimension's value (e.g. "bolt_hole / 2"):
  expression?: string;
}

export interface BezierEntity {
  id: string;
  type: 'bezier';
  controlPoints: [Point, Point, Point, Point];
  construction?: boolean;
  /** Reference/datum feature (e.g. a CNC touch-off marker). Real geometry —
   *  exported and built like anything else — but excluded from the bounding
   *  box used to align a sketch, so a marker outside the outline cannot skew it. */
  reference?: boolean;
  sourceId?: string;
  sourceTransform?: SourceTransform;
}

export interface TextEntity {
  id: string;
  type: 'text';
  position: Point;
  text: string;
  height: number; // text height in world units
  rotation?: number; // degrees, counter-clockwise
  construction?: boolean;
  /** Reference/datum feature (e.g. a CNC touch-off marker). Real geometry —
   *  exported and built like anything else — but excluded from the bounding
   *  box used to align a sketch, so a marker outside the outline cannot skew it. */
  reference?: boolean;
  sourceId?: string;
  sourceTransform?: SourceTransform;
}

export type Entity = LineEntity | CircleEntity | RectangleEntity | PointEntity | DimensionEntity | BezierEntity | TextEntity;

/** How incoming geometry is placed relative to the sketch origin.
 *  'center' puts its bounding-box centre on (0,0), 'min' puts its lower-left
 *  corner there, 'none' keeps the source file's own coordinates. */
export type OriginAlignMode = 'center' | 'min' | 'none';

/** Check if a line entity is a closed profile suitable for extrusion.
 *  Handles both explicit `closed: true` and implicit closure (first == last point). */
export function isClosedProfile(e: LineEntity): boolean {
  if (e.construction) return false;
  if (e.points.length < 3) return false;
  if (e.closed) return true;
  // Implicit closure: first point equals last point
  const first = e.points[0]!;
  const last = e.points[e.points.length - 1]!;
  const dx = first.x - last.x;
  const dy = first.y - last.y;
  return dx * dx + dy * dy < 0.01;
}

export interface FixedConstraint {
  id: string;
  type: 'fixed';
  entityId: string;
}

export interface EqualConstraint {
  id: string;
  type: 'equal';
  entityId: string;
  targetEntityId: string;
  segmentIndex?: number;
  targetSegmentIndex?: number;
}

export interface CoincidentConstraint {
  id: string;
  type: 'coincident';
  entityId: string;
  pointIndex: number;
  targetEntityId: string;
  targetPointIndex: number;
}

export interface HorizontalConstraint {
  id: string;
  type: 'horizontal';
  entityId: string;
  segmentIndex: number;
}

export interface VerticalConstraint {
  id: string;
  type: 'vertical';
  entityId: string;
  segmentIndex: number;
}

/** Two points level with each other (same y), e.g. vertices, centres,
 *  rectangle corners or point entities. */
export interface HorizontalPointsConstraint {
  id: string;
  type: 'horizontalPoints';
  entityId: string;
  pointIndex: number;
  targetEntityId: string;
  targetPointIndex: number;
}

/** Two points one above the other (same x). */
export interface VerticalPointsConstraint {
  id: string;
  type: 'verticalPoints';
  entityId: string;
  pointIndex: number;
  targetEntityId: string;
  targetPointIndex: number;
}

/** A point on a curve: on the infinite line through a straight segment, or
 *  on a circle (segmentIndex -1) or the circle an arc segment (bulge) lies on. */
export interface PointOnCurveConstraint {
  id: string;
  type: 'pointOnCurve';
  entityId: string;       // whose point
  pointIndex: number;
  targetEntityId: string; // the curve's shape
  segmentIndex: number;   // its segment; -1 for a circle
}

/** Two points mirror images of each other about a straight segment's line
 *  (often a construction line or a reference edge). */
export interface SymmetricConstraint {
  id: string;
  type: 'symmetric';
  entityId: string;
  pointIndex: number;
  entityId2: string;
  pointIndex2: number;
  targetEntityId: string; // the line's shape
  segmentIndex: number;
}

export interface MidpointConstraint {
  id: string;
  type: 'midpoint';
  entityId: string;       // entity whose point is constrained
  pointIndex: number;     // which point on that entity
  targetEntityId: string; // entity containing the segment
  segmentIndex: number;   // which segment's midpoint
}

export interface ParallelConstraint {
  id: string;
  type: 'parallel';
  entityId: string;        // reference entity (angle source)
  segmentIndex: number;    // which segment on reference entity
  targetEntityId: string;  // entity that adjusts
  targetSegmentIndex: number; // which segment adjusts
}

export interface PerpendicularConstraint {
  id: string;
  type: 'perpendicular';
  entityId: string;        // reference entity (angle source)
  segmentIndex: number;    // which segment on reference entity
  targetEntityId: string;  // entity that adjusts
  targetSegmentIndex: number; // which segment adjusts
}

export interface TangentConstraint {
  id: string;
  type: 'tangent';
  entityId: string;           // reference entity (stays fixed)
  segmentIndex: number;       // segment on reference (-1 for circle)
  targetEntityId: string;     // entity that adjusts
  targetSegmentIndex: number; // segment on target (-1 for circle)
}

export interface BisectConstraint {
  id: string;
  type: 'bisect';
  entityId: string;           // the bisecting line (passes through midpoint)
  segmentIndex: number;       // which segment on the bisecting line
  targetEntityId: string;     // the line being bisected
  targetSegmentIndex: number; // which segment is bisected
}

export type Constraint = FixedConstraint | EqualConstraint | CoincidentConstraint | HorizontalConstraint | VerticalConstraint | HorizontalPointsConstraint | VerticalPointsConstraint | PointOnCurveConstraint | SymmetricConstraint | MidpointConstraint | ParallelConstraint | PerpendicularConstraint | TangentConstraint | BisectConstraint;

/** A grid or circular copy, kept so it can be reopened and changed:
 *  what was copied, the copies it made, and how. */
export type CopyPatternParams =
  | { kind: 'grid'; countX: number; countY: number; spacingX: number; spacingY: number }
  | { kind: 'circular'; center: Point; count: number };
export type CopyPattern = { id: string; sourceIds: string[]; copyIds: string[] } & CopyPatternParams;

export interface Sketch {
  id: string;
  name: string;
  visible: boolean;
  suppressed?: boolean;
  plane?: import('@/types/geometry').Plane;
  /** Drawn on a part's face: that face, so the build can find it again (see faceSketch.ts FaceRef). */
  face?: import('@/build/faceSketch').FaceRef;
  /** Drawn on a construction plane: its name in the script's PLANES. The
   *  build takes the plane from PLANES, so the sketch follows it; `plane`
   *  is a copy of where it was, for drawing. */
  planeRef?: string;
  /** Its closed shapes, saved with it for the script's sketch("name") (see faceSketch.ts). */
  profile?: import('@/build/faceSketch').SketchProfile;
  entities: Entity[];
  constraints: Constraint[];
  /** Grid and circular copies made in this sketch (see CopyPattern). */
  patterns?: CopyPattern[];
}

export interface DocumentMetadata {
  description?: string;
  author?: string;
  revision?: string;
  notes?: string;
}

export interface Document {
  id: string;
  name: string;
  /** Whether this document is primarily a 3D part or a 2D sketch. */
  type?: 'sketch' | 'part';
  sketches: Sketch[];
  activeSketchId: string;
  parameters?: Record<string, number>;
  metadata?: DocumentMetadata;
  /** The 3D build feature tree (legacy op-list modeler). */
  buildFeatures?: import('@/api/client').BuildFeature[];
  /** The 3D model as a build123d script — the current modeler. */
  modelCode?: string;
  /** Capped history of prior modelCode versions, so an overwrite is recoverable.
   *  `label` says what produced that version (an AI note, a param change, …). */
  modelCodeHistory?: { code: string; at: number; label?: string }[];
  /** Label for the current modelCode (what produced it) — recorded into history
   *  when the code is next replaced. */
  modelCodeLabel?: string;
  /** A small PNG data URL snapshot of the built part, for list thumbnails. */
  thumbnail?: string;
  /** The AI modeling conversation (persisted). Assistant 'edit' turns carry the
   *  resulting script as a checkpoint you can revert to. */
  chat?: ChatMessage[];
  /** The target production process for this part (e.g. FDM 3D printing). Fed to
   *  the AI as standing context so every edit designs in the right clearances. */
  productionNotes?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  kind?: 'edit' | 'question';   // assistant turns
  text: string;                 // instruction, note, or question
  code?: string;                // (assistant edit) the resulting script — a checkpoint
  files?: string[];             // (user) the titles of the context files sent with it
  usage?: string;               // (assistant) tokens and cost of the call, cached input included
  at: number;
}
