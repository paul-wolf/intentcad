"""Pattern (modeling/pattern.py, paramedit's pattern section): linear() and
circular() instances, pattern_body() of the whole part, patterned() copies of
steps that follow their sketch, P and the edge or face they are laid out by,
and the link comment that keeps the copies in step with their original."""

import math

from django.test import SimpleTestCase

from modeling import paramedit as pe
from modeling.engine import run_script


def _rect(x0, y0, x1, y1):
    p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    return [{"t": "line", "p": [p[i], p[(i + 1) % 4]]} for i in range(4)]


def _top(loops=(), points=(), h=20):
    """A sketch on the top face (z = h), given in world x, y (the face's
    sketch y is world -y: y = x × normal)."""
    flip = [[{**e, "p": [[x, -y] for x, y in e["p"]]} for e in loop] for loop in loops]
    return {"plane": {"origin": [0, 0, h], "normal": [0, 0, 1], "xAxis": [1, 0, 0]},
            "loops": flip, "points": [[x, -y] for x, y in points]}


def _floors(r, z):
    """(x, y) of the centre of each upward face at height z (a pocket's floor)."""
    return sorted((round(f["center"][0], 3), round(f["center"][1], 3)) for f in r["faces"]
                  if f["kind"] == "plane" and f["normal"][2] > 0.999 and abs(f["center"][2] - z) < 1e-6)


def _circles(r, radius):
    """(x, y) of the centre of every circular edge of `radius`."""
    return sorted({(round(e["ref"]["center"][0], 2), round(e["ref"]["center"][1], 2))
                   for e in r["edges"] if e["ref"] and e["ref"].get("kind") == "circle"
                   and abs(e["ref"]["radius"] - radius) < 1e-6})


# a plate 100 × 60 × 20 from x = 0, y = 0, z = 0; a pocket sketch "Vent" 2 × 4 at (10, 10)
PLATE = ('P = dict(depth=2, pitch={pitch}, n={n})\n'
         'part = Pos(50, 30, 10) * Box(100, 60, 20)\n')
VENT = _top([_rect(9, 8, 11, 12)])
CUT = 'part -= extrude(sketch("Vent"), amount=-P["depth"])\n'


def _plate(pitch=10, n=4):
    return PLATE.format(pitch=pitch, n=n)


def _run(code, **sk):
    r = run_script(code, sketches=sk or {"Vent": VENT})
    assert not r.get("warning"), r.get("warning")
    return r


