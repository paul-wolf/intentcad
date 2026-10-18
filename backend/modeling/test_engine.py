"""Tests for the build123d execution engine (the new modeler core)."""

import json
import math
import os
from unittest import mock

from django.test import SimpleTestCase

from modeling.engine import EngineError, run_script, _sandbox, _min_env
from modeling.paramedit import add_extrude


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

    def test_failing_fillet_names_the_line_and_the_radius_that_fits(self):
        code = "P = {'r': 6}\npart = Box(10, 10, 4)\npart = fillet(part.edges().filter_by(Axis.Z), radius=P['r'])"
        r = run_script(code)
        w = r["warning"]
        self.assertIn("line 3: part = fillet(", w)        # the script line (not the import shim's)
        self.assertIn("radius 6 is too large", w)        # the plain-language cause
        self.assertIn("largest radius that works is about 5", w)  # measured, not guessed
        # ...and a structured fix naming the param that holds the bad size
        fix = r["fix"]
        self.assertEqual(fix["param"], "r")
        self.assertAlmostEqual(fix["max"], 5.0, places=1)
        self.assertLess(fix["value"], 5.0)
        # the suggested value actually builds, clean
        r2 = run_script(code.replace("'r': 6", f"'r': {fix['value']}"))
        self.assertIsNone(r2.get("warning"))

    def test_failing_polyline_fillet_reports_the_radius_for_every_corner(self):
        # a 10x3 outline: corners are filleted one at a time, and the first
        # corner alone would allow r=3 — but the 3-long side is shared by two
        # corners, so the radius that fits ALL of them is 1.5
        code = ("P = {'r': 6.0}\n"
                "bpath = Plane.XZ * FilletPolyline((0,0),(10,0),(10,3),(0,3), radius=P['r'], close=True)\n"
                "part = extrude(make_face(bpath), 2)")
        with self.assertRaises(EngineError) as cm:   # fails before `part` exists
            run_script(code)
        self.assertIn("polyline", str(cm.exception))
        self.assertIn("tightest corner", str(cm.exception))
        fix = cm.exception.fix
        self.assertAlmostEqual(fix["max"], 1.5, places=3)
        self.assertEqual(fix["param"], "r")
        r2 = run_script(code.replace("'r': 6.0", f"'r': {fix['value']}"))
        self.assertIsNone(r2.get("warning"))

    def test_hard_failure_still_reports_the_params(self):
        # the script never binds `part`, but its params are known — the UI keeps
        # its parameter editor so the user has a way to change the bad value
        with self.assertRaises(EngineError) as cm:
            run_script("P = {'r': 6.0, 'w': 10}\nbad = fillet(Box(10, 10, 4).edges(), radius=P['r'])")
        self.assertEqual(cm.exception.params, {"r": 6.0, "w": 10})

    def test_fix_without_a_matching_param_names_no_param(self):
        # fails before `part` exists → a hard error, but the fix still rides along
        with self.assertRaises(EngineError) as cm:
            run_script("with BuildSketch() as sk:\n    Rectangle(10, 3)\n    fillet(sk.vertices(), radius=6)\n"
                       "part = extrude(sk.sketch, 2)")
        fix = cm.exception.fix
        self.assertNotIn("param", fix)
        self.assertAlmostEqual(fix["max"], 1.5, places=1)

    def test_syntax_error_names_the_script_line(self):
        with self.assertRaises(EngineError) as cm:
            run_script("x = 1\npart = Box(1,1,1")
        self.assertIn("line 2: part = Box(1,1,1", str(cm.exception))

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


def _box_step() -> bytes:
    r = run_script("part = Box(30, 20, 10)", export=["step"])
    return r["exports"]["step"].encode()


