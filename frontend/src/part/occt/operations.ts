import type { OC } from './init';
import type { OcctCleanup } from './shapes';
import { castFace, castEdge, castWire, brepTriangulation, findConstructor, findConstructorNumeric, findMethod } from './helpers';

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
  const backVec = cleanup.track(new oc.gp_Vec_4(
    -normal[0] * distance,
    -normal[1] * distance,
    -normal[2] * distance,
  ));
  const trsf = cleanup.track(new oc.gp_Trsf_1());
  trsf.SetTranslation_1(backVec);
  const transformer = cleanup.track(new oc.BRepBuilderAPI_Transform_2(face, trsf, true));
  const movedFace = transformer.Shape();

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
 */
function getFaceNormal(
  oc: OC,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  faceShape: any,
  cleanup: OcctCleanup,
): [number, number, number] | null {
  const face = castFace(oc, faceShape);
  const location = cleanup.track(new oc.TopLoc_Location_1());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let triangulation: any;
  try {
    triangulation = brepTriangulation(oc, face, location);
  } catch {
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
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unifyShape(oc: OC, shape: any, cleanup: OcctCleanup): any {
  const ctor = findConstructorNumeric(oc, 'ShapeUpgrade_UnifySameDomain', 5,
    [[shape, true, true, false]], (u) => typeof u.Build === 'function');

  if (ctor) {
    const u = cleanup.track(new ctor(shape, true, true, false));
    u.Build();
    return u.Shape();
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
  const unified = unifyShape(oc, shape, cleanup);

  // Mesh so we can read face normals
  cleanup.track(new oc.BRepMesh_IncrementalMesh_2(unified, 0.1, false, 0.5, true));

  const dLen = Math.sqrt(
    faceDirection[0] ** 2 + faceDirection[1] ** 2 + faceDirection[2] ** 2,
  );
  if (dLen < 1e-10) throw new Error('Invalid face direction for shell');
  const dir: [number, number, number] = [faceDirection[0] / dLen, faceDirection[1] / dLen, faceDirection[2] / dLen];

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

  if (matchCount === 0) {
    throw new Error(`No faces found matching direction [${dir}] (checked ${faceCount} faces)`);
  }

  if (typeof oc.BRepOffsetAPI_MakeThickSolid_1 !== 'function') {
    throw new Error('BRepOffsetAPI_MakeThickSolid not available in this OCCT build');
  }

  const modeSkin = oc.BRepOffset_Mode?.BRepOffset_Skin ?? 0;
  const joinArc = oc.GeomAbs_JoinType?.GeomAbs_Arc ?? 0;
  const joinIntersection = oc.GeomAbs_JoinType?.GeomAbs_Intersection ?? 2;

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
      if (!done) continue;

      return builder.Shape();
    } catch {
      // Try next parameter combination
    }
  }

  throw new Error('Shell operation failed — geometry may be too complex for shell');
}

/**
 * Apply fillets (rounded edges) to selected edges of a shape.
 */
export function filletShape(
  oc: OC,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shape: any,
  edgeIndices: number[],
  radius: number,
  cleanup: OcctCleanup,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (edgeIndices.length === 0) throw new Error('No edges selected for fillet');

  const filletShapeEnum = oc.ChFi3d_FilletShape?.ChFi3d_Rational
    ?? oc.ChFi3d_Rational
    ?? 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fillet: any = null;
  // Try 2-arg (shape + enum), then 1-arg (shape)
  const ctor = findConstructor(oc, 'BRepFilletAPI_MakeFillet', ['', '_1', '_2', '_3'],
    [[shape, filletShapeEnum], [shape]],
    (obj) => typeof obj.Add_2 === 'function' || typeof obj.Add_1 === 'function');

  if (ctor) {
    // Instantiate with the 2-arg version first, fallback to 1-arg
    try {
      fillet = cleanup.track(new ctor(shape, filletShapeEnum));
    } catch {
      fillet = cleanup.track(new ctor(shape));
    }
  }
  if (!fillet) throw new Error('BRepFilletAPI_MakeFillet not available');

  const addMethod = findMethod(fillet, ['Add_2', 'Add_1', 'Add']);

  const edgeSet = new Set(edgeIndices);
  let edgeIndex = 0;

  const explorer = cleanup.track(new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  ));

  while (explorer.More()) {
    if (edgeSet.has(edgeIndex)) {
      const edge = castEdge(oc, explorer.Current());
      if (addMethod) {
        try {
          fillet[addMethod](radius, edge);
        } catch {
          console.warn(`[OCCT] Fillet: could not add edge index ${edgeIndex}`);
        }
      }
    }
    edgeIndex++;
    explorer.Next();
  }

  fillet.Build();
  const done = typeof fillet.IsDone === 'function' ? fillet.IsDone() : true;
  if (!done) throw new Error('Fillet Build() did not complete');

  return fillet.Shape();
}

