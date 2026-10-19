"""face_ref(), shell() and the script lines the Shell dialog writes
(paramedit.add_shell / op_at)."""

from django.test import SimpleTestCase

from modeling.engine import run_script
from modeling.paramedit import ParamError, add_shell, op_at, op_lines

BLOCK = 'P = dict(h={h})\npart = Pos(0, 0, P["h"] / 2) * Box(90, 60, P["h"])\n'


def _ref(r, normal, hint):
    """The run result's ref of the face facing `normal`, as the editor sends it."""
    f = next(f for f in r["faces"] if f["kind"] == "plane"
             and sum(a * b for a, b in zip(f["normal"], normal)) > 0.999)
    return {**f["ref"], "hint": hint}


class FaceRefTests(SimpleTestCase):
    def test_every_face_has_a_ref_and_it_finds_that_face(self):
        r = run_script(BLOCK.format(h=25))
        top = _ref(r, [0, 0, 1], "top face")
        self.assertEqual(top["center"], [0, 0, 25])
        self.assertEqual(top["normal"], [0, 0, 1])
        self.assertEqual(top["area"], 5400)
        code = BLOCK.format(h=25) + f"f = face_ref({top})\nP['z'] = f.center().Z\n"
        out = run_script(code)
        self.assertEqual(out["face_refs"], [{"hint": "top face", "status": "found", "moved_by": 0.0}])
        self.assertAlmostEqual(out["params"]["z"], 25)

    def test_a_shells_removed_top_is_found_after_a_height_change(self):
        top = _ref(run_script(BLOCK.format(h=25)), [0, 0, 1], "top face")
        code, _ = add_shell(BLOCK.format(h=25), [top], 2)
        taller = code.replace("h=25", "h=40")
        r = run_script(taller)
        self.assertEqual(r["face_refs"][0]["status"], "found")
        self.assertAlmostEqual(r["face_refs"][0]["moved_by"], 15)
        self.assertFalse(r.get("warning"))
        self.assertAlmostEqual(r["metrics"]["volume"], 90 * 60 * 40 - 86 * 56 * 38, delta=0.01)

    def test_a_face_that_is_gone_is_a_clear_error_naming_it(self):
        ear = {"center": [60, 0, 25], "normal": [0, 0, 1], "area": 100, "box": [55, -5, 65, 5],
               "hint": "ear's top face"}
        code = BLOCK.format(h=25) + f"part = shell(part, remove=[face_ref({ear})], thickness=2)\n"
        r = run_script(code)
        self.assertEqual(r["face_refs"][0]["status"], "not_found")
        self.assertIn("ear's top face", r["warning"])
        self.assertIn("no longer on the part", r["warning"])


