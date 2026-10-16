"""Tests for the organic helpers (modeling/organic.py): spokes, frames, windows
and truss lightening, all exact B-rep. The geometry is built here; the helpers
run in-process (and through the engine for the report)."""

from build123d import Align, Axis, Box, Cylinder, GeomType, Polyline, Pos, extrude, make_face
from django.test import SimpleTestCase
from OCP.BRepOffset import BRepOffset_Analyse
from OCP.ChFiDS import ChFiDS_Concave

from modeling import organic
from modeling.auto_round import auto_round
from modeling.engine import run_script


def _rep():
    rep = {}
    return rep, rep.update


def _planar(shape, normal):
    """The planar faces of `shape` whose normal is `normal` (a Vector-like tuple)."""
    n = Pos(*normal).position
    return [f for f in shape.faces() if f.geom_type == GeomType.PLANE
            and (f.normal_at(f.center()) - n).length < 1e-6]


def _trapezoid(hole_at=(0, 12), hole_d=4.5):
    """100 × 55 × 7: a 100 mm base, a 50 mm top, on Z=0, with one hole."""
    plate = extrude(make_face(Polyline((-50, 0), (50, 0), (25, 55), (-25, 55), close=True)), 7)
    return plate - Pos(*hole_at, 0) * Cylinder(hole_d / 2, 40)


def _vertical_concave(shape) -> int:
    analyse = BRepOffset_Analyse(shape.wrapped, 0.01)
    n = 0
    for e in shape.edges():
        d = e @ 1 - e @ 0
        if e.geom_type == GeomType.LINE and abs(d.Z) > 1e-6 and abs(d.X) + abs(d.Y) < 1e-6 \
                and {iv.Type() for iv in analyse.Type(e.wrapped)} == {ChFiDS_Concave}:
            n += 1
    return n


def _top(part):
    return part.faces().sort_by(Axis.Z)[-1]


def _bed(part):
    return part.faces().sort_by(Axis.Z)[0]


class SpokeTests(SimpleTestCase):
    def test_a_straight_spoke_is_one_valid_solid_with_its_end_widths(self):
        s = organic.spoke((0, 0, 0), (60, 0, 0), 10, 6, 5)
        self.assertTrue(s.is_valid)
        self.assertEqual(len(s.solids()), 1)
        ends = sorted(_planar(s, (-1, 0, 0)) + _planar(s, (1, 0, 0)), key=lambda f: f.center().X)
        self.assertEqual(len(ends), 2)
        for f, w in zip(ends, (10, 6)):
            bb = f.bounding_box()
            self.assertAlmostEqual(bb.max.Y - bb.min.Y, w, delta=0.02 * w)
            self.assertAlmostEqual(bb.max.Z - bb.min.Z, 5, delta=0.02 * 5)
        # the ends reach `overlap` (1 mm) past a and b
        self.assertAlmostEqual(ends[0].center().X, -1.0, delta=1e-6)
        self.assertAlmostEqual(ends[1].center().X, 61.0, delta=1e-6)

    def test_volume_grows_with_the_root_width(self):
        vols = [organic.spoke((0, 0, 0), (60, 0, 0), w0, 6, 5).volume for w0 in (6, 9, 12)]
        self.assertLess(vols[0], vols[1])
        self.assertLess(vols[1], vols[2])

    def test_bow_moves_the_midpoint_sideways(self):
        for section in ("ellipse", "rounded_rect"):
            s = organic.spoke((0, 0, 0), (60, 0, 0), 8, 8, 5, bow=6, section=section)
            self.assertTrue(s.is_valid)
            mid = s & (Pos(30, 0, 0) * Box(0.2, 100, 100))   # a thin slice at the middle
            self.assertAlmostEqual(mid.center().Y, 6.0, delta=0.15)   # to the left of a→b
            self.assertAlmostEqual(mid.center().Z, 0.0, delta=1e-3)
            s = organic.spoke((0, 0, 0), (60, 0, 0), 8, 8, 5, bow=6, bow_dir=(0, -1, 0), section=section)
            mid = s & (Pos(30, 0, 0) * Box(0.2, 100, 100))
            self.assertAlmostEqual(mid.center().Y, -6.0, delta=0.15)

    def test_flat_bottom_gives_a_planar_underside_at_that_z(self):
        for section in ("ellipse", "rounded_rect"):
            s = organic.spoke((0, 0, 0), (60, 0, 0), 10, 6, 5, bow=4, section=section, flat_bottom_z=-1)
            self.assertTrue(s.is_valid)
            self.assertAlmostEqual(s.bounding_box().min.Z, -1.0, delta=1e-6)   # nothing below
            bottoms = _planar(s, (0, 0, -1))
            self.assertEqual(len(bottoms), 1)
            self.assertTrue(all(abs(v.Z + 1) < 1e-6 for v in bottoms[0].vertices()))

    def test_overhang_and_thin_warnings(self):
        rep, sink = _rep()
        organic.spoke((0, 0, 0), (60, 0, 0), 8, 8, 5, report=sink)   # horizontal, not flat-bottomed
        self.assertEqual([w["kind"] for w in rep["warnings"]], ["overhang"])
        rep, sink = _rep()
        organic.spoke((0, 0, 0), (0, 5, 60), 8, 8, 5, report=sink)   # nearly vertical
        self.assertEqual(rep["warnings"], [])
        rep, sink = _rep()
        organic.spoke((0, 0, 0), (60, 0, 0), 1.2, 1.2, 4, flat_bottom_z=0, report=sink)
        self.assertEqual([w["kind"] for w in rep["warnings"]], ["thin"])