class LinearTests(SimpleTestCase):
    def _cut(self, pattern, **kw):
        return _run(_plate(**kw) + CUT + f'part -= patterned(extrude(sketch("Vent"), amount=-P["depth"]), '
                                         f'{pattern})\n')

    def test_spacing_and_extent(self):
        r = self._cut('linear("X", P["n"], spacing=P["pitch"])')
        self.assertEqual([x for x, _ in _floors(r, 18)], [10, 20, 30, 40])
        r = self._cut('linear("X", 5, extent=60)')           # 5 fitted within 60: 15 apart
        self.assertEqual([x for x, _ in _floors(r, 18)], [10, 25, 40, 55, 70])
        self.assertAlmostEqual(r["metrics"]["volume"], 100 * 60 * 20 - 5 * 8 * 2, places=3)

    def test_symmetric_goes_both_ways(self):
        r = _run(_plate().replace("Pos(50", "Pos(40") + 'part -= extrude(sketch("Vent"), amount=-2)\n'
                 'part -= patterned(extrude(sketch("Vent"), amount=-2), linear("X", 3, spacing=5, symmetric=True))\n',
                 Vent=_top([_rect(39, 8, 41, 12)]))
        self.assertEqual([x for x, _ in _floors(r, 18)], [30, 35, 40, 45, 50])
        # extent is each way
        r = _run(_plate().replace("Pos(50", "Pos(40") + 'part -= extrude(sketch("Vent"), amount=-2)\n'
                 'part -= patterned(extrude(sketch("Vent"), amount=-2), linear("X", 3, extent=20, symmetric=True))\n',
                 Vent=_top([_rect(39, 8, 41, 12)]))
        self.assertEqual([x for x, _ in _floors(r, 18)], [20, 30, 40, 50, 60])

    def test_two_directions_make_a_grid(self):
        r = self._cut('linear("X", 4, spacing=10, dir2="Y", count2=3, spacing2=15)')
        floors = _floors(r, 18)
        self.assertEqual(len(floors), 4 * 3)
        self.assertEqual(sorted({y for _, y in floors}), [10, 25, 40])
        pat = r["patterns"][0]
        self.assertEqual((pat["kind"], pat["what"], len(pat["instances"])), ("linear", "solid", 12))
        self.assertEqual(pat["line"], 4)
        # index = i + j·n1: instance 5 is i = 1, j = 1
        self.assertEqual(pat["instances"][5]["center"][:2], [20, 25])

    def test_skip_leaves_instances_out(self):
        r = self._cut('linear("X", 4, spacing=10, dir2="Y", count2=3, spacing2=15, skip=[5, 11])')
        floors = _floors(r, 18)
        self.assertEqual(len(floors), 10)
        self.assertNotIn((20, 25), floors)
        self.assertNotIn((40, 40), floors)
        self.assertEqual([i["index"] for i in r["patterns"][0]["instances"] if i["skip"]], [5, 11])
        r = run_script(_plate() + CUT + 'part -= patterned(extrude(sketch("Vent"), amount=-2), '
                       'linear("X", 4, spacing=10, skip=[0]))\n', sketches={"Vent": VENT})
        self.assertIn("original", r["warning"])

    def test_flip_reverses_the_direction(self):
        r = _run(_plate() + 'part -= extrude(sketch("Vent"), amount=-2)\n'
                 'part -= patterned(extrude(sketch("Vent"), amount=-2), linear("X", 3, spacing=10, flip=True))\n',
                 Vent=_top([_rect(79, 8, 81, 12)]))
        self.assertEqual([x for x, _ in _floors(r, 18)], [60, 70, 80])

    def test_follows_a_p_change_of_spacing(self):
        for pitch, n in ((10, 4), (12, 4), (12, 6)):
            r = self._cut('linear("X", P["n"], spacing=P["pitch"])', pitch=pitch, n=n)
            self.assertEqual([x for x, _ in _floors(r, 18)], [10 + k * pitch for k in range(n)])

    def test_follows_the_edge_it_uses(self):
        base = ('P = dict(w={w})\n'
                'part = Pos(P["w"] / 2, 30, 10) * Box(P["w"], 60, 20)\n')
        r0 = run_script(base.format(w=100))
        front = next(e["ref"] for e in r0["edges"] if e["ref"] and e["ref"]["hint"] == "bottom-front edge")
        corner = next(e["ref"] for e in r0["edges"] if e["ref"] and e["ref"]["hint"] == "front-right edge")
        # along an edge: its direction (pointing +x whichever way the edge runs)
        r = run_script(base.format(w=100) + f'part = pattern_body(part, linear(edge_ref({front}), 2, spacing=150), '
                       'join=False)\n')
        self.assertEqual(r["patterns"][0]["dir"], [1, 0, 0])
        self.assertAlmostEqual(r["metrics"]["bbox_max"][0], 250, places=4)
        # round an edge as the axis: the edge moves with w, and the copy with it
        line = f'part = pattern_body(part, circular(edge_ref({corner}), 2), join=False)\n'
        for w in (100, 120):
            r = run_script(base.format(w=w) + line)
            self.assertFalse(r.get("warning"))
            self.assertEqual([e["status"] for e in r["edge_refs"]], ["found"])
            self.assertAlmostEqual(r["metrics"]["bbox_max"][0], 2 * w, places=4)
            self.assertEqual(r["patterns"][0]["origin"][:2], [w, 0])

    def test_a_face_normal_is_a_direction(self):
        r0 = run_script(_plate())
        right = next(f["ref"] for f in r0["faces"] if f["ref"] and f["normal"][0] > 0.999)
        r = _run(_plate() + CUT + 'part -= patterned(extrude(sketch("Vent"), amount=-2), '
                 f'linear(face_ref({right}), 3, spacing=20))\n')
        self.assertEqual([x for x, _ in _floors(r, 18)], [10, 30, 50])


