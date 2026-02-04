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
  polygonCenter?: Point;
  construction?: boolean;
  sourceId?: string;
  sourceTransform?: SourceTransform;
}

export interface CircleEntity {
  id: string;
  type: 'circle';
  center: Point;
  radius: number;
  construction?: boolean;
  sourceId?: string;
  sourceTransform?: SourceTransform;
}

export interface RectangleEntity {
  id: string;
  type: 'rectangle';
  center: Point;
  width: number;
  height: number;
  construction?: boolean;
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
}

export type Entity = LineEntity | CircleEntity | RectangleEntity | PointEntity | DimensionEntity;

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

export type Constraint = FixedConstraint | EqualConstraint | CoincidentConstraint | HorizontalConstraint | VerticalConstraint | MidpointConstraint | ParallelConstraint | PerpendicularConstraint;

export interface Sketch {
  id: string;
  name: string;
  visible: boolean;
  suppressed?: boolean;
  entities: Entity[];
  constraints: Constraint[];
}

export interface Document {
  id: string;
  name: string;
  sketches: Sketch[];
  activeSketchId: string;
}
