import type { OC } from './init';
import type { OcctCleanup } from './shapes';

/**
 * Extrude a face along a direction by a distance.
 * Returns a TopoDS_Shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extrudeShape(oc: OC, face: any, normal: [number, number, number], distance: number, cleanup: OcctCleanup): any {
  const vec = cleanup.track(new oc.gp_Vec_4(
    normal[0] * distance,
    normal[1] * distance,
    normal[2] * distance,
  ));
  const prism = cleanup.track(new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true));
  return prism.Shape();
}

/**
 * Extrude a face symmetrically (both directions from the face).
 * Translates the face backward by distance, then extrudes 2*distance forward.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extrudeShapeSymmetric(oc: OC, face: any, normal: [number, number, number], distance: number, cleanup: OcctCleanup): any {
  // Translate face backward along normal
  const backVec = cleanup.track(new oc.gp_Vec_4(
    -normal[0] * distance,
    -normal[1] * distance,
    -normal[2] * distance,
  ));
  const trsf = cleanup.track(new oc.gp_Trsf_1());
  trsf.SetTranslation_1(backVec);
  const transformer = cleanup.track(new oc.BRepBuilderAPI_Transform_2(face, trsf, true));
  const movedFace = transformer.Shape();

  // Extrude 2*distance forward
  const fwdVec = cleanup.track(new oc.gp_Vec_4(
    normal[0] * 2 * distance,
    normal[1] * 2 * distance,
    normal[2] * 2 * distance,
  ));
  const prism = cleanup.track(new oc.BRepPrimAPI_MakePrism_1(movedFace, fwdVec, false, true));
  return prism.Shape();
}

/**
 * Revolve a face around an axis by a given angle (radians).
 * axisOrigin and axisDir define the revolution axis in 3D.
 * Returns a TopoDS_Shape.
 */
export function revolveShape(
  oc: OC,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  face: any,
  axisOrigin: [number, number, number],
  axisDir: [number, number, number],
  angle: number,
  cleanup: OcctCleanup,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const origin = cleanup.track(new oc.gp_Pnt_3(axisOrigin[0], axisOrigin[1], axisOrigin[2]));
  const dir = cleanup.track(new oc.gp_Dir_4(axisDir[0], axisDir[1], axisDir[2]));
  const axis = cleanup.track(new oc.gp_Ax1_2(origin, dir));

  const revol = cleanup.track(new oc.BRepPrimAPI_MakeRevol_1(face, axis, angle, true));
  return revol.Shape();
}

/** Boolean fuse (union) of two shapes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function booleanFuse(oc: OC, s1: any, s2: any, cleanup: OcctCleanup): any {
  // _1=default, _2=PaveFiller, _3=(S1,S2)
  const fuse = cleanup.track(new oc.BRepAlgoAPI_Fuse_3(s1, s2));
  return fuse.Shape();
}

/** Boolean cut (subtraction) of s2 from s1. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function booleanCut(oc: OC, s1: any, s2: any, cleanup: OcctCleanup): any {
  const cut = cleanup.track(new oc.BRepAlgoAPI_Cut_3(s1, s2));
  return cut.Shape();
}

/**
 * Compute the outward normal of a face using its triangulation.
 * The shape must be meshed (BRepMesh_IncrementalMesh) before calling this.
 */
function getFaceNormal(
  oc: OC,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  faceShape: any,
  cleanup: OcctCleanup,
): [number, number, number] | null {
  // Cast to TopoDS_Face for BRep_Tool::Triangulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let face: any = faceShape;
  const td = oc.TopoDS;
  if (typeof td?.Face === 'function') face = td.Face(faceShape);
  else if (typeof td?.Face_1 === 'function') face = td.Face_1(faceShape);
  else if (typeof td?.Face_2 === 'function') face = td.Face_2(faceShape);
  else if (td?.prototype && typeof td.prototype.Face === 'function') face = td.prototype.Face(faceShape);
  else if (td?.prototype && typeof td.prototype.Face_1 === 'function') face = td.prototype.Face_1(faceShape);

  const location = cleanup.track(new oc.TopLoc_Location_1());
  const bt = oc.BRep_Tool;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let triangulation: any;
  if (typeof bt?.Triangulation === 'function') {
    triangulation = bt.Triangulation(face, location);
  } else if (bt?.prototype && typeof bt.prototype.Triangulation === 'function') {
    triangulation = bt.prototype.Triangulation(face, location);
  } else {
    return null;
  }

  if (!triangulation || triangulation.IsNull()) return null;

  const tri = triangulation.get();
  if (tri.NbTriangles() < 1 || tri.NbNodes() < 3) return null;

  const trsf = location.Transformation();
  const t = tri.Triangle(1);
  const p1 = tri.Node(t.Value(1)).Transformed(trsf);
  const p2 = tri.Node(t.Value(2)).Transformed(trsf);
  const p3 = tri.Node(t.Value(3)).Transformed(trsf);

  const ux = p2.X() - p1.X(), uy = p2.Y() - p1.Y(), uz = p2.Z() - p1.Z();
  const vx = p3.X() - p1.X(), vy = p3.Y() - p1.Y(), vz = p3.Z() - p1.Z();

  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-10) return null;
  nx /= len; ny /= len; nz /= len;

  // Account for face orientation
  const orient = face.Orientation_1 ? face.Orientation_1() : faceShape.Orientation_1();
  if (orient === oc.TopAbs_Orientation.TopAbs_REVERSED) {
    nx = -nx; ny = -ny; nz = -nz;
  }

  return [nx, ny, nz];
}