# a plate with a 10 mm hole through it at (cx, 30)
HOLE = ('P = dict(cx={cx}, r=5)\n'
        'part = Pos(50, 30, 10) * Box(100, 60, 20)\n'
        'part -= Pos(P["cx"], 30, 10) * Cylinder(P["r"], 20)\n')


def _hole_face(cx=50):
    r = run_script(HOLE.format(cx=cx))
    return next(f["ref"] for f in r["faces"] if f["ref"] and f["kind"] == "cylinder")


class CircularTests(SimpleTestCase):
    def test_six_round_a_holes_axis_land_on_a_circle(self):
        face = _hole_face()
        code = (HOLE.format(cx=50) + 'part -= extrude(sketch("Vent"), amount=-2)\n'
                f'part -= patterned(extrude(sketch("Vent"), amount=-2), circular(face_ref({face}), 6))\n')
        r = _run(code, Vent=_top([_rect(64, 29, 66, 31)]))          # 15 from the hole's axis
        floors = _floors(r, 18)
        self.assertEqual(len(floors), 6)
        for x, y in floors:
            self.assertAlmostEqual(math.hypot(x - 50, y - 30), 15, places=3)
        angles = sorted(round(math.degrees(math.atan2(y - 30, x - 50)) % 360) for x, y in floors)
        self.assertEqual(angles, [0, 60, 120, 180, 240, 300])
        pat = r["patterns"][0]
        self.assertEqual((pat["kind"], pat["step"], pat["full"]), ("circular", 60, True))
        self.assertEqual(pat["origin"][:2], [50, 30])

    def test_an_angle_below_360_spans_it(self):
        face = _hole_face()
        code = (HOLE.format(cx=50) + 'part -= extrude(sketch("Vent"), amount=-2)\n'
                f'part -= patterned(extrude(sketch("Vent"), amount=-2), circular(face_ref({face}), 4, angle=90))\n')
        r = _run(code, Vent=_top([_rect(64, 29, 66, 31)]))
        angles = sorted(round(math.degrees(math.atan2(y - 30, x - 50)) % 360) for x, y in _floors(r, 18))
        self.assertEqual(angles, [0, 30, 60, 90])
        code = code.replace("angle=90)", "angle=60, symmetric=True)")
        r = _run(code, Vent=_top([_rect(64, 29, 66, 31)]))
        angles = sorted(round(math.degrees(math.atan2(y - 30, x - 50))) for x, y in _floors(r, 18))
        self.assertEqual(angles, [-60, -40, -20, 0, 20, 40, 60])

    def test_the_axis_follows_the_hole(self):
        face = _hole_face(cx=50)
        line = f'part -= patterned(extrude(sketch("Vent"), amount=-2), circular(face_ref({face}), 4))\n'
        for cx in (50, 56, 80):         # 80: further than the hole's size, but the only hole like it
            r = _run(HOLE.format(cx=cx) + 'part -= extrude(sketch("Vent"), amount=-2)\n' + line,
                     Vent=_top([_rect(cx + 14, 29, cx + 16, 31)]))
            floors = _floors(r, 18)
            self.assertEqual(len(floors), 4)
            for x, y in floors:
                self.assertAlmostEqual(math.hypot(x - cx, y - 30), 15, places=3)
        # with a second hole the same size it can't tell which one: lost, not a guess
        two = HOLE.format(cx=80) + 'part -= Pos(20, 30, 10) * Cylinder(P["r"], 20)\n'
        r = run_script(two + 'part -= extrude(sketch("Vent"), amount=-2)\n' + line,
                       sketches={"Vent": _top([_rect(94, 29, 96, 31)])})
        self.assertIn("no longer on the part", r["warning"])

    def test_a_circular_edge_and_a_straight_edge_are_axes(self):
        r0 = run_script(HOLE.format(cx=50))
        rim = next(e["ref"] for e in r0["edges"] if e["ref"] and e["ref"].get("kind") == "circle"
                   and e["ref"]["center"][2] > 19)
        r = _run(HOLE.format(cx=50) + 'part -= extrude(sketch("Vent"), amount=-2)\n'
                 f'part -= patterned(extrude(sketch("Vent"), amount=-2), circular(edge_ref({rim}), 3))\n',
                 Vent=_top([_rect(64, 29, 66, 31)]))
        self.assertEqual(len(_floors(r, 18)), 3)
        # round a vertical edge of the plate (x = 100, y = 0): half a turn puts a copy outside
        r = run_script('part = Pos(50, 30, 10) * Box(100, 60, 20)\n')
        corner = next(e["ref"] for e in r["edges"] if e["ref"] and e["ref"]["hint"] == "front-right edge")
        r = run_script('part = Pos(50, 30, 10) * Box(100, 60, 20)\n'
                       f'part = pattern_body(part, circular(edge_ref({corner}), 2), join=False)\n')
        self.assertFalse(r.get("warning"))
        self.assertAlmostEqual(r["metrics"]["bbox_max"][0], 200, places=4)
        self.assertAlmostEqual(r["metrics"]["bbox_min"][1], -60, places=4)


