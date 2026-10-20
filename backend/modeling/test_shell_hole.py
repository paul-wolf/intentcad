"""face_ref(), shell(), holes() and the script lines the Shell and Hole
dialogs write (paramedit.add_shell / add_holes / op_at)."""

from django.test import SimpleTestCase

from modeling.engine import run_script
from modeling.paramedit import ParamError, add_holes, add_shell, op_at, op_lines

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


# four points 60 x 40 apart on the block's top face, as the editor stores a
# face sketch's profile (sketch y points down)
def _points_on_top(h):
    return {"plane": {"origin": [0, 0, h], "normal": [0, 0, 1], "xAxis": [1, 0, 0]},
            "loops": [], "points": [[-30, -20], [30, -20], [30, 20], [-30, 20]],
            "face": {"center": [0, 0, h], "normal": [0, 0, 1], "area": 5400, "box": [-45, -30, 45, 30],
                     "hint": "top face"}}


def _cyl(r, h):
    return 3.141592653589793 * r * r * h


class HoleTests(SimpleTestCase):
    VOL = 90 * 60 * 25

    def run_holes(self, line, h=25, p=""):
        code = BLOCK.format(h=h).replace("dict(h=", f"dict({p}h=") + line + "\n"
        r = run_script(code, sketches={"S": _points_on_top(25)})
        self.assertFalse(r.get("warning"), r.get("warning"))
        return r

    def holes_of(self, r, radius):
        return [f for f in r["faces"] if f["kind"] == "cylinder" and abs(f["radius"] - radius) < 1e-6]

    def test_plain_tuple_point_normal_pairs(self):
        r = self.run_holes('part = holes(part, at=[((x, y, P["h"]), (0, 0, 1)) for x, y in [(-30, -20), (30, 20)]], '
                           'kind="clearance", size="M3")')
        self.assertEqual(len(self.holes_of(r, 1.7)), 2)

    def test_a_bare_point_asks_for_its_normal(self):
        from modeling.shell_hole import HoleError, _places
        with self.assertRaisesRegex(HoleError, "needs its outward normal"):
            _places([(1, 2, 3)])

    def test_four_points_give_four_through_holes(self):
        r = self.run_holes('part = holes(part, at=sketch_points("S"), kind="clearance", size="M3")')
        self.assertEqual(len(self.holes_of(r, 1.7)), 4)                   # normal fit: 3.4
        self.assertAlmostEqual(r["metrics"]["volume"], self.VOL - 4 * _cyl(1.7, 25), delta=0.01)
        self.assertEqual({tuple(round(x, 6) for x in f["axis_point"][:2]) for f in self.holes_of(r, 1.7)},
                         {(-30, 20), (30, 20), (30, -20), (-30, -20)})
        close = self.run_holes('part = holes(part, at=sketch_points("S"), kind="clearance", size="M3", fit="close")')
        self.assertEqual(len(self.holes_of(close, 1.6)), 4)               # close fit: 3.2

    def test_a_blind_tapped_hole_and_a_face_centre(self):
        top = {"center": [0, 0, 25], "normal": [0, 0, 1], "area": 5400, "box": [-45, -30, 45, 30]}
        r = self.run_holes(f'part = holes(part, at=face_ref({top}), kind="tapped", size="M3", depth=9)')
        hole = self.holes_of(r, 1.25)
        self.assertEqual(len(hole), 1)
        self.assertEqual([round(x, 6) for x in hole[0]["axis_point"][:2]], [0, 0])
        self.assertAlmostEqual(hole[0]["center"][2], 20.5)                 # 9 deep from the top
        self.assertAlmostEqual(r["metrics"]["volume"], self.VOL - _cyl(1.25, 9), delta=0.01)

    def test_counterbore(self):
        r = self.run_holes('part = holes(part, at=sketch_points("S"), kind="counterbore", size="M3")')
        self.assertEqual(len(self.holes_of(r, 3.25)), 4)                  # 6.5 across
        bore = self.holes_of(r, 3.25)[0]
        self.assertAlmostEqual(bore["center"][2], 25 - 3.3 / 2, places=6)  # 3.3 deep
        one = _cyl(3.25, 3.3) + _cyl(1.7, 25 - 3.3)
        self.assertAlmostEqual(r["metrics"]["volume"], self.VOL - 4 * one, delta=0.01)

    def test_countersink(self):
        r = self.run_holes('part = holes(part, at=sketch_points("S"), kind="countersink", size="M3")')
        cones = [f for f in r["faces"] if f["kind"] == "cone"]
        self.assertEqual(len(cones), 4)
        R, rr = 6.72 / 2, 1.7
        h = R - rr                                                         # 90°: as deep as it is wide
        cone = 3.141592653589793 * h / 3 * (R * R + R * rr + rr * rr)
        self.assertAlmostEqual(r["metrics"]["volume"], self.VOL - 4 * (cone + _cyl(rr, 25 - h)), delta=0.01)

    def test_standoffs_with_inserts(self):
        r = self.run_holes('part = holes(part, at=sketch_points("S"), kind="insert", size="M3", depth=6.7, '
                           'standoff=dict(h=6, d=7.5, fillet=1))')
        self.assertEqual(r["metrics"]["bbox_max"][2], 31)                 # bosses 6 up
        self.assertEqual(len(self.holes_of(r, 3.75)), 4)                  # their sides
        inserts = self.holes_of(r, 2.0)                                   # CNC Kitchen M3: 4.0 hole
        self.assertEqual(len(inserts), 4)
        self.assertAlmostEqual(inserts[0]["center"][2], 31 - 6.7 / 2, places=6)
        self.assertEqual(len([f for f in r["faces"] if f["kind"] == "torus"]), 4)   # the rounded feet
        bare = self.VOL + 4 * (_cyl(3.75, 6) - _cyl(2, 6.7))
        self.assertGreater(r["metrics"]["volume"], bare)                  # + the fillets' fill
        self.assertLess(r["metrics"]["volume"], bare + 4 * 2 * 3.1416 * 4.25 * 0.22)

    def test_hole_comp_widens_every_hole(self):
        r = self.run_holes('part = holes(part, at=sketch_points("S"), kind="counterbore", size="M3")',
                           p="hole_comp=0.2, ")
        self.assertEqual(len(self.holes_of(r, 1.8)), 4)
        self.assertEqual(len(self.holes_of(r, 3.35)), 4)

    def test_holes_follow_the_sketchs_face(self):
        code, _ = add_holes(BLOCK.format(h=25), {"sketch": "S"}, "clearance", "M3", depth=5)
        r = run_script(code.replace("h=25", "h=40"), sketches={"S": _points_on_top(25)})
        self.assertEqual(r["sketches"]["S"]["status"], "moved")
        hole = self.holes_of(r, 1.7)
        self.assertEqual(len(hole), 4)
        self.assertAlmostEqual(hole[0]["center"][2], 37.5)                 # 5 down from the new top

    def test_a_sketch_with_no_points(self):
        empty = {**_points_on_top(25), "points": []}
        r = run_script(BLOCK.format(h=25) + 'part = holes(part, at=sketch_points("S"))\n', sketches={"S": empty})
        self.assertIn("has no points or circles", r["warning"])


