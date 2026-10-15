"""Tests for perturbation-derived parameter dimensions."""

from django.test import SimpleTestCase

from modeling.engine import run_script
from modeling.sensitivity import sensitivity


def _face_by_normal(faces, n, kind="plane"):
    """The (first) face of `kind` whose normal is `n`."""
    return next(f for f in faces
                if f["kind"] == kind and sum(f["normal"][i] * n[i] for i in range(3)) > 0.99)


class SensitivityTests(SimpleTestCase):
    def test_thickness_gets_a_length_dimension_on_the_faces_it_moves(self):
        code = 'P = dict(w=20, thick=5)\npart = Box(P["w"], P["w"], P["thick"])'
        m = sensitivity(code)
        self.assertIn("thick", m)
        info = m["thick"]
        self.assertEqual(info["value"], 5)
        self.assertTrue(info["faces"])            # it controls some faces
        self.assertEqual(info["kind"], "length")  # a clean translation was found
        self.assertIsNotNone(info["anchor"])
        self.assertIsNotNone(info["dir"])
        # thickness is the Z extent of the box → the moved face travels along Z
        self.assertGreater(abs(info["dir"][2]), 0.9)

    def test_symmetric_width_shifts_the_side_walls_in_opposite_directions(self):
        code = 'P = dict(w=20, thick=5)\npart = Box(P["w"], P["w"], P["thick"])'
        faces = run_script(code)["faces"]
        right = _face_by_normal(faces, [1, 0, 0])["index"]
        left = _face_by_normal(faces, [-1, 0, 0])["index"]
        shifts = sensitivity(code)["w"]["shifts"]
        self.assertIn(right, shifts)
        self.assertIn(left, shifts)
        # a centered box grows half the width on each side: ±0.5 per unit of w
        self.assertAlmostEqual(shifts[right][0], 0.5, places=2)
        self.assertAlmostEqual(shifts[left][0], -0.5, places=2)
        for i in (1, 2):
            self.assertAlmostEqual(shifts[right][i], 0.0, places=2)
            self.assertAlmostEqual(shifts[left][i], 0.0, places=2)

    def test_hole_diameter_shifts_the_hole_wall_radially(self):
        code = ('P = dict(thick=6, hole_d=8)\n'
                'part = Pos(0, 0, P["thick"]/2) * Box(40, 40, P["thick"])\n'
                'part -= Pos(0, 0, P["thick"]/2) * Cylinder(P["hole_d"]/2, P["thick"]*2)')
        faces = run_script(code)["faces"]
        wall = next(f for f in faces if f["kind"] == "cylinder")
        m = sensitivity(code)
        s = m["hole_d"]["shifts"][wall["index"]]
        # the wall's center is on the surface and its normal points into the
        # hole; growing the diameter moves it back into the material by ½ per unit
        along = sum(s[i] * wall["normal"][i] for i in range(3))
        self.assertAlmostEqual(along, -0.5, places=2)
        self.assertAlmostEqual(m["hole_d"]["radial"][wall["index"]], 0.5, places=2)
        # thickness doesn't change the hole's radius
        self.assertNotIn(wall["index"], m["thick"]["radial"])
        # thickness moves the top face up 1:1 and leaves the hole wall's radius alone
        top = _face_by_normal(faces, [0, 0, 1])["index"]
        self.assertAlmostEqual(m["thick"]["shifts"][top][2], 1.0, places=2)

    def test_sliding_hole_shifts_without_a_radius_change(self):
        # moving a hole along its wall normal looks like a diameter change from
        # the wall's center alone — `radial` is what tells them apart
        code = ('P = dict(hx=5)\n'
                'part = Pos(0, 0, 3) * Box(40, 40, 6)\n'
                'part -= Pos(P["hx"], 0, 3) * Cylinder(4, 12)')
        faces = run_script(code)["faces"]
        wall = next(f for f in faces if f["kind"] == "cylinder")
        info = sensitivity(code)["hx"]
        self.assertAlmostEqual(info["shifts"][wall["index"]][0], 1.0, places=2)
        self.assertEqual(info["radial"], {})

    def test_shifts_only_name_faces_the_param_controls(self):
        code = 'P = dict(w=20, thick=5)\npart = Box(P["w"], P["w"], P["thick"])'
        for info in sensitivity(code).values():
            self.assertTrue(set(info["shifts"]) <= set(info["faces"]))

    def test_every_param_is_reported(self):
        code = 'P = dict(w=20, thick=5)\npart = Box(P["w"], P["w"], P["thick"])'
        m = sensitivity(code)
        self.assertEqual(set(m), {"w", "thick"})

    def test_no_params_returns_empty(self):
        self.assertEqual(sensitivity("part = Box(10, 10, 10)"), {})