class PatternBodyTests(SimpleTestCase):
    def test_join_fuses_and_separate_keeps_bodies(self):
        base = 'part = Pos(5, 5, 5) * Box(10, 10, 10)\n'
        r = run_script(base + 'part = pattern_body(part, linear("X", 4, spacing=8), join=True)\n')
        self.assertEqual(r["metrics"]["solids"], 1)                       # overlapping: one solid
        self.assertAlmostEqual(r["metrics"]["volume"], (3 * 8 + 10) * 10 * 10, places=3)
        r = run_script(base + 'part = pattern_body(part, linear("X", 4, spacing=20), join=False)\n')
        self.assertEqual(r["metrics"]["solids"], 4)
        self.assertAlmostEqual(r["metrics"]["volume"], 4 * 1000, places=3)
        self.assertAlmostEqual(r["metrics"]["bbox_max"][0], 70, places=6)
        r = run_script(base + 'part = pattern_body(part, linear("X", 3, spacing=20, dir2="Y", count2=2, '
                       'spacing2=20, symmetric=True, skip=[4]), join=False)\n')
        self.assertEqual(r["metrics"]["solids"], 5 * 3 - 1)
        pat = r["patterns"][0]
        self.assertEqual((pat["what"], pat["n1"], len(pat["instances"])), ("body", 5, 15))

    def test_a_join_extrude_of_feet(self):
        foot = {"plane": {"origin": [0, 0, 0], "normal": [0, 0, -1], "xAxis": [1, 0, 0]},
                "loops": [_rect(5, 5, 15, 15)], "points": []}           # from below, sketch y is world y
        code = ('part = Pos(50, 30, 10) * Box(100, 60, 20)\n'
                'part += extrude(sketch("Foot"), amount=3)\n'
                'part += patterned(extrude(sketch("Foot"), amount=3), linear("X", 2, spacing=80, '
                'dir2="Y", count2=2, spacing2=40))\n')
        r = _run(code, Foot=foot)
        self.assertEqual(r["metrics"]["solids"], 1)
        self.assertAlmostEqual(r["metrics"]["volume"], 100 * 60 * 20 + 4 * 100 * 3, places=3)
        self.assertAlmostEqual(r["metrics"]["bbox_min"][2], -3, places=6)


