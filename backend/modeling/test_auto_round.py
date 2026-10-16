"""Tests for auto_round (modeling/auto_round.py): every eligible edge rounded in
exact B-rep, protected faces left exactly as they were. The geometry is built
here; auto_round runs in-process (and through the engine for the report)."""

from unittest import mock

from build123d import Align, Axis, Box, Compound, Cylinder, GeomType, Pos
from django.test import SimpleTestCase
from OCP.BRepAdaptor import BRepAdaptor_Surface

from modeling import auto_round as ar
from modeling.auto_round import auto_round
from modeling.engine import run_script

MIN = (Align.CENTER, Align.CENTER, Align.MIN)   # centered in XY, resting on Z=0


def _round(part, **kw):
    """auto_round's result and its report."""
    rep = {}
    out = auto_round(part, report=rep.update, **kw)
    return out, rep


def _cylinders(shape):
    """[(radius, axis, center)] of the cylindrical faces."""
    out = []
    for f in shape.faces():
        if f.geom_type != GeomType.CYLINDER:
            continue
        c = BRepAdaptor_Surface(f.wrapped).Cylinder()
        d = c.Axis().Direction()
        out.append((c.Radius(), (d.X(), d.Y(), d.Z()), f.center()))
    return out


def _count(shape, geom):
    return sum(1 for f in shape.faces() if f.geom_type == geom)


def _face_like(shape, face, tol=1e-6):
    """The face of `shape` on the same plane as `face`, with the same center."""
    n, c = face.normal_at(), face.center()
    for f in shape.faces():
        if f.geom_type == GeomType.PLANE and (f.normal_at() - n).length < tol \
                and (f.center() - c).length < tol:
            return f
    return None


def _box_on_plate():
    return Box(40, 40, 5, align=MIN) + Pos(0, 0, 5) * Box(20, 20, 10, align=MIN)


