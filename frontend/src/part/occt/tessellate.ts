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
 * Check if an edge is smooth by sampling the mesh normals on both sides.
 * For each edge segment midpoint, finds the closest mesh triangles on each side
 * and compares their face normals. If all segment normals agree (dot > threshold),
 * the edge is smooth and should not be rendered.
 */
function isEdgeSmooth(
  edgePositions: number[],
  meshPositions: Float32Array,
  meshNormals: Float32Array,
  meshIndex: Uint32Array | Uint16Array,
  threshold: number,
): boolean {
  if (edgePositions.length < 6) return false;

  // Sample up to 3 points along the edge (start, middle, end segment midpoints)
  const numSegs = edgePositions.length / 6;
  const sampleIndices = numSegs <= 3
    ? Array.from({ length: numSegs }, (_, i) => i)
    : [0, Math.floor(numSegs / 2), numSegs - 1];

  for (const segIdx of sampleIndices) {
    const base = segIdx * 6;
    // Midpoint of this edge segment
    const mx = (edgePositions[base]! + edgePositions[base + 3]!) / 2;
    const my = (edgePositions[base + 1]! + edgePositions[base + 4]!) / 2;
    const mz = (edgePositions[base + 2]! + edgePositions[base + 5]!) / 2;

    // Edge direction (for splitting "left" vs "right" side)
    let ex = edgePositions[base + 3]! - edgePositions[base]!;
    let ey = edgePositions[base + 4]! - edgePositions[base + 1]!;
    let ez = edgePositions[base + 5]! - edgePositions[base + 2]!;
    const elen = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (elen < 1e-12) continue;
    ex /= elen; ey /= elen; ez /= elen;

    // Find 2 closest triangles on opposite sides of the edge
    let bestDistLeft = Infinity, bestDistRight = Infinity;
    let leftNx = 0, leftNy = 0, leftNz = 0;
    let rightNx = 0, rightNy = 0, rightNz = 0;

    for (let t = 0; t < meshIndex.length; t += 3) {
      const i0 = meshIndex[t]! * 3;
      const i1 = meshIndex[t + 1]! * 3;
      const i2 = meshIndex[t + 2]! * 3;

      // Triangle centroid
      const cx = (meshPositions[i0]! + meshPositions[i1]! + meshPositions[i2]!) / 3;
      const cy = (meshPositions[i0 + 1]! + meshPositions[i1 + 1]! + meshPositions[i2 + 1]!) / 3;
      const cz = (meshPositions[i0 + 2]! + meshPositions[i1 + 2]! + meshPositions[i2 + 2]!) / 3;

      const dx = cx - mx, dy = cy - my, dz = cz - mz;
      const dist = dx * dx + dy * dy + dz * dz;

      // Which side of the edge is this triangle on?
      // Project displacement onto plane perpendicular to edge to determine side
      const projDot = dx * ex + dy * ey + dz * ez;
      const perpX = dx - projDot * ex;
      const perpY = dy - projDot * ey;
      const perpZ = dz - projDot * ez;
      // Use any consistent sign — the perpendicular vector's first nonzero component
      const perpSign = perpX !== 0 ? Math.sign(perpX) : perpY !== 0 ? Math.sign(perpY) : Math.sign(perpZ);

      // Triangle face normal (average of vertex normals)
      const fnx = (meshNormals[i0]! + meshNormals[i1]! + meshNormals[i2]!) / 3;
      const fny = (meshNormals[i0 + 1]! + meshNormals[i1 + 1]! + meshNormals[i2 + 1]!) / 3;
      const fnz = (meshNormals[i0 + 2]! + meshNormals[i1 + 2]! + meshNormals[i2 + 2]!) / 3;

      if (perpSign >= 0 && dist < bestDistLeft) {
        bestDistLeft = dist;
        leftNx = fnx; leftNy = fny; leftNz = fnz;
      } else if (perpSign < 0 && dist < bestDistRight) {
        bestDistRight = dist;
        rightNx = fnx; rightNy = fny; rightNz = fnz;
      }
    }

    if (bestDistLeft === Infinity || bestDistRight === Infinity) {
      return false; // Couldn't find triangles on both sides
    }

    // Normalize and compare
    const lLen = Math.sqrt(leftNx * leftNx + leftNy * leftNy + leftNz * leftNz);
    const rLen = Math.sqrt(rightNx * rightNx + rightNy * rightNy + rightNz * rightNz);
    if (lLen < 1e-12 || rLen < 1e-12) return false;

    const dot = (leftNx * rightNx + leftNy * rightNy + leftNz * rightNz) / (lLen * rLen);
    if (dot < threshold) return false;
  }

  return true;
}

/**
 * Extract edge wireframe data from an OCCT shape, filtering out smooth edges.
 * Walks edges via TopExp_Explorer and produces line segment positions.
 * Smooth edges (where adjacent face normals are nearly parallel) are excluded.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractEdges(oc: OC, shape: any, cleanup: OcctCleanup, meshGeometry?: THREE.BufferGeometry): EdgeData {
  const allPositions: number[] = [];
  const edgeRanges: EdgeData['edgeRanges'] = [];
  let edgeIndex = 0;

  // Get mesh data for smooth-edge filtering
  const meshPositions = meshGeometry?.getAttribute('position')?.array as Float32Array | undefined;
  const meshNormals = meshGeometry?.getAttribute('normal')?.array as Float32Array | undefined;
  const meshIndex = meshGeometry?.getIndex()?.array as Uint32Array | Uint16Array | undefined;
  const canFilter = meshPositions && meshNormals && meshIndex;

  const explorer = cleanup.track(new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  ));

  while (explorer.More()) {
    const currentShape = explorer.Current();
    const edge = castEdge(oc, currentShape);

    const edgePositions: number[] = [];

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
            edgePositions.push(n1.X(), n1.Y(), n1.Z());
            edgePositions.push(n2.X(), n2.Y(), n2.Z());
          }
        }
      }
    } catch { /* polygon3D not available */ }

    // Fallback: use first/last vertex as a single chord segment
    if (edgePositions.length === 0) {
      try {
        const v1 = topExpFirstVertex(oc, edge, false);
        const v2 = topExpLastVertex(oc, edge, false);
        const p1 = brepPnt(oc, v1);
        const p2 = brepPnt(oc, v2);
        edgePositions.push(p1.X(), p1.Y(), p1.Z());
        edgePositions.push(p2.X(), p2.Y(), p2.Z());
      } catch { /* vertex fallback failed */ }
    }

    // Filter smooth edges using mesh normals
    if (edgePositions.length > 0) {
      const smooth = canFilter && isEdgeSmooth(edgePositions, meshPositions, meshNormals, meshIndex, 0.95);

      if (!smooth) {
        const start = allPositions.length / 3;
        for (const v of edgePositions) allPositions.push(v);
        edgeRanges.push({ edgeIndex, start: start * 3, count: edgePositions.length / 3 });
      }
    }

    edgeIndex++;
    explorer.Next();
  }

  return {
    positions: new Float32Array(allPositions),
    edgeRanges,
  };
}
