export interface Point {
  x: number;
  y: number;
}

export type SourceTransform =
  | { type: 'mirror'; lineA: Point; lineB: Point };

export interface LineEntity {
  id: string;
  type: 'line';
  points: Point[];
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

export interface DimensionEntity {
  id: string;
  type: 'dimension';
  targetEntityId: string;
  segmentIndex: number;
  offset: number;
}

export type Entity = LineEntity | CircleEntity | RectangleEntity | DimensionEntity;

export interface Sketch {
  id: string;
  name: string;
  visible: boolean;
  entities: Entity[];
}

export interface Document {
  id: string;
  name: string;
  sketches: Sketch[];
  activeSketchId: string;
}
