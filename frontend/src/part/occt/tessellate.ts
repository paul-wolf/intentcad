import * as THREE from 'three';
import type { OC } from './init';
import type { OcctCleanup } from './shapes';

export interface EdgeData {
  positions: Float32Array;  // [x1,y1,z1, x2,y2,z2, ...] for LineSegments
  edgeRanges: { edgeIndex: number; start: number; count: number }[];
}

/**
 * Tessellate an OCCT shape into a THREE.BufferGeometry.
 * Uses BRepMesh_IncrementalMesh + TopExp_Explorer to extract triangulation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tessellate(oc: OC, shape: any, deflection: number, cleanup: OcctCleanup): THREE.BufferGeometry {
  // Mesh the shape
  cleanup.track(new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, 0.5, true));

  const vertices: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const faceRanges: { start: number; count: number }[] = [];
  let vertexOffset = 0;
  let faceId = 0;

  // Iterate over faces
  const explorer = cleanup.track(new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  ));

  while (explorer.More()) {
    const currentShape = explorer.Current();

    // Cast to TopoDS_Face — try multiple patterns
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let face: any;
    const td = oc.TopoDS;
    if (typeof td?.Face === 'function') {
      face = td.Face(currentShape);
    } else if (typeof td?.Face_1 === 'function') {
      face = td.Face_1(currentShape);
    } else if (typeof td?.Face_2 === 'function') {
      face = td.Face_2(currentShape);
    } else if (td?.prototype && typeof td.prototype.Face === 'function') {
      face = td.prototype.Face(currentShape);
    } else if (td?.prototype && typeof td.prototype.Face_1 === 'function') {
      face = td.prototype.Face_1(currentShape);
    } else if (td?.prototype && typeof td.prototype.Face_2 === 'function') {
      face = td.prototype.Face_2(currentShape);
    } else {
      // Last resort: use the shape directly — explorer already filters to faces
      face = currentShape;
    }

    const location = cleanup.track(new oc.TopLoc_Location_1());
    const bt = oc.BRep_Tool;

    // Get triangulation — try static and prototype patterns
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let triangulation: any;
    if (typeof bt?.Triangulation === 'function') {
      triangulation = bt.Triangulation(face, location);
    } else if (bt?.prototype && typeof bt.prototype.Triangulation === 'function') {
      triangulation = bt.prototype.Triangulation(face, location);
    } else {
      throw new Error('Cannot find BRep_Tool.Triangulation');
    }

    if (!triangulation.IsNull()) {
      const tri = triangulation.get();
      const nbNodes = tri.NbNodes();
      const nbTriangles = tri.NbTriangles();
      const trsf = location.Transformation();

      // Determine face orientation
      const faceOrientation = face.Orientation_1();
      const reversed = faceOrientation === oc.TopAbs_Orientation.TopAbs_REVERSED;

      // Track index range for this face
      const faceIndexStart = indices.length;

      // Extract vertices, applying the face location transform
      for (let i = 1; i <= nbNodes; i++) {
        const node = tri.Node(i);
        const transformed = node.Transformed(trsf);
        vertices.push(transformed.X(), transformed.Y(), transformed.Z());
        faceIds.push(faceId);
      }

      // Extract triangles
      for (let i = 1; i <= nbTriangles; i++) {
        const triangle = tri.Triangle(i);
        let n1 = triangle.Value(1) - 1 + vertexOffset;
        let n2 = triangle.Value(2) - 1 + vertexOffset;
        let n3 = triangle.Value(3) - 1 + vertexOffset;

        if (reversed) {
          const tmp = n1;
          n1 = n2;
          n2 = tmp;
        }

        indices.push(n1, n2, n3);
      }

      faceRanges.push({ start: faceIndexStart, count: indices.length - faceIndexStart });
      vertexOffset += nbNodes;
      faceId++;
    }

    explorer.Next();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('faceId', new THREE.Int32BufferAttribute(faceIds, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData.faceRanges = faceRanges;

  return geometry;
}

/**
 * Extract edge wireframe data from an OCCT shape.
 * Walks edges via TopExp_Explorer and produces line segment positions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractEdges(oc: OC, shape: any, cleanup: OcctCleanup): EdgeData {
  const allPositions: number[] = [];
  const edgeRanges: EdgeData['edgeRanges'] = [];
  let edgeIndex = 0;

  const explorer = cleanup.track(new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  ));

  while (explorer.More()) {
    const currentShape = explorer.Current();

    // Cast to TopoDS_Edge — try multiple patterns (same as face casting)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let edge: any;
    const td = oc.TopoDS;
    if (typeof td?.Edge === 'function') {
      edge = td.Edge(currentShape);
    } else if (typeof td?.Edge_1 === 'function') {
      edge = td.Edge_1(currentShape);
    } else if (typeof td?.Edge_2 === 'function') {
      edge = td.Edge_2(currentShape);
    } else if (td?.prototype && typeof td.prototype.Edge === 'function') {
      edge = td.prototype.Edge(currentShape);
    } else if (td?.prototype && typeof td.prototype.Edge_1 === 'function') {
      edge = td.prototype.Edge_1(currentShape);
    } else {
      edge = currentShape;
    }

    const start = allPositions.length / 3;
    let segCount = 0;

    try {
      // Try to get tessellated polygon3D for curved edges
      const location = cleanup.track(new oc.TopLoc_Location_1());
      const bt = oc.BRep_Tool;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let poly3d: any = null;
      if (typeof bt?.Polygon3D === 'function') {
        poly3d = bt.Polygon3D(edge, location);
      } else if (bt?.prototype && typeof bt.prototype.Polygon3D === 'function') {
        poly3d = bt.prototype.Polygon3D(edge, location);
      }

      if (poly3d && !poly3d.IsNull()) {
        const p = poly3d.get();
        const nbNodes = p.NbNodes();
        const trsf = location.Transformation();

        if (nbNodes >= 2) {
          for (let i = 1; i < nbNodes; i++) {
            const n1 = p.Node(i).Transformed(trsf);
            const n2 = p.Node(i + 1).Transformed(trsf);
            allPositions.push(n1.X(), n1.Y(), n1.Z());
            allPositions.push(n2.X(), n2.Y(), n2.Z());
            segCount += 2;
          }
        }
      }
    } catch { /* polygon3D not available */ }

    // Fallback: use first/last vertex as a single chord segment
    if (segCount === 0) {
      try {
        const topExp = oc.TopExp;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let v1: any, v2: any;
        if (typeof topExp?.FirstVertex === 'function') {
          v1 = topExp.FirstVertex(edge, false);
          v2 = topExp.LastVertex(edge, false);
        } else if (typeof topExp?.FirstVertex_1 === 'function') {
          v1 = topExp.FirstVertex_1(edge, false);
          v2 = topExp.LastVertex_1(edge, false);
        } else if (topExp?.prototype && typeof topExp.prototype.FirstVertex === 'function') {
          v1 = topExp.prototype.FirstVertex(edge, false);
          v2 = topExp.prototype.LastVertex(edge, false);
        }

        if (v1 && v2) {
          const bt = oc.BRep_Tool;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let p1: any, p2: any;
          if (typeof bt?.Pnt === 'function') {
            p1 = bt.Pnt(v1);
            p2 = bt.Pnt(v2);
          } else if (bt?.prototype && typeof bt.prototype.Pnt === 'function') {
            p1 = bt.prototype.Pnt(v1);
            p2 = bt.prototype.Pnt(v2);
          }

          if (p1 && p2) {
            allPositions.push(p1.X(), p1.Y(), p1.Z());
            allPositions.push(p2.X(), p2.Y(), p2.Z());
            segCount = 2;
          }
        }
      } catch { /* vertex fallback failed */ }
    }

    if (segCount > 0) {
      edgeRanges.push({ edgeIndex, start: start * 3, count: segCount });
    }

    edgeIndex++;
    explorer.Next();
  }

  return {
    positions: new Float32Array(allPositions),
    edgeRanges,
  };
}