/**
 * Apply chamfers (flat bevels) to selected edges of a shape.
 */
export function chamferShape(
  oc: OC,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shape: any,
  edgeIndices: number[],
  distance: number,
  cleanup: OcctCleanup,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (edgeIndices.length === 0) throw new Error('No edges selected for chamfer');

  const ctor = findConstructor(oc, 'BRepFilletAPI_MakeChamfer',
    ['_1', '_2', '_3', '_4', '_5', ''],
    [[shape]],
    (obj) => typeof obj.Add === 'function' || typeof obj.Add_1 === 'function');

  if (!ctor) throw new Error('BRepFilletAPI_MakeChamfer not available');
  const chamfer = cleanup.track(new ctor(shape));

  const addMethod = findMethod(chamfer, ['Add_2', 'Add_1', 'Add']);

  const edgeSet = new Set(edgeIndices);
  let edgeIndex = 0;

  const explorer = cleanup.track(new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  ));

  while (explorer.More()) {
    if (edgeSet.has(edgeIndex)) {
      const edge = castEdge(oc, explorer.Current());
      if (addMethod) {
        try {
          chamfer[addMethod](distance, edge);
        } catch {
          console.warn(`[OCCT] Chamfer: could not add edge index ${edgeIndex}`);
        }
      }
    }
    edgeIndex++;
    explorer.Next();
  }

  chamfer.Build();
  const done = typeof chamfer.IsDone === 'function' ? chamfer.IsDone() : true;
  if (!done) throw new Error('Chamfer Build() did not complete');

  return chamfer.Shape();
}

/**
 * Loft through a series of wires to create a solid.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loftShape(oc: OC, wires: any[], isSolid: boolean, cleanup: OcctCleanup): any {
  if (wires.length < 2) throw new Error('Loft requires at least 2 wires');

  const ctor = findConstructor(oc, 'BRepOffsetAPI_ThruSections',
    ['_1', '_2', '_3', '_4', '_5', ''],
    [[isSolid, false, 1e-6], [isSolid, false], [isSolid]],
    (obj) => typeof obj.AddWire === 'function' || typeof obj.AddWire_1 === 'function');

  if (!ctor) throw new Error('BRepOffsetAPI_ThruSections not available');

  // Instantiate — try 3-arg, 2-arg, 1-arg
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let thru: any = null;
  try { thru = cleanup.track(new ctor(isSolid, false, 1e-6)); } catch {
    try { thru = cleanup.track(new ctor(isSolid, false)); } catch {
      thru = cleanup.track(new ctor(isSolid));
    }
  }

  const addWireMethod = findMethod(thru, ['AddWire', 'AddWire_1', 'AddWire_2']);
  if (!addWireMethod) throw new Error('ThruSections.AddWire not available');

  for (const wire of wires) {
    const w = castWire(oc, wire);
    thru[addWireMethod](w);
  }

  thru.Build();
  const done = typeof thru.IsDone === 'function' ? thru.IsDone() : true;
  if (!done) throw new Error('ThruSections Build() did not complete');

  return thru.Shape();
}