class PatternedStepTests(SimpleTestCase):
    def test_patterned_fillet_edges(self):
        # three posts on a base; the first post's top-front edge filleted, then its copies on the others
        base = ('P = dict(r=2)\npart = Pos(50, 30, 5) * Box(100, 60, 10)\n'
                'part += [Pos(10 + 20 * k, 30, 15) * Box(10, 10, 10) for k in range(3)]\n')
        r0 = run_script(base)
        edge = next(e["ref"] for e in r0["edges"] if e["ref"] and e["ref"]["kind"] == "line"
                    and e["ref"]["midpoint"] == [10, 25, 20])
        code = (base + f'part = fillet(part, edges_ref([{edge}]), radius=P["r"])\n'
                f'part = fillet(part, patterned(edges_ref([{edge}]), linear("X", 3, spacing=20)), radius=P["r"])\n')
        r = run_script(code)
        self.assertFalse(r.get("warning"))
        corner = (4 - math.pi * 4 / 4) * 10
        self.assertAlmostEqual(r["metrics"]["volume"], 100 * 60 * 10 + 3 * 1000 - 3 * corner, places=2)
        mine = [e for e in r["edge_refs"] if e["line"] == 5]
        self.assertEqual([e["status"] for e in mine], ["found", "found"])
        self.assertEqual([round(e["midpoint"][0], 6) for e in mine], [30, 50])
        self.assertTrue(mine[0]["hint"].startswith("copy 1 of the"))

    def test_patterned_holes_with_standoffs(self):
        face = _hole_face()
        args = 'kind="clearance", size="M3", standoff=dict(h=5, d=7))\n'
        code = (HOLE.format(cx=50) + 'part = holes(part, at=sketch_points("Boss"), ' + args
                + f'part = holes(part, at=patterned(sketch_points("Boss"), circular(face_ref({face}), 6)), ' + args)
        r = run_script(code, sketches={"Boss": _top(points=[(70, 30)])})
        self.assertFalse(r.get("warning"))
        rims = _circles(r, 3.5)
        self.assertEqual(len(rims), 6)
        for x, y in rims:
            self.assertAlmostEqual(math.hypot(x - 50, y - 30), 20, places=2)
        self.assertAlmostEqual(r["metrics"]["bbox_max"][2], 25, places=6)

    def test_many_copies_cut_in_one_boolean(self):
        r = _run(_plate() + CUT + 'part -= patterned(extrude(sketch("Vent"), amount=-2), '
                 'linear("X", 8, spacing=10, dir2="Y", count2=3, spacing2=15))\n')
        self.assertEqual(len(_floors(r, 18)), 24)


CODE = '''from build123d import *
P = dict(depth=2.0, r=2.0)
part = Pos(50, 30, 10) * Box(100, 60, 20)
part -= extrude(sketch("Vent"), amount=-P["depth"])
part = holes(part, at=sketch_points("Boss"), kind="insert", size="M3", standoff=dict(h=5, d=7))
part = fillet(part, edges_ref([{"kind": "line", "midpoint": [50, 0, 20], "hint": "top-front edge"}]), radius=P["r"])
part = shell(part, thickness=2.0)
'''

GRID = {"type": "linear", "dir": {"base": "X"}, "count": 8, "spacing": 6, "dir2": {"base": "Y"}, "count2": 3,
        "spacing2": 10, "skip": [3, 9]}


def _rows(code):
    return code.split("\n")


