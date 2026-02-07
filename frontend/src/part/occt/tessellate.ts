import * as THREE from 'three';
import type { OC } from './init';
import type { OcctCleanup } from './shapes';

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
  let vertexOffset = 0;

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

      // Extract vertices, applying the face location transform
      for (let i = 1; i <= nbNodes; i++) {
        const node = tri.Node(i);
        const transformed = node.Transformed(trsf);
        vertices.push(transformed.X(), transformed.Y(), transformed.Z());
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

      vertexOffset += nbNodes;
    }

    explorer.Next();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}
