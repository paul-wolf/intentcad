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

export type Constraint = FixedConstraint | EqualConstraint | CoincidentConstraint | HorizontalConstraint | VerticalConstraint;

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
