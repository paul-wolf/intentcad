import type { OC } from './init';
import type { OcctCleanup } from './shapes';
import { castFace, castEdge, brepTriangulation, brepPolygon3D, brepPnt, topExpFirstVertex, topExpLastVertex } from './helpers';

export interface RawMeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceIds: Int32Array;
  faceRanges: { start: number; count: number }[];
}

export interface RawEdgeData {
  positions: Float32Array;
  edgeRanges: { edgeIndex: number; start: number; count: number }[];
}

/** Compute vertex normals from position + index arrays (same as THREE.js computeVertexNormals). */
function computeVertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3;
    const b = indices[i + 1]! * 3;
    const c = indices[i + 2]! * 3;

    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    normals[a] = normals[a]! + nx; normals[a + 1] = normals[a + 1]! + ny; normals[a + 2] = normals[a + 2]! + nz;
    normals[b] = normals[b]! + nx; normals[b + 1] = normals[b + 1]! + ny; normals[b + 2] = normals[b + 2]! + nz;
    normals[c] = normals[c]! + nx; normals[c + 1] = normals[c + 1]! + ny; normals[c + 2] = normals[c + 2]! + nz;
  }

  // Normalize
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i]!, y = normals[i + 1]!, z = normals[i + 2]!;
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 0) {
      normals[i] = x / len;
      normals[i + 1] = y / len;
      normals[i + 2] = z / len;
    }
  }

  return normals;
}

/**
 * Tessellate an OCCT shape into raw arrays (no THREE.js dependency).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tessellateRaw(oc: OC, shape: any, deflection: number, cleanup: OcctCleanup): RawMeshData {
  cleanup.track(new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, 0.5, true));

  const vertices: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const faceRanges: { start: number; count: number }[] = [];
  let vertexOffset = 0;
  let faceId = 0;

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
      const faceOrientation = face.Orientation_1();
      const reversed = faceOrientation === oc.TopAbs_Orientation.TopAbs_REVERSED;
      const faceIndexStart = indices.length;

      for (let i = 1; i <= nbNodes; i++) {
        const node = tri.Node(i);
        const transformed = node.Transformed(trsf);
        vertices.push(transformed.X(), transformed.Y(), transformed.Z());
        faceIds.push(faceId);
      }

      for (let i = 1; i <= nbTriangles; i++) {
        const triangle = tri.Triangle(i);
        let n1 = triangle.Value(1) - 1 + vertexOffset;
        let n2 = triangle.Value(2) - 1 + vertexOffset;
        let n3 = triangle.Value(3) - 1 + vertexOffset;
        if (reversed) { const tmp = n1; n1 = n2; n2 = tmp; }
        indices.push(n1, n2, n3);
      }

      faceRanges.push({ start: faceIndexStart, count: indices.length - faceIndexStart });
      vertexOffset += nbNodes;
      faceId++;
    }

    explorer.Next();
  }

  const posArr = new Float32Array(vertices);
  const idxArr = new Uint32Array(indices);
  const normals = computeVertexNormals(posArr, idxArr);

  return {
    positions: posArr,
    normals,
    indices: idxArr,
    faceIds: new Int32Array(faceIds),
    faceRanges,
  };
}

/**
 * Check if an edge is smooth by sampling mesh normals on both sides.
 */
function isEdgeSmooth(
  edgePositions: number[],
  meshPositions: Float32Array,
  meshNormals: Float32Array,
  meshIndex: Uint32Array,
  threshold: number,
): boolean {
  if (edgePositions.length < 6) return false;

  const numSegs = edgePositions.length / 6;
  const sampleIndices = numSegs <= 3
    ? Array.from({ length: numSegs }, (_, i) => i)
    : [0, Math.floor(numSegs / 2), numSegs - 1];

  for (const segIdx of sampleIndices) {
    const base = segIdx * 6;
    const mx = (edgePositions[base]! + edgePositions[base + 3]!) / 2;
    const my = (edgePositions[base + 1]! + edgePositions[base + 4]!) / 2;
    const mz = (edgePositions[base + 2]! + edgePositions[base + 5]!) / 2;

    let ex = edgePositions[base + 3]! - edgePositions[base]!;
    let ey = edgePositions[base + 4]! - edgePositions[base + 1]!;
    let ez = edgePositions[base + 5]! - edgePositions[base + 2]!;
    const elen = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (elen < 1e-12) continue;
    ex /= elen; ey /= elen; ez /= elen;

    let bestDistLeft = Infinity, bestDistRight = Infinity;
    let leftNx = 0, leftNy = 0, leftNz = 0;
    let rightNx = 0, rightNy = 0, rightNz = 0;

    for (let t = 0; t < meshIndex.length; t += 3) {
      const i0 = meshIndex[t]! * 3;
      const i1 = meshIndex[t + 1]! * 3;
      const i2 = meshIndex[t + 2]! * 3;

      const cx = (meshPositions[i0]! + meshPositions[i1]! + meshPositions[i2]!) / 3;
      const cy = (meshPositions[i0 + 1]! + meshPositions[i1 + 1]! + meshPositions[i2 + 1]!) / 3;
      const cz = (meshPositions[i0 + 2]! + meshPositions[i1 + 2]! + meshPositions[i2 + 2]!) / 3;

      const dx = cx - mx, dy = cy - my, dz = cz - mz;
      const dist = dx * dx + dy * dy + dz * dz;

      const projDot = dx * ex + dy * ey + dz * ez;
      const perpX = dx - projDot * ex;
      const perpY = dy - projDot * ey;
      const perpZ = dz - projDot * ez;
      const perpSign = perpX !== 0 ? Math.sign(perpX) : perpY !== 0 ? Math.sign(perpY) : Math.sign(perpZ);

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

    if (bestDistLeft === Infinity || bestDistRight === Infinity) return false;

    const lLen = Math.sqrt(leftNx * leftNx + leftNy * leftNy + leftNz * leftNz);
    const rLen = Math.sqrt(rightNx * rightNx + rightNy * rightNy + rightNz * rightNz);
    if (lLen < 1e-12 || rLen < 1e-12) return false;

    const dot = (leftNx * rightNx + leftNy * rightNy + leftNz * rightNz) / (lLen * rLen);
    if (dot < threshold) return false;
  }

  return true;
}

/**
 * Extract edge wireframe data from an OCCT shape (no THREE.js dependency).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractEdgesRaw(oc: OC, shape: any, cleanup: OcctCleanup, mesh?: RawMeshData): RawEdgeData {
  const allPositions: number[] = [];
  const edgeRanges: RawEdgeData['edgeRanges'] = [];
  let edgeIndex = 0;

  const canFilter = mesh && mesh.positions.length > 0;

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

    if (edgePositions.length > 0) {
      const smooth = canFilter && isEdgeSmooth(edgePositions, mesh.positions, mesh.normals, mesh.indices, 0.95);
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