class AutoRoundTests(SimpleTestCase):
    def test_box_on_plate_rounds_top_and_blends_joint_but_keeps_the_bed(self):
        part = _box_on_plate()
        bed = part.faces().sort_by(Axis.Z)[0]
        out, rep = _round(part, convex=1.0, concave=2.0)
        self.assertTrue(out.is_valid)
        self.assertEqual(len(out.solids()), 1)
        # the bed: exactly planar at Z=0, same area, same boundary
        new_bed = _face_like(out, bed)
        self.assertIsNotNone(new_bed)
        self.assertEqual(new_bed.geom_type, GeomType.PLANE)
        self.assertAlmostEqual(new_bed.area, bed.area, delta=1e-6)
        self.assertEqual(len(new_bed.edges()), len(bed.edges()))
        self.assertTrue(all(abs(v.Z) < 1e-9 for v in new_bed.vertices()))
        # the box's 4 top edges get the convex radius, the box/plate joint the concave one
        cyl = _cylinders(out)
        top = [r for r, _, c in cyl if c.Z > 14]
        joint = [r for r, _, c in cyl if 5 < c.Z < 7.5 and abs(r - 2.0) < 1e-6]
        self.assertEqual(len(top), 4)
        self.assertTrue(all(abs(r - 1.0) < 1e-6 for r in top))
        self.assertEqual(len(joint), 4)
        self.assertGreater(out.volume, part.volume)   # the joint blend adds more than the rounds remove
        self.assertEqual(rep["skipped"], [])
        self.assertEqual(rep["rounded"], 16)   # box top 4 + box vertical 4 + joint 4 + plate top 4

    def test_a_kept_face_stays_identical_while_its_neighbours_round(self):
        part = _box_on_plate()
        side = part.faces().filter_by(Axis.X).filter_by_position(Axis.Z, 6, 20).sort_by(Axis.X)[-1]
        for keep in ([side],   # a face, or a selector evaluated on the input
                     [lambda p: p.faces().filter_by(Axis.X).filter_by_position(Axis.Z, 6, 20).sort_by(Axis.X)[-1]]):
            out, rep = _round(part, convex=1.0, concave=2.0, keep=keep)
            self.assertTrue(out.is_valid)
            kept = _face_like(out, side)
            self.assertIsNotNone(kept)
            self.assertAlmostEqual(kept.area, side.area, delta=1e-6)
            self.assertEqual(len(kept.edges()), len(side.edges()))
            self.assertAlmostEqual(kept.center().X, 10.0, delta=1e-9)
            self.assertEqual(rep["protected"], 2)   # the kept face + the bed
            # its neighbours round: the far (-X) joint blend and the plate's rim
            cyl = _cylinders(out)
            self.assertTrue(any(abs(r - 2.0) < 1e-6 and c.X < -9 and 5 < c.Z < 7.5 for r, _, c in cyl))
            self.assertEqual(len([1 for r, _, c in cyl if abs(r - 1.0) < 1e-6 and 4 < c.Z < 5]), 4)
            # nothing that ends on the kept face is rounded (it would move its
            # boundary); what's left sharp otherwise is reported — the -X top
            # edge as 'protected': its fillet would run on round the corner
            # along the ±Y top edges to the kept face
            self.assertFalse([c for _, _, c in cyl if 9 < c.X < 11 and c.Z > 5])
            reasons = {s["reason"] for s in rep["skipped"]}
            self.assertIn("protected", reasons)
            self.assertLessEqual(reasons, {"protected", "failed"})

    def test_hole_walls_stay_sharp_unless_unprotected(self):
        plate = (Box(60, 30, 5, align=MIN)
                 - Pos(15, 0, 0) * Cylinder(2.25, 20) - Pos(-15, 0, 0) * Cylinder(2.25, 20))
        walls = [f for f in plate.faces() if f.geom_type == GeomType.CYLINDER]
        out, rep = _round(plate, convex=1.0, concave=1.0)
        self.assertTrue(out.is_valid)
        self.assertEqual(rep["protected"], 3)            # 2 hole walls + the bed
        self.assertEqual(_count(out, GeomType.TORUS), 0)  # no rim was rounded
        for w in walls:   # each wall: same radius, same area
            same = [f for f in out.faces() if f.geom_type == GeomType.CYLINDER
                    and (f.center() - w.center()).length < 1e-6]
            self.assertEqual(len(same), 1)
            self.assertAlmostEqual(same[0].area, w.area, delta=1e-6)
        out, rep = _round(plate, convex=1.0, concave=1.0, protect_holes=False)
        self.assertTrue(out.is_valid)
        self.assertEqual(_count(out, GeomType.TORUS), 2)  # both top rims rounded (bottom: the bed)

    def test_a_boss_is_not_a_hole(self):
        part = Box(60, 30, 5, align=MIN) + Pos(0, 0, 5) * Cylinder(5, 8, align=MIN)   # Ø10 boss
        out, rep = _round(part, convex=1.0, concave=1.0)
        self.assertTrue(out.is_valid)
        self.assertEqual(rep["protected"], 1)             # just the bed
        self.assertEqual(_count(out, GeomType.TORUS), 2)  # boss top rim + its base blend

    def test_radius_is_capped_by_a_thin_wall(self):
        wall = Box(40, 2, 20, align=MIN)   # a 2 mm wall
        out, rep = _round(wall, convex=3.0)
        self.assertTrue(out.is_valid)
        radii = [r for r, _, _ in _cylinders(out)]
        self.assertTrue(radii)
        self.assertTrue(all(r <= 0.9 + 1e-9 for r in radii), radii)   # 0.45 x 2 mm
        self.assertEqual(rep["capped"], rep["rounded"])

    def test_edges_that_fail_together_are_split_and_the_failures_reported(self):
        # a 1 mm fin can't take a 3 mm round (no thickness cap here): the batch
        # fails as a whole (OCCT even crashes on some of it), the plate's edges
        # still round one by one, and the fin's edges are listed as skipped
        part = Box(40, 40, 5, align=MIN) + Pos(0, 0, 5) * Box(1, 30, 10, align=MIN)
        out, rep = _round(part, convex=3.0, concave=1.0, max_thickness_frac=0)
        self.assertTrue(out.is_valid)
        self.assertEqual(len(out.solids()), 1)
        self.assertGreater(rep["rounded"], 0)
        self.assertTrue(rep["skipped"])
        for s in rep["skipped"]:
            self.assertEqual(s["reason"], "failed")
            self.assertEqual(s["kind"], "convex")
            self.assertGreaterEqual(len(s["polyline"]), 2)
        # every rounded convex edge got the full 3 mm (the plate's), none of the fin's
        self.assertTrue(any(abs(r - 3.0) < 1e-6 for r, _, _ in _cylinders(out)))

    def test_a_failing_batch_is_bisected_down_to_single_edges(self):
        # one edge at a time is the worst case: once the plate's -X rim edge is
        # rounded, the ±Y rim edges run tangent into its end arcs and on down
        # the plate's corners into the bed, which must not change — so those
        # two fail (and are reported) where the rim as a whole would not
        part = _box_on_plate()
        bed = part.faces().sort_by(Axis.Z)[0]
        real = ar._fillet_isolated
        sizes = []

        def only_singles(shape, edges_radii, deadline, guard=()):
            sizes.append(len(edges_radii))
            return real(shape, edges_radii, deadline, guard) if len(edges_radii) == 1 else None

        with mock.patch.object(ar, "_fillet_isolated", only_singles):
            out, rep = _round(part, convex=1.0, concave=2.0)
        self.assertTrue(out.is_valid)
        self.assertIn(4, sizes)                # the concave group, tried whole first
        self.assertEqual(rep["rounded"] + len(rep["skipped"]), 16)
        self.assertGreaterEqual(rep["rounded"], 12)
        self.assertTrue(all(s["reason"] == "protected" for s in rep["skipped"]))
        new_bed = _face_like(out, bed)
        self.assertAlmostEqual(new_bed.area, bed.area, delta=1e-6)
        self.assertEqual(len(new_bed.edges()), 4)

    def test_out_of_time_returns_the_input_and_reports_timeouts(self):
        part = _box_on_plate()
        out, rep = _round(part, convex=1.0, concave=2.0, time_budget=0)
        self.assertTrue(out.is_valid)
        self.assertAlmostEqual(out.volume, part.volume, delta=1e-6)
        self.assertEqual(rep["rounded"], 0)
        self.assertEqual(len(rep["skipped"]), 16)
        self.assertTrue(all(s["reason"] == "timeout" for s in rep["skipped"]))

    def test_a_compound_of_two_solids_stays_two_solids(self):
        part = Compound([Box(10, 10, 10), Pos(30, 0, 0) * Box(10, 10, 10)])
        out, rep = _round(part, convex=1.0)
        self.assertIsInstance(out, Compound)
        self.assertEqual(len(out.solids()), 2)
        self.assertTrue(all(s.is_valid for s in out.solids()))
        # each box rests on the bed: its 4 top edges round; the verticals end
        # on the bed, so they stay sharp to keep its outline
        self.assertEqual(rep["rounded"], 8)

    def test_short_edges_are_left_alone(self):
        part = Box(40, 40, 5, align=MIN) + Pos(0, 0, 5) * Box(10, 10, 0.5, align=MIN)
        _, rep = _round(part, convex=0.2, concave=0.2, min_edge=1.0)
        # the 0.5 mm step's vertical edges are under min_edge: never attempted
        self.assertEqual(rep["rounded"], 4 + 4 + 4)   # plate top, step top, step base
        self.assertEqual(rep["skipped"], [])

    def test_the_engine_returns_the_report(self):
        code = ('P = dict(round_r=1.0, blend_r=2.0)\n'
                'part = Box(40, 40, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))\n'
                'part += Pos(0, 0, 5) * Box(20, 20, 10, align=(Align.CENTER, Align.CENTER, Align.MIN))\n'
                'part = auto_round(part, convex=P["round_r"], concave=P["blend_r"])\n')
        r = run_script(code)
        self.assertTrue(r["ok"])
        rep = r["auto_round"]
        self.assertEqual(rep["rounded"], 16)
        self.assertEqual(rep["skipped"], [])
        self.assertEqual(rep["protected"], 1)
        self.assertGreater(rep["elapsed"], 0)

    def test_no_report_without_auto_round(self):
        self.assertNotIn("auto_round", run_script("part = Box(1, 1, 1)"))