class ShellTests(SimpleTestCase):
    def setUp(self):
        r = run_script(BLOCK.format(h=25))
        self.top = _ref(r, [0, 0, 1], "top face")
        self.front = _ref(r, [0, -1, 0], "front face")

    def _faces_along(self, r, axis, value):
        return [f for f in r["faces"] if f["kind"] == "plane" and abs(f["center"][axis] - value) < 1e-6]

    def test_a_box_open_at_the_top_has_walls_of_the_thickness(self):
        code, key = add_shell(BLOCK.format(h=25), [self.top], 2)
        self.assertEqual(key, "wall")
        self.assertIn('part = shell(part, remove=[face_ref({"center": [0, 0, 25], ', code)
        self.assertIn('thickness=P["wall"], inside=True)', code)
        r = run_script(code)
        self.assertAlmostEqual(r["metrics"]["volume"], 90 * 60 * 25 - 86 * 56 * 23, delta=0.01)
        # the outside is kept; the floor inside is 2 up, the inner walls 2 in
        self.assertEqual(r["metrics"]["bbox_max"], [45, 30, 25])
        floor = [f for f in r["faces"] if f["normal"] == [0, 0, 1] and abs(f["center"][2] - 2) < 1e-6]
        self.assertEqual(len(floor), 1)
        self.assertAlmostEqual(floor[0]["area"], 86 * 56, places=3)
        self.assertEqual(len(self._faces_along(r, 0, 43)), 1)    # inner right wall at x = 45 - 2

    def test_two_removed_faces(self):
        code, _ = add_shell(BLOCK.format(h=25), [self.top, self.front], 3)
        self.assertIn('P = dict(h=25, wall=3)', code)            # the new key
        r = run_script(code)
        # open at the top and the front: floor, back, left and right walls
        inner = (90 - 6) * (60 - 3) * (25 - 3)
        self.assertAlmostEqual(r["metrics"]["volume"], 90 * 60 * 25 - inner, delta=0.01)

    def test_outside_keeps_the_inside_and_grows_out(self):
        code, _ = add_shell(BLOCK.format(h=25), [self.top], 2, inside=False)
        self.assertIn("inside=False", code)
        r = run_script(code)
        self.assertEqual([round(x, 6) for x in r["metrics"]["bbox_min"]], [-47, -32, -2])
        self.assertEqual([round(x, 6) for x in r["metrics"]["bbox_max"]], [47, 32, 25])
        self.assertAlmostEqual(r["metrics"]["volume"], 94 * 64 * 27 - 90 * 60 * 25, delta=0.01)

    def test_too_thick_is_a_clear_error_with_a_thickness_that_works(self):
        code, _ = add_shell(BLOCK.format(h=25), [self.top], 40)
        r = run_script(code)   # rendered up to the shell, with the warning
        self.assertIn("Shell thickness 40 is too large", r["warning"])
        self.assertIn("The largest thickness that works is about", r["warning"])
        fix = r["fix"]
        self.assertEqual(fix["kind"], "shell")
        self.assertEqual(fix["param"], "wall")
        self.assertGreater(fix["max"], 23)
        self.assertLess(fix["max"], 25)               # the 25 high box: the floor fills it
        ok = run_script(code.replace("wall=40", f"wall={fix['value']}"))
        self.assertFalse(ok.get("warning"))


class ShellLineTests(SimpleTestCase):
    TOP = {"center": [0, 0, 25], "normal": [0, 0, 1], "area": 5400, "box": [-45, -30, 45, 30],
           "hint": "top face"}

    def test_reopening_reads_the_line_back(self):
        code, _ = add_shell(BLOCK.format(h=25), [self.TOP], 2.5, inside=False)
        line = code.split("\n").index(next(l for l in code.split("\n") if "shell(" in l)) + 1
        self.assertEqual(op_lines(code), [{"op": "shell", "line": line, "end_line": line}])
        op = op_at(code, line)
        self.assertEqual(op["op"], "shell")
        self.assertEqual(op["args"], {"remove": [self.TOP], "thickness": 2.5, "inside": False})
        self.assertEqual(op["params"], {"thickness": "wall"})

    def test_changing_a_value_rewrites_only_that_line(self):
        base = BLOCK.format(h=25) + "part = fillet(part.edges(), 1)\n"
        code, _ = add_shell(base, [self.TOP], 2)
        code += "# after\npart -= Box(1, 1, 1)\n"
        line = next(i for i, l in enumerate(code.split("\n"), 1) if "shell(" in l)
        edited, key = add_shell(code, [self.TOP], 3, inside=False, line=line)
        self.assertEqual(key, "wall")
        old, new = code.split("\n"), edited.split("\n")
        self.assertEqual(len(old), len(new))
        changed = [i + 1 for i, (a, b) in enumerate(zip(old, new)) if a != b]
        self.assertEqual(changed, [1, line])     # the P value and the shell line
        self.assertEqual(new[0], "P = dict(h=25, wall=3)")
        self.assertTrue(new[line - 1].endswith('thickness=P["wall"], inside=False)'))

    def test_a_second_shell_gets_its_own_key(self):
        code, k1 = add_shell(BLOCK.format(h=25), [self.TOP], 2)
        code, k2 = add_shell(code, [], 1)
        self.assertEqual((k1, k2), ("wall", "wall2"))

    def test_no_part_no_shell(self):
        with self.assertRaises(ParamError):
            add_shell("P = dict(a=1)\n", [self.TOP], 2)
        with self.assertRaises(ParamError):
            op_at(BLOCK.format(h=25), 2)
