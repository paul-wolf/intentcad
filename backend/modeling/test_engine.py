"""Tests for the build123d execution engine (the new modeler core)."""

import os
from unittest import mock

from django.test import SimpleTestCase

from modeling.engine import EngineError, run_script, _sandbox, _min_env


class EngineTests(SimpleTestCase):
    def test_builds_a_solid_and_returns_artifacts(self):
        r = run_script("part = Box(10, 10, 10) - Cylinder(3, 20)", export=["step", "stl"])
        self.assertTrue(r["ok"])
        self.assertGreater(r["mesh"]["triangle_count"], 0)
        self.assertEqual(len(r["mesh"]["positions"]), r["mesh"]["triangle_count"] * 9)
        self.assertTrue(r["exports"]["step"].startswith("ISO-10303-21;"))
        self.assertTrue(r["exports"]["stl"].lstrip().startswith("solid"))
        self.assertLess(r["metrics"]["volume"], 1000)  # box minus a hole

    def test_dxf_export_is_a_flat_outline_with_holes(self):
        # 40x24 sheet with a 6mm-dia hole: DXF should be the top-down cut profile
        r = run_script("part = Box(40, 24, 3) - Pos(8, 4, 0) * Cylinder(3, 6)",
                       export=["dxf"])
        self.assertTrue(r["ok"])
        dxf = r["exports"]["dxf"]
        self.assertIn("SECTION", dxf)
        self.assertIn("ENTITIES", dxf)
        self.assertIn("CIRCLE", dxf)  # the through-hole survives as a circle
        self.assertIn("LINE", dxf)    # the rectangular outline

    def test_dxf_views_zips_top_front_and_side(self):
        import base64
        import io
        import zipfile

        r = run_script("part = Box(40, 24, 3) - Pos(8, 4, 0) * Cylinder(3, 6)",
                       export=["dxf-views"])
        self.assertTrue(r["ok"])
        zf = zipfile.ZipFile(io.BytesIO(base64.b64decode(r["exports"]["dxf-views"])))
        self.assertEqual(sorted(zf.namelist()), ["front.dxf", "side.dxf", "top.dxf"])
        # only the top view sees the through-hole (its axis is Z)
        self.assertIn("CIRCLE", zf.read("top.dxf").decode())
        self.assertNotIn("CIRCLE", zf.read("front.dxf").decode())

    def test_cylindrical_face_reports_its_radius(self):
        r = run_script("part = Box(20, 20, 10) - Cylinder(3, 20)")
        cyls = [f for f in r["faces"] if f["kind"] == "cylinder"]
        self.assertTrue(cyls)
        self.assertAlmostEqual(cyls[0]["radius"], 3.0, places=3)
        # flat faces have no radius
        planes = [f for f in r["faces"] if f["kind"] == "plane"]
        self.assertIsNone(planes[0]["radius"])

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

    def test_sandbox_off_uses_plain_subprocess(self):
        with mock.patch.dict(os.environ, {"MODELING_SANDBOX": "off"}):
            self.assertEqual(_sandbox(), ([], None))

    def test_sandbox_falls_back_when_bwrap_absent(self):
        with mock.patch.dict(os.environ, {"MODELING_SANDBOX": "auto"}), \
             mock.patch("modeling.engine.shutil.which", return_value=None):
            self.assertEqual(_sandbox(), ([], None))

    def test_sandbox_wraps_when_bwrap_present(self):
        with mock.patch.dict(os.environ, {"MODELING_SANDBOX": "auto"}), \
             mock.patch("modeling.engine.shutil.which", return_value="/usr/bin/bwrap"):
            prefix, env = _sandbox()
            self.assertEqual(prefix[0], "/usr/bin/bwrap")
            self.assertIn("--unshare-all", prefix)
            self.assertIsNotNone(env)

    def test_min_env_scrubs_secrets(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_KEY": "sk-secret", "DB_PASSWORD": "pw", "PATH": "/bin"}):
            env = _min_env()
            self.assertNotIn("ANTHROPIC_KEY", env)
            self.assertNotIn("DB_PASSWORD", env)
            self.assertIn("PATH", env)
