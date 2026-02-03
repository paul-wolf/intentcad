export interface Point {
  x: number;
  y: number;
}

export interface LineEntity {
  id: string;
  type: 'line';
  points: Point[];
}

export interface CircleEntity {
  id: string;
  type: 'circle';
  center: Point;
  radius: number;
}

export interface DimensionEntity {
  id: string;
  type: 'dimension';
  targetEntityId: string;
  segmentIndex: number;
  offset: number;
}

export type Entity = LineEntity | CircleEntity | DimensionEntity;

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
