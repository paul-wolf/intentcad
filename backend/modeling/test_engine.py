"""Tests for the build123d execution engine (the new modeler core)."""

from django.test import SimpleTestCase

from modeling.engine import EngineError, run_script


class EngineTests(SimpleTestCase):
    def test_builds_a_solid_and_returns_artifacts(self):
        r = run_script("part = Box(10, 10, 10) - Cylinder(3, 20)", export=["step", "stl"])
        self.assertTrue(r["ok"])
        self.assertGreater(r["mesh"]["triangle_count"], 0)
        self.assertEqual(len(r["mesh"]["positions"]), r["mesh"]["triangle_count"] * 9)
        self.assertTrue(r["exports"]["step"].startswith("ISO-10303-21;"))
        self.assertTrue(r["exports"]["stl"].lstrip().startswith("solid"))
        self.assertLess(r["metrics"]["volume"], 1000)  # box minus a hole

    def test_plain_run_has_no_exports(self):
        r = run_script("part = Box(5, 5, 5)")
        self.assertEqual(r.get("exports", {}), {})

    def test_failing_op_renders_up_to_it_with_a_warning(self):
        # a chamfer far too big fails; the box before it should still render
        r = run_script("part = Box(10, 10, 10)\npart = chamfer(part.edges(), length=100)")
        self.assertTrue(r["ok"])
        self.assertGreater(r["mesh"]["triangle_count"], 0)  # the box rendered
        self.assertIsNotNone(r.get("warning"))
        self.assertIn("chamfer", r["warning"].lower())

    def test_error_before_any_part_still_fails(self):
        with self.assertRaises(EngineError):
            run_script("x = chamfer(nope, length=1)")  # no `part` ever bound

    def test_result_alias(self):
        r = run_script("result = Box(5, 5, 5)")  # `result` also accepted
        self.assertTrue(r["ok"])

    def test_missing_part_is_an_error(self):
        with self.assertRaises(EngineError):
            run_script("x = 1 + 1")

    def test_syntax_error_is_reported_not_crashed(self):
        with self.assertRaises(EngineError):
            run_script("part = Box(1,1,1")

    def test_runtime_error_is_reported(self):
        with self.assertRaises(EngineError):
            run_script("part = Box(1, 1, 1).faces().nonexistent_method()")