class FrameTests(SimpleTestCase):
    NODES = {"a": (0, 0, 0, 8), "b": (60, 0, 0, 6), "c": (30, 40, 0, 6)}

    def test_a_triangle_is_one_valid_solid(self):
        for fb in (0, None):
            rep, sink = _rep()
            members = [("a", "b", 8, 5, 5, 3), ("b", "c", 6, 5, 5, 2), ("c", "a", 8, 5, 5, -3)]
            f = organic.frame(self.NODES, members, flat_bottom_z=fb, report=sink)
            self.assertTrue(f.is_valid)
            self.assertEqual(len(f.solids()), 1)
            self.assertEqual(rep["members"], 3)
            self.assertEqual(rep["failed"], [])
            if fb is not None:   # flat: on the bed, a hub as high as its thickest member
                bb = f.bounding_box()
                self.assertAlmostEqual(bb.min.Z, 0, delta=1e-6)
                self.assertAlmostEqual(bb.max.Z, 5, delta=1e-3)
                self.assertTrue(_planar(f, (0, 0, -1)))

    def test_flat_joints_are_blended_and_auto_round_finishes_it(self):
        members = [("a", "b", 8, 5, 5, 3), ("b", "c", 6, 5, 5, 2), ("c", "a", 8, 5, 5, -3)]
        rep, sink = _rep()
        f = organic.frame(self.NODES, members, flat_bottom_z=0, blend=2, report=sink)
        # the vertical inside corners where members meet hubs are blended; any
        # left sharp is reported
        self.assertGreaterEqual(_vertical_concave(organic.frame(self.NODES, members, flat_bottom_z=0, blend=0)), 6)
        sharp = [w for w in rep["warnings"] if w["kind"] == "blend" and "left sharp" in w["message"]]
        self.assertEqual(_vertical_concave(f), len(sharp))
        self.assertLessEqual(len(sharp), 1)
        rep, sink = _rep()
        out = auto_round(f, convex=1.5, concave=2.0, report=sink)
        self.assertTrue(out.is_valid)
        self.assertGreater(rep["rounded"], 0)
        self.assertEqual(rep["skipped"], [])
        bed = _bed(out)
        self.assertAlmostEqual(bed.area, _bed(f).area, delta=1e-6)   # the bed's kept

    def test_an_impossible_member_is_reported_not_fatal(self):
        rep, sink = _rep()
        nodes = dict(self.NODES, d=(0, 0, 0, 4))   # d sits on a
        members = [("a", "b", 8, 5, 5, 0), ("a", "d", 6, 6, 5, 0), ("b", "nowhere", 6, 6, 5, 0),
                   ("b", "c", 6, 0, 5, 0)]         # a zero tip width
        f = organic.frame(nodes, members, flat_bottom_z=0, report=sink)
        self.assertTrue(f.is_valid)
        self.assertEqual(len(f.solids()), 1)
        self.assertEqual(rep["members"], 1)
        failed = " | ".join(rep["failed"])
        for label in ("a–d", "b–nowhere", "b–c"):
            self.assertIn(label, failed)
        self.assertIn("c", "".join(rep["failed"]))

    def test_a_thin_member_warns(self):
        rep, sink = _rep()
        organic.frame(self.NODES, [("a", "b", 1.2, 1.2, 4, 0)], flat_bottom_z=0, report=sink)
        self.assertIn("thin", [w["kind"] for w in rep["warnings"]])