/**
 * Unify co-planar faces and co-linear edges in a shape.
 * This is essential after boolean operations, which split faces along seam edges.
 * Without unification, MakeThickSolid often fails on boolean-fused geometry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unifyShape(oc: OC, shape: any, cleanup: OcctCleanup): any {
  for (let i = 1; i <= 5; i++) {
    const ctor = oc[`ShapeUpgrade_UnifySameDomain_${i}`];
    if (typeof ctor !== 'function') continue;
    try {
      // Constructor: (shape, unifyEdges, unifyFaces, concatBSplines)
      const u = new ctor(shape, true, true, false);
      if (u && typeof u.Build === 'function') {
        cleanup.track(u);
        u.Build();
        const result = u.Shape();
        console.log('[OCCT] UnifySameDomain: success');
        return result;
      }
      u.delete?.();
    } catch { /* wrong overload */ }
  }
  console.warn('[OCCT] UnifySameDomain: not available, using original shape');
  return shape;
}

/**
 * Shell (hollow) a solid by removing faces whose outward normal matches
 * faceDirection (dot product > 0.9) and offsetting remaining walls inward.
 */
export function shellShape(
  oc: OC,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shape: any,
  faceDirection: [number, number, number],
  thickness: number,
  cleanup: OcctCleanup,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // Unify co-planar faces split by boolean operations — critical for shell success
  const unified = unifyShape(oc, shape, cleanup);

  // Mesh the shape so we can read face normals from triangulation
  cleanup.track(new oc.BRepMesh_IncrementalMesh_2(unified, 0.1, false, 0.5, true));

  // Normalize direction
  const dLen = Math.sqrt(
    faceDirection[0] ** 2 + faceDirection[1] ** 2 + faceDirection[2] ** 2,
  );
  if (dLen < 1e-10) throw new Error('Invalid face direction for shell');
  const dir: [number, number, number] = [faceDirection[0] / dLen, faceDirection[1] / dLen, faceDirection[2] / dLen];

  // Collect faces to remove
  const facesToRemove = cleanup.track(new oc.TopTools_ListOfShape_1());
  let matchCount = 0;
  let faceCount = 0;

  const explorer = cleanup.track(new oc.TopExp_Explorer_2(
    unified,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  ));

  while (explorer.More()) {
    faceCount++;
    const currentShape = explorer.Current();
    const normal = getFaceNormal(oc, currentShape, cleanup);
    if (normal) {
      const dot = normal[0] * dir[0] + normal[1] * dir[1] + normal[2] * dir[2];
      if (dot > 0.9) {
        facesToRemove.Append_1(currentShape);
        matchCount++;
      }
    }
    explorer.Next();
  }

  console.log(`[OCCT] Shell: ${faceCount} faces (after unify), ${matchCount} matching direction [${dir}]`);

  if (matchCount === 0) {
    throw new Error(`No faces found matching direction [${dir}] (checked ${faceCount} faces)`);
  }

  if (typeof oc.BRepOffsetAPI_MakeThickSolid_1 !== 'function') {
    throw new Error('BRepOffsetAPI_MakeThickSolid not available in this OCCT build');
  }

  const modeSkin = oc.BRepOffset_Mode?.BRepOffset_Skin ?? 0;
  const joinArc = oc.GeomAbs_JoinType?.GeomAbs_Arc ?? 0;
  const joinIntersection = oc.GeomAbs_JoinType?.GeomAbs_Intersection ?? 2;

  // Try combinations: [tol, join, intersection, selfInter, removeIntEdges]
  const attempts: [number, unknown, boolean, boolean, boolean][] = [
    [1e-3, joinArc, true, false, false],
    [1e-3, joinIntersection, true, false, false],
    [1e-3, joinArc, true, true, true],
    [0.01, joinArc, true, false, false],
    [0.1, joinArc, true, false, false],
    [1e-3, joinArc, false, false, false],
  ];

  for (const [tol, join, intersection, selfInter, removeInt] of attempts) {
    try {
      const builder = cleanup.track(new oc.BRepOffsetAPI_MakeThickSolid_1());
      builder.MakeThickSolidByJoin(
        unified, facesToRemove, -thickness, tol,
        modeSkin, intersection, selfInter, join, removeInt,
      );

      const done = typeof builder.IsDone === 'function' ? builder.IsDone() : true;
      if (!done) {
        console.warn(`[OCCT] Shell: tol=${tol} join=${join} — not done`);
        continue;
      }

      const result = builder.Shape();
      console.log(`[OCCT] Shell: success with tol=${tol}`);
      return result;
    } catch (e) {
      console.warn(`[OCCT] Shell: tol=${tol} join=${join} failed:`, e);
    }
  }

  throw new Error('Shell operation failed — geometry may be too complex for shell');
}
