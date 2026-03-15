import * as THREE from 'three';
import type { OC } from './init';
import type { OcctCleanup } from './shapes';
import { castFace, castEdge, brepTriangulation, brepPolygon3D, brepPnt, topExpFirstVertex, topExpLastVertex } from './helpers';

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
    const face = castFace(oc, currentShape);

    const location = cleanup.track(new oc.TopLoc_Location_1());
    const triangulation = brepTriangulation(oc, face, location);

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
    const edge = castEdge(oc, currentShape);

    const start = allPositions.length / 3;
    let segCount = 0;

    try {
      // Try to get tessellated polygon3D for curved edges
      const location = cleanup.track(new oc.TopLoc_Location_1());
      const poly3d = brepPolygon3D(oc, edge, location);

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
        const v1 = topExpFirstVertex(oc, edge, false);
        const v2 = topExpLastVertex(oc, edge, false);
        const p1 = brepPnt(oc, v1);
        const p2 = brepPnt(oc, v2);
        allPositions.push(p1.X(), p1.Y(), p1.Z());
        allPositions.push(p2.X(), p2.Y(), p2.Z());
        segCount = 2;
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