class WindowTests(SimpleTestCase):
    def test_a_through_window_and_a_pocket(self):
        plate = _trapezoid()
        outline = [(-20, 25), (20, 25), (10, 45), (-10, 45)]
        out = organic.window(plate, _top(plate), outline, 3)
        self.assertTrue(out.is_valid)
        self.assertEqual(len(_bed(out).inner_wires()), 2)   # the hole + the window, through
        rep, sink = _rep()
        out = organic.window(plate, _top(plate), outline, 3, depth=5.5, report=sink)
        self.assertTrue(out.is_valid)
        self.assertEqual(len(_bed(out).inner_wires()), 1)   # the floor's still there
        self.assertLess(out.volume, plate.volume)
        self.assertEqual([w["kind"] for w in rep["warnings"]], ["thin"])   # a 1.5 mm floor

    def test_it_refuses_to_cut_a_hole_wall(self):
        plate = _trapezoid()
        with self.assertRaisesRegex(ValueError, "protected"):
            organic.window(plate, _top(plate), [(-5, 8), (5, 8), (5, 16), (-5, 16)], 1)


class TrussWindowTests(SimpleTestCase):
    ARGS = dict(rim=6, rib=5, anchors=[(0, 12)], corner_r=2.5, max_span=30)

    def _truss(self, **kw):
        plate = _trapezoid()
        rep, sink = _rep()
        out = organic.truss_windows(plate, _top(plate), report=sink, **{**self.ARGS, **kw})
        return plate, out, rep

    def test_windows_go_through_and_take_20_to_40_percent(self):
        for pattern in ("fan", "triangulate"):
            plate, out, rep = self._truss(pattern=pattern)
            self.assertTrue(out.is_valid)
            self.assertEqual(len(out.solids()), 1)
            self.assertGreater(rep["windows"], 3)
            # through: each window is a hole in the bed as well as the top
            self.assertEqual(len(_bed(out).inner_wires()), 1 + rep["windows"])
            self.assertEqual(len(_top(out).inner_wires()), 1 + rep["windows"])
            removed = 100 * (1 - out.volume / plate.volume)
            self.assertAlmostEqual(rep["removed_pct"], removed, delta=0.01)
            self.assertTrue(20 <= removed <= 40, removed)
            self.assertTrue(all(d["reason"] == "small" for d in rep["dropped"]))

    def test_the_hole_keeps_at_least_rim_around_it(self):
        plate, out, _ = self._truss()
        hole = [f for f in out.faces() if f.geom_type == GeomType.CYLINDER and f.radius == 2.25]
        self.assertEqual(len(hole), 1)
        old = [f for f in plate.faces() if f.geom_type == GeomType.CYLINDER][0]
        self.assertAlmostEqual(hole[0].area, old.area, delta=1e-6)   # untouched
        bed = _bed(out)
        windows = [w for w in bed.inner_wires() if (w.bounding_box().center() - Pos(0, 12, 0).position).length > 1]
        self.assertTrue(windows)
        for w in windows:
            self.assertGreaterEqual(hole[0].distance_to(w), self.ARGS["rim"] - 1e-6)

    def test_the_bed_outside_the_windows_is_unchanged(self):
        plate, out, _ = self._truss()
        old, new = _bed(plate), _bed(out)
        self.assertEqual(new.geom_type, GeomType.PLANE)
        self.assertTrue(all(abs(v.Z) < 1e-9 for v in new.vertices()))
        outline = lambda f: make_face(f.outer_wire()).area   # noqa: E731
        self.assertAlmostEqual(outline(new), outline(old), delta=1e-6)
        self.assertEqual(len(new.outer_wire().edges()), len(old.outer_wire().edges()))
        cut = sum(make_face(w).area for w in new.inner_wires()) - sum(make_face(w).area for w in old.inner_wires())
        self.assertAlmostEqual(new.area, old.area - cut, delta=1e-4)

    def test_auto_round_after_it_rounds_the_windows_but_not_the_hole(self):
        plate, out, _ = self._truss()
        rep, sink = _rep()
        done = auto_round(out, convex=1.0, concave=2.0, report=sink)
        self.assertTrue(done.is_valid)
        self.assertEqual(rep["protected"], 2)                    # the bed + the hole
        self.assertEqual(rep["skipped"], [])
        self.assertGreater(rep["rounded"], 8 * 3)                 # every window's rim
        hole = [f for f in done.faces() if f.geom_type == GeomType.CYLINDER and abs(f.radius - 2.25) < 1e-9]
        self.assertEqual(len(hole), 1)
        old = [f for f in plate.faces() if f.geom_type == GeomType.CYLINDER][0]
        self.assertAlmostEqual(hole[0].area, old.area, delta=1e-6)
        self.assertEqual(_bed(done).geom_type, GeomType.PLANE)
        self.assertAlmostEqual(_bed(done).area, _bed(out).area, delta=1e-6)

    def test_a_boss_keeps_its_clearance(self):
        boss = Pos(0, 35, 7) * Cylinder(5, 6, align=(Align.CENTER, Align.CENTER, Align.MIN))
        plate = _trapezoid() + boss
        rep, sink = _rep()
        out = organic.truss_windows(plate, _plate_top(plate), report=sink, **self.ARGS)
        self.assertTrue(out.is_valid)
        self.assertGreater(rep["windows"], 0)
        windows = [w for w in _bed(out).inner_wires() if (w.bounding_box().center() - Pos(0, 12, 0).position).length > 1]
        self.assertTrue(windows)
        for w in windows:
            self.assertGreaterEqual(boss.distance_to(w), 3.0 - 1e-6)   # keep_clear

    def test_thin_ribs_warn(self):
        _, _, rep = self._truss(rib=1.2)
        self.assertIn("rib 1.2 mm, under min_wall 2 mm", [w["message"] for w in rep["warnings"]])


