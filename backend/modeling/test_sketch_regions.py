"""Regions of a sketch: closed shapes that overlap split it into regions, the
default takes the outlines (a shape fully inside another is a hole), and an
extrude can pick its regions with sketch("name", regions=[(x, y), ...])."""

from django.test import SimpleTestCase

from .engine import EngineError, run_script
from .paramedit import add_extrude, op_at, steps
from .sketch_profile import SketchError, picked_faces, profile_regions, region_view
from .test_shared_defs import XY, _rect


def profile(*loops):
    return {"plane": XY, "loops": list(loops)}


def circle(x, y, r):
    return [{"t": "circle", "c": [x, y], "r": r}]


# a 30 mm square with a 10 × 20 rectangle crossing its top edge (sketch y is down)
NOTCHED = profile(_rect(-15, -15, 15, 15), _rect(-5, -25, 5, -5))


def area(faces):
    return sum(f.area for f in faces)


class RegionTests(SimpleTestCase):
    def test_crossing_shapes_split_into_regions_and_default_to_their_union(self):
        regions = profile_regions(NOTCHED)
        self.assertEqual(len(regions), 3)
        self.assertEqual(sorted(round(r.face.area) for r in regions), [100, 100, 800])
        self.assertTrue(all(r.default for r in regions))
        self.assertAlmostEqual(area(picked_faces(NOTCHED, "s", [r.point for r in regions])), 1000, places=3)

    def test_the_square_less_the_rectangle_is_a_notch(self):
        main = max(profile_regions(NOTCHED), key=lambda r: r.face.area)
        faces = picked_faces(NOTCHED, "s", [main.point])
        self.assertAlmostEqual(area(faces), 800, places=3)

    def test_a_circle_inside_a_square_is_a_hole_by_default(self):
        p = profile(_rect(-15, -15, 15, 15), circle(0, 0, 5))
        regions = profile_regions(p)
        self.assertEqual([r.default for r in sorted(regions, key=lambda r: r.face.area)], [False, True])

    def test_an_island_in_a_hole_is_taken_again(self):
        p = profile(_rect(-20, -20, 20, 20), _rect(-10, -10, 10, 10), circle(0, 0, 3))
        by_area = sorted(profile_regions(p), key=lambda r: r.face.area)
        self.assertEqual([r.default for r in by_area], [True, False, True])

    def test_a_point_in_no_region_is_an_error(self):
        with self.assertRaisesRegex(SketchError, "a region picked for this step is gone"):
            picked_faces(NOTCHED, "s", [(100, 100)])

    def test_region_view_gives_points_fills_and_outlines(self):
        view = region_view(NOTCHED)
        self.assertEqual(len(view), 3)
        for r in view:
            self.assertEqual(len(r["point"]), 2)
            self.assertTrue(r["tris"])
            self.assertTrue(r["edges"])
        self.assertAlmostEqual(sum(r["area"] for r in view), 1000, places=3)


class RegionLineTests(SimpleTestCase):
    def test_regions_are_written_on_the_sketch_and_read_back(self):
        code, key = add_extrude("", "Plate", "new", depth=2, regions=[[0, 0.5], [-0.0001, 12.34567]])
        self.assertIn('part = extrude(sketch("Plate", regions=[(0, 0.5), (0, 12.346)]), amount=P["body1_height"])',
                      code)
        args = op_at(code, 3)["args"]
        self.assertEqual(args["sketch"], "Plate")
        self.assertEqual(args["regions"], [[0, 0.5], [0, 12.346]])
        self.assertIn("2 regions picked", steps(code)[0]["summary"])

    def test_rewriting_the_line_keeps_or_drops_the_pick(self):
        code, _ = add_extrude("", "Plate", "new", depth=2, regions=[[0, 0]])
        out, _ = add_extrude(code, "Plate", "new", depth=4, line=3, regions=[[0, 0]])
        self.assertIn('sketch("Plate", regions=[(0, 0)])', out)
        out, _ = add_extrude(code, "Plate", "new", depth=4, line=3)
        self.assertIn('extrude(sketch("Plate"), ', out)
        self.assertNotIn("regions", out)

    def test_the_notch_builds_and_a_lost_region_fails_the_build(self):
        main = max(profile_regions(NOTCHED), key=lambda r: r.face.area)
        code, _ = add_extrude("", "Plate", "new", depth=2, regions=[main.point])
        r = run_script(code, sketches={"Plate": NOTCHED})
        self.assertAlmostEqual(r["metrics"]["volume"], 1600, delta=0.5)
        default, _ = add_extrude("", "Plate", "new", depth=2)
        self.assertAlmostEqual(run_script(default, sketches={"Plate": NOTCHED})["metrics"]["volume"], 2000, delta=0.5)
        smaller = profile(_rect(-15, -15, -10, -10))     # the sketch edited: the picked point is outside
        with self.assertRaisesRegex(EngineError, "a region picked for this step is gone"):
            run_script(code, sketches={"Plate": smaller})