class HoleLineTests(SimpleTestCase):
    def test_the_line_and_its_parameters(self):
        code, key = add_holes(BLOCK.format(h=25), {"sketch": "Standoffs"}, "insert", "M3", 6.7,
                              standoff={"h": 6, "d": 7.5, "fillet": 1})
        self.assertEqual(key, "insert_depth")
        self.assertEqual(code.split("\n")[0], "P = dict(h=25, insert_depth=6.7, standoff_h=6, standoff_d=7.5, hole_comp=0)")
        self.assertIn('part = holes(part, at=sketch_points("Standoffs"), kind="insert", size="M3", '
                      'depth=P["insert_depth"], standoff=dict(h=P["standoff_h"], d=P["standoff_d"], fillet=1))', code)
        op = op_at(code, 3)
        self.assertEqual(op["args"], {"at": {"sketch": "Standoffs"}, "kind": "insert", "size": "M3", "fit": "normal",
                                      "depth": 6.7, "sizes": {}, "standoff": {"h": 6, "d": 7.5, "fillet": 1}})
        self.assertEqual(op["params"], {"depth": "insert_depth", "standoff.h": "standoff_h",
                                        "standoff.d": "standoff_d"})

    def test_a_changed_preset_becomes_a_parameter(self):
        code, _ = add_holes(BLOCK.format(h=25), {"sketch": "S"}, "counterbore", "M3", None,
                            sizes={"cbore_d": 7})
        self.assertIn('depth="through", cbore_d=P["cbore_d"])', code)
        self.assertIn("cbore_d=7", code.split("\n")[0])
        self.assertEqual(op_at(code, 3)["args"]["sizes"], {"cbore_d": 7})

    def test_changing_the_size_rewrites_only_that_line(self):
        base = BLOCK.format(h=25) + "part = fillet(part.edges(), 1)\n"
        code, _ = add_holes(base, {"sketch": "S"}, "insert", "M3", 6.7, standoff={"h": 6, "d": 7.5, "fillet": 1})
        code += "# after\npart -= Box(1, 1, 1)\n"
        line = next(i for i, l in enumerate(code.split("\n"), 1) if "holes(" in l)
        edited, _ = add_holes(code, {"sketch": "S"}, "insert", "M2.5", 5, standoff={"h": 6, "d": 7.5, "fillet": 1},
                              line=line)
        old, new = code.split("\n"), edited.split("\n")
        self.assertEqual(len(old), len(new))
        self.assertEqual([i + 1 for i, (a, b) in enumerate(zip(old, new)) if a != b], [1, line])
        self.assertEqual(new[0], "P = dict(h=25, insert_depth=5, standoff_h=6, standoff_d=7.5, hole_comp=0)")
        self.assertIn('size="M2.5", depth=P["insert_depth"]', new[line - 1])

    def test_another_kind_drops_the_keys_it_no_longer_uses(self):
        code, _ = add_holes(BLOCK.format(h=25), {"sketch": "S"}, "insert", "M3", 6.7,
                            standoff={"h": 6, "d": 7.5, "fillet": 1})
        code, key = add_holes(code, {"sketch": "S"}, "clearance", "M3", None, line=3)
        self.assertIsNone(key)
        self.assertEqual(code.split("\n")[0], "P = dict(h=25, hole_comp=0)")
        self.assertTrue(code.split("\n")[2].endswith('kind="clearance", size="M3", fit="normal", depth="through")'))

    def test_a_second_holes_line_gets_its_own_keys(self):
        code, k1 = add_holes(BLOCK.format(h=25), {"sketch": "S"}, "insert", "M3", 6.7)
        code, k2 = add_holes(code, {"sketch": "T"}, "insert", "M4", 9.1)
        self.assertEqual((k1, k2), ("insert_depth", "insert2_depth"))
        self.assertEqual(code.count("hole_comp"), 1)
        self.assertEqual([o["op"] for o in op_lines(code)], ["holes", "holes"])

    def test_unknown_sizes_are_refused(self):
        with self.assertRaises(ParamError):
            add_holes(BLOCK.format(h=25), {"sketch": "S"}, "insert", "M6", 6)
        with self.assertRaises(ParamError):
            add_holes(BLOCK.format(h=25), {"sketch": "S"}, "rivet", "M3", 6)