def _plate_top(part):
    """The plate's top face (Z=7) — not the boss's."""
    return [f for f in part.faces() if f.geom_type == GeomType.PLANE and abs(f.center().Z - 7) < 1e-6
            and f.normal_at(f.center()).Z > 0][0]


class EngineTests(SimpleTestCase):
    def test_the_engine_returns_the_report(self):
        code = ('P = dict(min_wall=2.0, w=1.2)\n'
                'part = frame({"a": (0, 0, 0, 6), "b": (50, 0, 0, 6), "c": (25, 30, 0, 5)},\n'
                '             [("a", "b", 8, 6, 4, 2), ("b", "c", 6, P["w"], 4, 2), ("c", "zz", 5, 5, 4, 0)],\n'
                '             flat_bottom_z=0)\n')
        r = run_script(code)
        self.assertTrue(r["ok"], r.get("error"))
        rep = r["organic"]
        self.assertEqual(rep["members"], 2)
        self.assertEqual(len(rep["failed_members"]), 1)
        self.assertEqual([w["kind"] for w in rep["warnings"]], ["thin"])
        self.assertIsNone(rep["removed_pct"])
        # min_wall comes from P
        r = run_script(code.replace("min_wall=2.0", "min_wall=1.0"))
        self.assertEqual(r["organic"]["warnings"], [])

    def test_truss_through_the_engine(self):
        code = ('P = dict(rim=6, rib=5, corner_r=2.5)\n'
                'part = extrude(make_face(Polyline((-50, 0), (50, 0), (25, 55), (-25, 55), close=True)), 7)\n'
                'part -= Pos(0, 12, 0) * Cylinder(2.25, 40)\n'
                'part = truss_windows(part, part.faces().sort_by(Axis.Z)[-1], P["rim"], P["rib"],\n'
                '                     [(0, 12)], P["corner_r"], max_span=30)\n')
        r = run_script(code)
        self.assertTrue(r["ok"], r.get("error"))
        self.assertGreater(r["organic"]["windows"], 3)
        self.assertTrue(20 <= r["organic"]["removed_pct"] <= 40)

    def test_no_report_without_organic_calls(self):
        self.assertNotIn("organic", run_script("part = Box(1, 1, 1)"))
