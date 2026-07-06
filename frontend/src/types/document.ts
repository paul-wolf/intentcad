export interface Point {
  x: number;
  y: number;
}

export type SourceTransform =
  | { type: 'mirror'; lineA: Point; lineB: Point }
  | { type: 'rotate'; center: Point; angle: number }
  | { type: 'translate'; dx: number; dy: number };

export interface LineEntity {
  id: string;
  type: 'line';
  points: Point[];
  closed?: boolean;
  bulge?: number[];
  polygonCenter?: Point;
  construction?: boolean;
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
  anchor?: 'center' | 'corner';
  construction?: boolean;
  fill?: boolean;
  sourceId?: string;
  sourceTransform?: SourceTransform;
}

export interface PointEntity {
  id: string;
  type: 'point';
  position: Point;
  construction?: boolean;
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
  // Expression that drives this dimension's value (e.g. "bolt_hole / 2"):
  expression?: string;
}

export interface BezierEntity {
  id: string;
  type: 'bezier';
  controlPoints: [Point, Point, Point, Point];
  construction?: boolean;
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
  sourceId?: string;
  sourceTransform?: SourceTransform;
}

export type Entity = LineEntity | CircleEntity | RectangleEntity | PointEntity | DimensionEntity | BezierEntity | TextEntity;

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

export type Constraint = FixedConstraint | EqualConstraint | CoincidentConstraint | HorizontalConstraint | VerticalConstraint | MidpointConstraint | ParallelConstraint | PerpendicularConstraint | TangentConstraint | BisectConstraint;

export interface Sketch {
  id: string;
  name: string;
  visible: boolean;
  suppressed?: boolean;
  plane?: import('@/types/geometry').Plane;
  entities: Entity[];
  constraints: Constraint[];
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
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  kind?: 'edit' | 'question';   // assistant turns
  text: string;                 // instruction, note, or question
  code?: string;                // (assistant edit) the resulting script — a checkpoint
  at: number;
}
