"""Tests for perturbation-derived parameter dimensions."""

from django.test import SimpleTestCase

from modeling.sensitivity import sensitivity


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

    def test_every_param_is_reported(self):
        code = 'P = dict(w=20, thick=5)\npart = Box(P["w"], P["w"], P["thick"])'
        m = sensitivity(code)
        self.assertEqual(set(m), {"w", "thick"})

    def test_no_params_returns_empty(self):
        self.assertEqual(sensitivity("part = Box(10, 10, 10)"), {})