class PatternStepsTests(SimpleTestCase):
    def test_a_hand_written_extrude_is_named_after_its_sketch(self):
        code = 'P = dict(h=20)\npart = Box(80, 70, P["h"])\npart += extrude(sketch("Foot"), amount=2)\n'
        code, _, _, keys = pe.pattern_steps(code, [3], {"type": "linear", "dir": {"base": "X"}, "count": 2,
                                                         "spacing": 64})
        self.assertEqual(keys, ["foot_count", "foot_pitch"])
        copy = next(s for s in pe.steps(code) if s.get("pattern_of"))
        self.assertTrue(copy["summary"].endswith("written in code · pattern 2 along X"), copy["summary"])

    def test_each_step_gets_one_linked_copy_after_the_last(self):
        code, made, skipped, keys = pe.pattern_steps(CODE, [4, 5, 6, 7], GRID)
        rows = _rows(code)
        self.assertEqual(keys, ["vent_count", "vent_pitch", "vent_count2", "vent_pitch2"])
        self.assertEqual(rows[1], "P = dict(depth=2.0, r=2.0, vent_count=8, vent_pitch=6, vent_count2=3, vent_pitch2=10)")
        self.assertEqual(made, [{"of": 4, "line": 7}, {"of": 5, "line": 8}, {"of": 6, "line": 9}])
        self.assertEqual(skipped, [{"line": 7, "reason": "Shell can't be patterned"}])
        pat = ('linear("X", P["vent_count"], spacing=P["vent_pitch"], dir2="Y", count2=P["vent_count2"], '
               'spacing2=P["vent_pitch2"], skip=[3, 9])')
        self.assertEqual(rows[6], f'part -= patterned(extrude(sketch("Vent"), amount=-P["depth"]), {pat})'
                                  '  # pattern of line 4')
        self.assertEqual(rows[7], f'part = holes(part, at=patterned(sketch_points("Boss"), {pat}), '
                                  'kind="insert", size="M3", standoff=dict(h=5, d=7))  # pattern of line 5')
        self.assertTrue(rows[8].startswith('part = fillet(part, patterned(edges_ref([{'))
        self.assertTrue(rows[8].endswith(f'{pat}), radius=P["r"])  # pattern of line 6'))
        self.assertEqual(rows[9], "part = shell(part, thickness=2.0)")

    def test_circular_and_expressions(self):
        face = {"center": [50, 30, 10], "normal": [0, 0, 1], "kind": "cylinder", "hint": "hole wall"}
        code, made, _, keys = pe.pattern_steps(CODE, [5], {"type": "circular", "axis": {"face": face}, "count": 6,
                                                           "angle": 360})
        self.assertEqual(keys, ["boss_count"])
        self.assertIn(f'circular(face_ref({pe._lit(face)}), P["boss_count"])), kind="insert"', code)
        code, _, _, keys = pe.pattern_steps(CODE, [4], {"type": "linear", "dir": {"base": "Y"}, "count": "depth * 2",
                                                        "mode": "extent", "extent": 40, "symmetric": True})
        self.assertEqual(keys, ["vent_extent"])
        self.assertIn('linear("Y", P["depth"] * 2, extent=P["vent_extent"], symmetric=True))  # pattern of line 4',
                      code)
        with self.assertRaisesRegex(pe.ParamError, "original"):
            pe.pattern_steps(CODE, [4], dict(GRID, skip=[0]))
        with self.assertRaisesRegex(pe.ParamError, "whole number"):
            pe.pattern_steps(CODE, [4], dict(GRID, count=2.5))

    def test_what_cant_be_patterned_is_listed(self):
        code, _, _, _ = pe.pattern_steps(CODE, [4], GRID)
        code, _, _ = pe.mirror_steps(code, [6], "XZ")          # the holes: their mirror copy on 7
        _, made, skipped, _ = pe.pattern_steps(code, [5, 6, 7], GRID)
        self.assertEqual(made, [{"of": 6, "line": 7}])
        self.assertEqual([s["line"] for s in skipped], [5, 7])
        self.assertIn("pattern copy already", skipped[0]["reason"])
        self.assertIn("mirrored copy already", skipped[1]["reason"])

    def test_the_copies_run(self):
        code, _, _, _ = pe.pattern_steps(CODE, [4], dict(GRID, spacing=10, spacing2=15))
        rows = [r for r in _rows(code) if not r.startswith(("from ", "part = holes", "part = fillet", "part = shell"))]
        r = _run("\n".join(rows))
        self.assertEqual(len(_floors(r, 18)), 24 - 2)