class AssetEngineTests(SimpleTestCase):
    """Scripts import uploaded files by hash: ASSETS["<sha256>"] is a local path."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import hashlib
        cls.step = _box_step()
        cls.sha = hashlib.sha256(cls.step).hexdigest()
        cls.code = f'part = import_step(ASSETS["{cls.sha}"])'

    def test_run_script_imports_the_asset(self):
        r = run_script(self.code, assets={self.sha: self.step})
        self.assertEqual(len(r["faces"]), 6)
        self.assertAlmostEqual(r["metrics"]["volume"], 6000, places=3)

    def test_a_compound_of_several_solids_imports_and_exports_per_solid(self):
        import base64
        import hashlib
        import io
        import zipfile
        two = run_script("part = Compound([Box(10, 10, 10), Pos(30, 0, 0) * Cylinder(5, 10)])",
                         export=["step"])["exports"]["step"].encode()
        sha = hashlib.sha256(two).hexdigest()
        r = run_script(f'part = import_step(ASSETS["{sha}"])', export=["stl-parts"], assets={sha: two})
        zf = zipfile.ZipFile(io.BytesIO(base64.b64decode(r["exports"]["stl-parts"])))
        self.assertEqual(len(zf.namelist()), 2)

    def test_a_missing_hash_is_an_error_naming_it(self):
        with self.assertRaisesRegex(EngineError, self.sha):
            run_script(self.code, assets={})

    def test_without_a_document_it_is_an_error(self):
        with self.assertRaisesRegex(EngineError, "no document"):
            run_script(self.code)

    def test_the_worker_is_sent_each_file_once(self):
        from modeling import engine

        run_script(self.code, assets={self.sha: self.step})
        sent = []
        w = engine._worker
        real = w.proc.stdin

        class Spy:
            def write(self, s):
                sent.append(json.loads(s))
                return real.write(s)

            def flush(self):
                real.flush()

        w.proc.stdin = Spy()
        try:
            run_script(self.code, assets={self.sha: self.step})
        finally:
            w.proc.stdin = real
        self.assertEqual(sent[0]["assets"], {})              # it already holds it
        self.assertEqual(sent[0]["asset_refs"], [self.sha])

    def test_a_file_gone_from_the_worker_is_sent_again(self):
        import tempfile
        from modeling import engine

        run_script(self.code, assets={self.sha: self.step})
        os.remove(os.path.join(tempfile.gettempdir(), "assets", f"{self.sha}.step"))
        r = run_script(self.code, assets={self.sha: self.step})   # recovers, no error
        self.assertEqual(len(r["faces"]), 6)
        self.assertIn(self.sha, engine._worker.assets)

    def test_a_new_worker_holds_no_files(self):
        from modeling import engine

        run_script(self.code, assets={self.sha: self.step})
        engine._shutdown_worker()
        run_script("part = Box(1, 1, 1)")
        self.assertEqual(engine._worker.assets, set())


class WorkerProtocolTests(SimpleTestCase):
    def test_output_on_stdout_does_not_desync_the_worker(self):
        # a script's print() and OCP's native STEP-reader chatter both write to
        # fd 1; the next build must still get its own result
        run_script("print('hello')\nimport os\nos.write(1, b'native\\n')\npart = Box(1, 1, 1)")
        r = run_script("part = Box(2, 2, 2)")
        self.assertAlmostEqual(r["metrics"]["volume"], 8.0, places=6)


def _rect(x0, y0, x1, y1):
    p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    return [{"t": "line", "p": [p[i], p[(i + 1) % 4]]} for i in range(4)]


class SketchEngineTests(SimpleTestCase):
    """sketch("name") — a face sketch's closed loops as faces on its plane."""

    top = {"origin": [0, 0, 6], "normal": [0, 0, 1], "xAxis": [1, 0, 0]}
    base = "part = Pos(0, 0, 3) * Box(60, 40, 6)\nv0 = part.volume\n"

    def test_circles_cut_holes_through_the_part(self):
        prof = {"plane": self.top, "loops": [[{"t": "circle", "c": [-10, 0], "r": 3}],
                                             [{"t": "circle", "c": [10, 5], "r": 3}]]}
        code = self.base + 'part -= extrude(sketch("holes"), amount=-part.bounding_box().diagonal)\n'
        r = run_script(code, sketches={"holes": prof})
        self.assertAlmostEqual(r["metrics"]["volume"], 60 * 40 * 6 - 2 * math.pi * 9 * 6, delta=0.5)
        # sketch y points down: (10, 5) lands at world y = -5
        self.assertAlmostEqual(r["metrics"]["bbox_min"][2], 0, places=3)

    def test_join_grows_out_of_the_face_and_holes_nest(self):
        prof = {"plane": self.top, "loops": [_rect(-5, -5, 5, 5),
                                             [{"t": "circle", "c": [0, 0], "r": 2}]]}
        r = run_script(self.base + 'part += extrude(sketch("peg"), amount=4)\n', sketches={"peg": prof})
        self.assertAlmostEqual(r["metrics"]["bbox_max"][2], 10, places=3)
        self.assertAlmostEqual(r["metrics"]["volume"], 60 * 40 * 6 + (100 - math.pi * 4) * 4, delta=0.5)

    def test_new_body_from_a_base_plane_then_a_through_cut(self):
        top0 = {"origin": [0, 0, 0], "normal": [0, 0, 1], "xAxis": [1, 0, 0]}
        front = {"origin": [0, 0, 0], "normal": [0, -1, 0], "xAxis": [1, 0, 0]}
        code = (add_extrude("", "Top", "new", 6)[0]
                + 'part -= extrude(sketch("Front"), amount=part.bounding_box().diagonal'
                  ' + part.bounding_box().center().length, both=True)\n')
        # a 60x40x6 plate minus a slot 10 wide through it, front to back
        r = run_script(code, sketches={"Top": {"plane": top0, "loops": [_rect(-30, -20, 30, 20)]},
                                       "Front": {"plane": front, "loops": [_rect(-5, -10, 5, 10)]}})
        self.assertFalse(r.get("warning"))
        self.assertAlmostEqual(r["metrics"]["volume"], 60 * 40 * 6 - 10 * 6 * 40, delta=0.5)

    def test_join_both_ways_from_the_front_plane(self):
        top0 = {"origin": [0, 0, 0], "normal": [0, 0, 1], "xAxis": [1, 0, 0]}
        front = {"origin": [0, 0, 0], "normal": [0, -1, 0], "xAxis": [1, 0, 0]}
        code = add_extrude("", "Top", "new", 6)[0]
        code = add_extrude(code, "Front", "join", 30, datum=True, both=True)[0]
        # a 20x20x6 block, and a 10x10 rib on the Front plane, 30 each way in Y
        r = run_script(code, sketches={"Top": {"plane": top0, "loops": [_rect(-10, -10, 10, 10)]},
                                       "Front": {"plane": front, "loops": [_rect(-5, 0, 5, 10)]}})
        self.assertFalse(r.get("warning"))
        self.assertAlmostEqual(r["metrics"]["bbox_min"][1], -30, places=3)
        self.assertAlmostEqual(r["metrics"]["bbox_max"][1], 30, places=3)

    def test_unknown_sketch_is_reported(self):
        r = run_script(self.base + 'part -= extrude(sketch("nope"), amount=-2)\n')
        self.assertIn("no sketch named 'nope'", r.get("warning") or "")
