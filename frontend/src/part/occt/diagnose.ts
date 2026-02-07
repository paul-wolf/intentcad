import { getOC } from './init';

/**
 * Diagnostic: discover the actual opencascade.js API surface.
 * Call from browser console: import('/src/part/occt/diagnose.ts').then(m => m.diagnose())
 */
export async function diagnose() {
  const oc = await getOC();
  console.log('=== OpenCascade.js API Diagnostic ===');

  // Check TopoDS
  const td = oc.TopoDS;
  console.log('TopoDS exists:', !!td);
  if (td) {
    console.log('TopoDS type:', typeof td);
    const staticKeys = Object.getOwnPropertyNames(td).filter(k => /face|wire|edge|vertex|shell|solid|shape/i.test(k));
    console.log('TopoDS static keys matching face/wire:', staticKeys);
    if (td.prototype) {
      const protoKeys = Object.getOwnPropertyNames(td.prototype).filter(k => k !== 'constructor');
      console.log('TopoDS.prototype keys:', protoKeys);
    }
  }

  // Check BRepBuilderAPI_MakeFace overloads
  const makeFaceOverloads: string[] = [];
  for (let i = 1; i <= 25; i++) {
    if (typeof oc[`BRepBuilderAPI_MakeFace_${i}`] === 'function') {
      makeFaceOverloads.push(`_${i}`);
    }
  }
  console.log('BRepBuilderAPI_MakeFace overloads:', makeFaceOverloads);

  // Check BRep_Tool
  const bt = oc.BRep_Tool;
  console.log('BRep_Tool exists:', !!bt);
  if (bt?.prototype) {
    const keys = Object.getOwnPropertyNames(bt.prototype).filter(k => k !== 'constructor');
    console.log('BRep_Tool.prototype keys:', keys);
  }

  // Check other key classes
  const classes = [
    'gp_Pnt', 'gp_Vec', 'gp_Dir', 'gp_Ax1', 'gp_Ax2', 'gp_Circ',
    'BRepBuilderAPI_MakePolygon', 'BRepBuilderAPI_MakeEdge', 'BRepBuilderAPI_MakeWire',
    'BRepPrimAPI_MakePrism', 'BRepPrimAPI_MakeRevol',
    'BRepAlgoAPI_Fuse', 'BRepAlgoAPI_Cut',
    'BRepMesh_IncrementalMesh', 'TopExp_Explorer',
    'TopLoc_Location', 'STEPControl_Writer',
  ];
  for (const cls of classes) {
    const overloads: string[] = [];
    for (let i = 1; i <= 20; i++) {
      if (typeof oc[`${cls}_${i}`] === 'function') overloads.push(`_${i}`);
    }
    console.log(`${cls}:`, overloads.length > 0 ? overloads.join(', ') : 'NONE');
  }

  // Check enums
  console.log('TopAbs_ShapeEnum:', oc.TopAbs_ShapeEnum ? Object.keys(oc.TopAbs_ShapeEnum) : 'MISSING');
  console.log('TopAbs_Orientation:', oc.TopAbs_Orientation ? Object.keys(oc.TopAbs_Orientation) : 'MISSING');

  // Quick test: create a point
  try {
    const p = new oc.gp_Pnt_3(1, 2, 3);
    console.log('gp_Pnt_3 works! X=', p.X(), 'Y=', p.Y(), 'Z=', p.Z());
    p.delete();
  } catch (e) {
    console.error('gp_Pnt_3 failed:', e);
  }

  // Quick test: create a polygon wire
  try {
    const p1 = new oc.gp_Pnt_3(0, 0, 0);
    const p2 = new oc.gp_Pnt_3(10, 0, 0);
    const p3 = new oc.gp_Pnt_3(10, 10, 0);
    const poly = new oc.BRepBuilderAPI_MakePolygon_1();
    poly.Add_1(p1);
    poly.Add_1(p2);
    poly.Add_1(p3);
    poly.Close();
    const wire = poly.Wire();
    console.log('MakePolygon works! Wire:', wire);

    // Try MakeFace with this wire
    for (let i = 1; i <= 25; i++) {
      const ctor = oc[`BRepBuilderAPI_MakeFace_${i}`];
      if (typeof ctor !== 'function') continue;
      try {
        const fb = new ctor(wire, true);
        console.log(`BRepBuilderAPI_MakeFace_${i}(wire, true) WORKS!`);
        fb.delete();
        break;
      } catch {
        // try without boolean
        try {
          const fb = new ctor(wire);
          console.log(`BRepBuilderAPI_MakeFace_${i}(wire) WORKS!`);
          fb.delete();
          break;
        } catch {
          // not this one
        }
      }
    }

    p1.delete(); p2.delete(); p3.delete(); poly.delete();
  } catch (e) {
    console.error('Polygon test failed:', e);
  }

  console.log('=== Done ===');
}

// Auto-export to window for easy console access
if (typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__occtDiagnose = diagnose;
}