class LinkTests(SimpleTestCase):
    def setUp(self):
        self.code, _, _, _ = pe.pattern_steps(CODE, [4, 5], GRID)

    def test_editing_the_original_rewrites_its_copy(self):
        code = pe.add_extrude(self.code, "Vent", "cut", depth=3.0, line=4)
        code = code if isinstance(code, str) else code[0]
        self.assertIn('part -= patterned(extrude(sketch("Vent"), amount=-P["depth"]), linear(', _rows(code)[5])
        code, _ = pe.add_holes(code, {"sketch": "Boss"}, kind="clearance", size="M2.5", line=5)
        self.assertIn('part = holes(part, at=patterned(sketch_points("Boss"), linear(', _rows(code)[6])
        self.assertIn('kind="clearance", size="M2.5"', _rows(code)[6])
        self.assertTrue(_rows(code)[6].endswith("# pattern of line 5"))

    def test_a_copy_reads_back_with_its_pattern(self):
        got = pe.op_at(self.code, 6)
        self.assertEqual(got["op"], "extrude")
        pat = got["pattern"]
        self.assertEqual(pat["of"], 4)
        self.assertEqual(pat["lines"], [6, 7])
        self.assertEqual(pat["label"], "8 × 3, 2 skipped")
        self.assertEqual(pat["params"], {"count": "vent_count", "spacing": "vent_pitch", "count2": "vent_count2",
                                         "spacing2": "vent_pitch2"})
        a = pat["args"]
        self.assertEqual((a["type"], a["dir"], a["count"], a["spacing"], a["mode"], a["skip"]),
                         ("linear", {"base": "X"}, 8, 6.0, "spacing", [3, 9]))
        self.assertEqual((a["dir2"], a["count2"], a["spacing2"]), ({"base": "Y"}, 3, 10.0))
        self.assertNotIn("pattern", pe.op_at(self.code, 4))

    def test_set_pattern_rewrites_the_group_and_keeps_skip(self):
        code, keys = pe.set_pattern(self.code, 7, dict(GRID, count=10, spacing=5, skip=[2, 12]))
        self.assertEqual(keys, ["vent_count", "vent_pitch", "vent_count2", "vent_pitch2"])
        self.assertIn("vent_count=10, vent_pitch=5", _rows(code)[1])
        for row in _rows(code)[5:7]:
            self.assertIn("skip=[2, 12]))", row)
            self.assertEqual(row.count("# pattern of line"), 1)
        got = pe.op_at(code, 6)["pattern"]
        self.assertEqual((got["args"]["skip"], got["label"]), ([2, 12], "10 × 3, 2 skipped"))
        # one direction only: the second's P keys go
        code, keys = pe.set_pattern(code, 6, {"type": "linear", "dir": {"base": "X"}, "count": 10, "spacing": 5})
        self.assertEqual(keys, ["vent_count", "vent_pitch"])
        self.assertNotIn("vent_count2", code)
        self.assertEqual(pe.op_at(code, 7)["pattern"]["label"], "10 along X")
        with self.assertRaisesRegex(pe.ParamError, "not a pattern copy"):
            pe.set_pattern(code, 4, GRID)

    def test_a_count_change_in_P_keeps_skip_on_the_same_copies(self):
        # skip [3, 9] of 8 × 3: (3, row 0) and (1, row 1); 6 to a row, (1, row 1) is 7
        code = pe.set_params(self.code, {"vent_count": 6})
        self.assertEqual(pe.op_at(code, 6)["pattern"]["args"]["skip"], [3, 7])
        self.assertEqual(_rows(code)[6].count("skip=[3, 7]"), 1)
        # 2 to a row: (3, row 0) is gone, (1, row 1) is 3
        self.assertEqual(pe.op_at(pe.set_params(code, {"vent_count": 2}), 6)["pattern"]["args"]["skip"], [3])
        # a spacing change leaves skip as it was
        self.assertIn("skip=[3, 9]", pe.set_params(self.code, {"vent_pitch": 7}))
        # round the full circle the indices stay; past the count they go
        code, _ = pe.add_pattern_body(CODE, {"type": "circular", "axis": {"base": "Z"}, "count": 6, "skip": [2, 5]})
        self.assertIn("skip=[2, 5]", pe.set_params(code, {"pattern_count": 8}))
        self.assertIn("skip=[2]", pe.set_params(code, {"pattern_count": 4}))

    def test_unlink_makes_it_independent(self):
        code = pe.unlink(self.code, 7)
        self.assertNotIn("# pattern of line", _rows(code)[6])
        self.assertIsNone(pe.op_at(code, 7)["pattern"]["of"])
        self.assertEqual(pe.op_at(code, 6)["pattern"]["of"], 4)

    def test_line_numbers_follow_lines_moving(self):
        code = pe.add_param(self.code.replace("P = dict(", "P = dict(\n    "), "extra", 1)
        self.assertTrue(_rows(code)[7].endswith("# pattern of line 6"))      # one line down
        code = pe.delete_step(code, 6, copies="delete")      # the holes and their copy
        self.assertEqual(sum("# pattern of line" in r for r in _rows(code)), 1)
        self.assertTrue(_rows(code)[5].endswith("# pattern of line 5"), _rows(code)[5])

    def test_deleting_the_original_keeps_or_deletes_its_copies(self):
        kept = pe.delete_step(self.code, 4, copies="keep")
        self.assertIn("patterned(extrude(", kept)
        self.assertEqual(sum("# pattern of line" in r for r in _rows(kept)), 1)
        gone = pe.delete_step(self.code, 4, copies="delete")
        self.assertNotIn("patterned(extrude(", gone)
        self.assertEqual([s["pattern_of"] for s in pe.steps(gone) if s.get("pattern")], [4])

    def test_steps_show_copies_with_their_original(self):
        rows = {s["line"]: s for s in pe.steps(self.code)}
        self.assertEqual((rows[6]["pattern_of"], rows[6]["pattern"]), (4, "8 × 3, 2 skipped"))
        self.assertEqual(rows[6]["summary"], "Cut 'Vent' 2 mm into the part · pattern 8 × 3, 2 skipped")
        self.assertEqual(rows[7]["pattern_of"], 5)
        self.assertTrue(rows[6]["reopenable"])
        self.assertIsNone(rows[4]["pattern_of"])
        self.assertIsNone(rows[4]["mirror_of"])


