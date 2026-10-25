"""A project sketch made into parts: extrude, cut and revolve lines that read a
shared sketch (SK["alias"], a group or named element of it, maybe placed on a
face or plane), written and read back the way the dialogs do."""

import math

from django.test import SimpleTestCase

from .engine import run_script
from .paramedit import ParamError, add_extrude, add_revolve, op_at, steps
from .test_shared_defs import XY, _rect, frame_profile, plate_volume


def ring_profile():
    """A 5 mm wide, 10 mm tall rectangle 5 mm right of the V axis."""
    loop = _rect(5, -10, 10, 0)
    return {"plane": XY, "loops": [loop], "points": [], "lines": {},
            "items": {"points": [], "circles": [], "lines": [{"id": "r", "p": s["p"]} for s in loop]},
            "names": {}, "groups": {}, "sub": {}}


def run(code, **sk):
    return run_script(code, shared={"sk": sk or {"frame": frame_profile()}, "pp": {}, "errors": {}})


class SharedSketchLineTests(SimpleTestCase):
    def test_new_part_from_a_shared_sketch_is_its_first_line(self):
        code, key = add_extrude("", 'SK["frame"].named("outline")', "new", depth=2)
        self.assertEqual(key, "body1_height")
        self.assertIn('part = extrude(SK["frame"].named("outline"), amount=P["body1_height"])', code)
        r = run(code)
        self.assertAlmostEqual(r["metrics"]["volume"], 80 * 80 * 2, delta=0.5)
        self.assertAlmostEqual(r["metrics"]["bbox_min"][2], 0, places=3)   # up from its plane

    def test_a_cut_of_a_group_goes_both_ways_through_a_plate_it_lies_in(self):
        base = 'part = Box(80, 80, 2)\n'
        code, key = add_extrude(base, 'SK["frame"].group("arm holes")', "cut", through=True)
        self.assertIsNone(key)
        self.assertIn('part -= extrude(SK["frame"].group("arm holes"), amount=part.bounding_box().diagonal'
                      ' + part.bounding_box().center().length, both=True)', code)
        self.assertAlmostEqual(run(code)["metrics"]["volume"], plate_volume(), delta=0.5)

    def test_on_a_face_a_cut_goes_into_the_part(self):
        face = {"normal": [0, 0, 1], "center": [0, 0, 2], "hint": "top"}
        base = 'part = Pos(0, 0, -2) * Box(80, 80, 4, align=(Align.CENTER, Align.CENTER, Align.MIN))\n'
        src = f'SK["frame"].group("arm holes").on(face_ref({face!r}))'
        code, key = add_extrude(base, src, "cut", depth=1)
        line = code.strip().splitlines()[-1]
        self.assertTrue(line.startswith('part -= extrude(SK["frame"].group("arm holes").on(face_ref({"normal": [0, 0, 1]'),
                        line)
        self.assertIn(f'amount=-P["{key}"])', line)

    def test_placement_on_a_plane_is_kept_in_the_source(self):
        code, _ = add_extrude("", 'SK["frame"].on(PLANES["Mid"])', "new", depth=3)
        self.assertIn('extrude(SK["frame"].on(PLANES["Mid"]), amount=P["body1_height"])', code)
        code, _ = add_extrude("", "SK['frame'].on(Plane.XZ)", "new", depth=3)
        self.assertIn('extrude(SK["frame"].on(Plane.XZ), amount=', code)
        self.assertAlmostEqual(run(code)["metrics"]["bbox_max"][1], 0, places=3)

    def test_only_the_editor_form_of_sk_is_accepted(self):
        for bad in ('SK["frame"].circles', 'SK[name]', 'SK["frame"].on(make_plane())', 'SK["f"]; import os'):
            with self.assertRaises(ParamError, msg=bad):
                add_extrude("", bad, "new", depth=1)

    def test_the_line_reopens_with_its_shared_sketch(self):
        code, _ = add_extrude("part = Box(80, 80, 2)\n", 'SK["frame"].group("arm holes")', "cut", depth=1.5)
        line = len(code.strip().splitlines())
        op = op_at(code, line)
        self.assertEqual(op["args"]["sketch"], 'SK["frame"].group("arm holes")')
        self.assertTrue(op["args"]["datum"])
        self.assertEqual(op["args"]["depth"], 1.5)
        # reopened: the depth changes, and it can move onto another plane of the same sketch
        code2, _ = add_extrude(code, 'SK["frame"].group("arm holes").on(PLANES["Mid"])', "cut", depth=4, line=line)
        self.assertIn('part -= extrude(SK["frame"].group("arm holes").on(PLANES["Mid"]), amount=P["cut1_depth"])',
                      code2)
        # but not to another sketch
        code3, _ = add_extrude(code, 'sketch("Other")', "cut", depth=4, line=line)
        self.assertIn('SK["frame"].group("arm holes")', code3)
        names = [s.get("summary") for s in steps(code)]
        self.assertTrue(any((n or '').startswith('Cut SK["frame"].group("arm holes")') for n in names), names)

    def test_revolve_about_a_line_of_the_shared_sketch(self):
        code = add_revolve("", 'SK["knob"]', "new", {"line": "axis-v"}, angle=360)
        self.assertEqual(code.strip(), 'part = revolve(SK["knob"], axis=SK["knob"].line("axis-v"), angle=360)')
        r = run(code, knob=ring_profile())
        self.assertAlmostEqual(r["metrics"]["volume"], math.pi * (10 ** 2 - 5 ** 2) * 10, delta=1)
        op = op_at(code, 1)
        self.assertEqual((op["args"]["sketch"], op["args"]["axis"]), ('SK["knob"]', {"line": "axis-v"}))
        # a base axis works as well
        code = add_revolve("", 'SK["knob"]', "new", {"base": "Y"}, angle=180)
        self.assertAlmostEqual(run(code, knob=ring_profile())["metrics"]["volume"],
                               math.pi * (10 ** 2 - 5 ** 2) * 10 / 2, delta=1)