class PatternBodyRoundTripTests(SimpleTestCase):
    def test_round_trip(self):
        code, keys = pe.add_pattern_body(CODE, {"type": "linear", "dir": {"base": "X"}, "count": 4, "spacing": 120},
                                         join=False)
        self.assertEqual(keys, ["pattern_count", "pattern_pitch"])
        self.assertTrue(code.endswith('part = pattern_body(part, linear("X", P["pattern_count"], '
                                      'spacing=P["pattern_pitch"]), join=False)\n'))
        got = pe.op_at(code, 8)
        self.assertEqual(got["op"], "pattern_body")
        self.assertEqual((got["args"]["join"], got["args"]["pattern"]["count"]), (False, 4))
        self.assertEqual(next(s for s in pe.steps(code) if s["line"] == 8)["summary"],
                         "Pattern body 4 along X · separate bodies")
        code, keys = pe.add_pattern_body(code, {"type": "circular", "axis": {"base": "Z"}, "count": 6, "angle": 90,
                                                "skip": [2]}, join=True, line=8)
        self.assertEqual(keys, ["pattern_count", "pattern_angle"])
        self.assertNotIn("pattern_pitch", code)
        a = pe.op_at(code, 8)["args"]["pattern"]
        self.assertEqual((a["type"], a["count"], a["angle"], a["skip"]), ("circular", 6, 90.0, [2]))
        self.assertEqual(pe.pattern_label(a), "6 round Z over 90°, 1 skipped")
        with self.assertRaisesRegex(pe.ParamError, "no part"):
            pe.add_pattern_body("P = dict()\n", GRID)
