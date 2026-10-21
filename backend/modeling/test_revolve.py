"""Revolve (modeling/revolve.py, sketch_profile.sketch_line, paramedit's
revolve section): a sketch profile turned around a line of the sketch, a
part edge, a cylinder's axis or a base axis; the checks that stop it (the
profile crossing the axis, the axis off the sketch plane, an open profile);
the script line the dialog writes and reads back; and Revolve steps in
mirror and pattern copies."""

import math

from django.test import SimpleTestCase

from modeling import paramedit as pe
from modeling.engine import EngineError, run_script


def _rect(x0, y0, x1, y1):
    p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    return [{"t": "line", "p": [p[i], p[(i + 1) % 4]]} for i in range(4)]


def _front(loops=(), lines=None, y=0.0):
    """A sketch on the Front plane (normal -Y), given in world x, z: the
    sketch's y is world -z. Its V axis is the world Z axis."""
    flip = [[{**e, "p": [[x, -z] for x, z in e["p"]]} for e in loop] for loop in loops]
    out = {"plane": {"origin": [0, y, 0], "normal": [0, -1, 0], "xAxis": [1, 0, 0]}, "loops": flip}
    if lines is not None:
        out["lines"] = {k: [[x, -z] for x, z in v] for k, v in lines.items()}
    return out


def _top(loops=(), h=0.0):
    return {"plane": {"origin": [0, 0, h], "normal": [0, 0, 1], "xAxis": [1, 0, 0]},
            "loops": [[{**e, "p": [[x, -y] for x, y in e["p"]]} for e in loop] for loop in loops]}


def _cyl_radii(r, axis_xy=(0, 0)):
    """The radii of the cylindrical faces round the vertical axis at axis_xy."""
    return sorted({round(f["radius"], 4) for f in r["faces"] if f["kind"] == "cylinder"
                   and abs(f["axis_point"][0] - axis_xy[0]) < 1e-6 and abs(f["axis_point"][1] - axis_xy[1]) < 1e-6})


# a 10 × 30 rectangle from 10 to 20 beside the V axis (world Z)
TUBE = _front([_rect(10, 0, 20, 30)])
V = 'axis=sketch_line("K", "axis-v")'


def _run(code, **sk):
    r = run_script(code, sketches=sk or {"K": TUBE})
    assert not r.get("warning"), r.get("warning")
    return r


class RevolveShapeTests(SimpleTestCase):
    def test_full_turn_is_a_tube(self):
        r = _run(f'part = revolve(sketch("K"), {V}, angle=360)\n')
        self.assertAlmostEqual(r["metrics"]["volume"], math.pi * (20 ** 2 - 10 ** 2) * 30, places=2)
        self.assertEqual(_cyl_radii(r), [10, 20])
        self.assertEqual([round(v, 6) for v in r["metrics"]["bbox_min"]], [-20, -20, 0])
        self.assertEqual([round(v, 6) for v in r["metrics"]["bbox_max"]], [20, 20, 30])
        rev = r["revolves"][0]
        self.assertEqual((rev["line"], rev["angle"], rev["radius"]), (1, 360, 20))
        self.assertEqual(rev["label"], "the V axis of 'K'")

    def test_a_quarter_turns_out_of_the_side_the_sketch_faces(self):
        r = _run(f'part = revolve(sketch("K"), {V}, angle=90)\n')
        self.assertAlmostEqual(r["metrics"]["volume"], math.pi * 300 * 30 / 4, places=2)
        lo, hi = r["metrics"]["bbox_min"], r["metrics"]["bbox_max"]
        self.assertAlmostEqual(lo[1], -20, places=6)       # the Front plane faces -Y
        self.assertAlmostEqual(hi[1], 0, places=6)
        self.assertAlmostEqual(lo[0], 0, places=6)
        r = _run(f'part = revolve(sketch("K"), {V}, angle=90, flip=True)\n')
        self.assertAlmostEqual(r["metrics"]["bbox_min"][1], 0, places=6)
        self.assertAlmostEqual(r["metrics"]["bbox_max"][1], 20, places=6)

    def test_both_ways_is_symmetric_about_the_sketch_plane(self):
        r = _run(f'part = revolve(sketch("K"), {V}, angle=90, both=True)\n')
        lo, hi = r["metrics"]["bbox_min"], r["metrics"]["bbox_max"]
        self.assertAlmostEqual(lo[1], -hi[1], places=6)
        self.assertAlmostEqual(hi[1], 20 * math.sin(math.radians(45)), places=6)
        self.assertAlmostEqual(r["metrics"]["volume"], math.pi * 300 * 30 / 4, places=2)

    def test_an_angle_from_p_and_the_h_axis_and_a_construction_line(self):
        r = _run(f'P = dict(arc=180)\npart = revolve(sketch("K"), {V}, angle=P["arc"])\n')
        self.assertAlmostEqual(r["metrics"]["volume"], math.pi * 300 * 30 / 2, places=2)
        # about H (world X): the rectangle above it, touching it, makes a solid disc
        r = _run('part = revolve(sketch("K"), axis=sketch_line("K", "axis-h"), angle=360)\n')
        self.assertAlmostEqual(r["metrics"]["volume"], math.pi * 30 ** 2 * 10, places=2)
        # a construction line x = 5 (world): radii 5 and 15
        sk = _front([_rect(10, 0, 20, 30)], lines={"c1": [[5, 0], [5, 10]]})
        r = _run('part = revolve(sketch("K"), axis=sketch_line("K", "c1"), angle=360)\n', K=sk)
        self.assertEqual(_cyl_radii(r, (5, 0)), [5, 15])

    def test_join_and_cut(self):
        base = 'part = Cylinder(10, 30, align=(Align.CENTER, Align.CENTER, Align.MIN))\n'
        r = _run(base + f'part += revolve(sketch("K"), {V}, angle=360)\n')
        self.assertAlmostEqual(r["metrics"]["volume"], math.pi * 20 ** 2 * 30, places=2)
        groove = _front([_rect(8, 10, 12, 14)])
        r = _run(base + f'part -= revolve(sketch("K"), {V}, angle=360)\n', K=groove)
        self.assertAlmostEqual(r["metrics"]["volume"], math.pi * 100 * 30 - math.pi * (100 - 64) * 4, places=2)

    def test_x_y_z_base_axes(self):
        r = _run('part = revolve(sketch("K"), axis="Z", angle=360)\n')
        self.assertAlmostEqual(r["metrics"]["volume"], math.pi * 300 * 30, places=2)
        r = _run('part = revolve(sketch("K"), axis="X", angle=360)\n')
        self.assertAlmostEqual(r["metrics"]["volume"], math.pi * 30 ** 2 * 10, places=2)

    def test_build123d_revolve_still_works(self):
        r = _run('part = revolve(Pos(15, 0, 0) * Rectangle(10, 10), Axis.Y, 360)\n')
        self.assertAlmostEqual(r["metrics"]["volume"], math.pi * (20 ** 2 - 10 ** 2) * 10, places=2)


# a boss of radius r on the Z axis at x = cx (on the Front plane: y = 0)
BOSS = ('P = dict(r={r})\n'
        'part = Pos({cx}, 0, 0) * Cylinder(P["r"], 40, align=(Align.CENTER, Align.CENTER, Align.MIN))\n')


def _boss_face(r=10, cx=30):
    out = run_script(BOSS.format(r=r, cx=cx))
    return next(f["ref"] for f in out["faces"] if f["ref"] and f["kind"] == "cylinder")


class RevolveAxisTests(SimpleTestCase):
    def test_a_groove_round_a_boss_by_its_cylinder(self):
        face = _boss_face()
        line = f'part -= revolve(sketch("G"), axis=face_ref({face}), angle=360)\n'
        groove = _front([_rect(38, 18, 45, 22)])     # 8 from the axis outward, 4 tall
        for r in (10, 12):                           # the boss grows: the groove's axis is found again
            out = run_script(BOSS.format(r=r, cx=30) + line, sketches={"G": groove})
            self.assertFalse(out.get("warning"))
            self.assertEqual(out["face_refs"][0]["status"] in ("found", "moved"), True)
            self.assertAlmostEqual(out["metrics"]["volume"], math.pi * r * r * 40 - math.pi * (r * r - 64) * 4,
                                   places=2)
            self.assertEqual(_cyl_radii(out, (30, 0)), [8, r])
            floor = next(f for f in out["faces"] if f["kind"] == "cylinder" and abs(f["radius"] - 8) < 1e-6)
            self.assertAlmostEqual(floor["axis_point"][2], 20, places=4)      # the groove's middle height

    def test_a_straight_part_edge(self):
        base = 'part = Box(40, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN))\n'
        r0 = run_script(base)
        corner = next(e["ref"] for e in r0["edges"] if e["ref"] and e["ref"]["hint"] == "front-left edge")
        # a 5..15 × 10 rectangle on y = 0 turned a quarter into the box (+Y: flipped) about its x = 0 edge
        r = _run(base + f'part -= revolve(sketch("K"), axis=edge_ref({corner}), angle=90, flip=True)\n',
                 K=_front([_rect(5, 0, 15, 10)]))
        self.assertAlmostEqual(r["metrics"]["volume"], 40 * 20 * 10 - math.pi * (225 - 25) * 10 / 4, places=2)
        self.assertEqual(r["revolves"][0]["label"], "the picked edge")

    def test_profile_crossing_the_axis(self):
        with self.assertRaises(EngineError) as ctx:
            run_script(f'part = revolve(sketch("K"), {V}, angle=360)\n',
                       sketches={"K": _front([_rect(-5, 0, 5, 10)])})
        self.assertIn("the profile crosses the revolve axis (the V axis of 'K')", str(ctx.exception))
        self.assertIn("it may touch it", str(ctx.exception))
        crossings = ctx.exception.revolves[0]["crossings"]
        self.assertEqual(sorted(round(p[2], 3) for p in crossings), [0, 10])
        self.assertTrue(all(abs(p[0]) < 1e-6 for p in crossings))
        # touching is fine
        _run(f'part = revolve(sketch("K"), {V}, angle=360)\n', K=_front([_rect(0, 0, 5, 10)]))

    def test_axis_not_in_the_sketch_plane(self):
        msg = lambda code, sk: self._fails(code, sk)    # noqa: E731
        m = msg('part = revolve(sketch("K"), axis="Y", angle=360)\n', TUBE)
        self.assertIn("the Y axis runs straight out of the sketch plane", m)
        # the Front plane moved to y = 5 faces -Y: the X axis (y = 0) is in front of it
        m = msg('part = revolve(sketch("K"), axis="X", angle=360)\n', _front([_rect(10, 0, 20, 30)], y=5))
        self.assertIn("the X axis is 5 mm off the sketch plane, in front of it (the side the sketch faces, "
                      "toward -Y)", m)
        m = msg('part = revolve(sketch("K"), axis="X", angle=360)\n', _front([_rect(10, 0, 20, 30)], y=-5))
        self.assertIn("behind it (the side away from the sketch's face, toward +Y)", m)
        face = _boss_face(cx=30)
        m = msg(BOSS.format(r=10, cx=30) + f'part += revolve(sketch("K"), axis=face_ref({face}), angle=90)\n',
                _top([_rect(50, 0, 60, 10)], h=40))
        self.assertIn("the picked cylinder's axis runs straight out of the sketch plane", m)

    def test_open_profile_and_bad_angle(self):
        m = self._fails(f'part = revolve(sketch("K"), {V}, angle=360)\n', _front([]))
        self.assertIn("has no closed shapes", m)
        m = self._fails(f'part = revolve(sketch("K"), {V}, angle=400)\n', TUBE)
        self.assertIn("at most 360°", m)
        m = self._fails('part = revolve(sketch("K"), axis=sketch_line("K", "nope"), angle=360)\n', TUBE)
        self.assertIn("has no straight line 'nope'", m)

    def _fails(self, code, sk):
        """The error: raised when nothing built, a warning when it failed after the part was made."""
        try:
            r = run_script(code, sketches={"K": sk})
        except EngineError as exc:
            return str(exc)
        self.assertTrue(r.get("warning"), "expected the revolve to fail")
        return r["warning"]


GROOVE_FACE = {"center": [30, 0, 20], "normal": [0, 0, 1], "kind": "cylinder", "hint": "boss wall"}


class RevolveScriptTests(SimpleTestCase):
    def test_add_and_read_back(self):
        code = pe.add_revolve("", "Knob", "new", {"line": "axis-v"})
        self.assertEqual(code, 'part = revolve(sketch("Knob"), axis=sketch_line("Knob", "axis-v"), angle=360)\n')
        code = pe.add_revolve('P = dict(arc=90)\n' + code, "Groove", "cut", {"face": GROOVE_FACE}, "arc * 2",
                              both=True, flip=True)
        rows = code.rstrip("\n").split("\n")
        self.assertEqual(rows[-1], f'part -= revolve(sketch("Groove"), axis=face_ref({pe._lit(GROOVE_FACE)}), '
                                   'angle=P["arc"] * 2, both=True, flip=True)')
        op = pe.op_at(code, len(rows))
        self.assertEqual(op["op"], "revolve")
        self.assertEqual(op["args"], {"sketch": "Groove", "op": "cut", "axis": {"face": GROOVE_FACE},
                                      "angle": 180, "both": True, "flip": True})
        self.assertEqual(op["exprs"], {"angle": "arc * 2"})
        op = pe.op_at(code, 2)
        self.assertEqual(op["args"]["axis"], {"line": "axis-v"})
        self.assertEqual(pe.add_revolve("part = Box(1, 1, 1)\n", "K", "join", "X", 45),
                         'part = Box(1, 1, 1)\npart += revolve(sketch("K"), axis="X", angle=45)\n')

    def test_reopen_rewrites_the_line(self):
        code = 'part = Box(10, 10, 10)\npart += revolve(sketch("K"), axis=sketch_line("K", "axis-v"), angle=360)\n'
        code = pe.add_revolve(code, "ignored", "cut", {"line": "axis-h"}, 90, flip=True, line=2)
        self.assertEqual(code.split("\n")[1],
                         'part -= revolve(sketch("K"), axis=sketch_line("K", "axis-h"), angle=90, flip=True)')
        with self.assertRaisesRegex(pe.ParamError, "only for the first body"):
            pe.add_revolve(code, "K", "new", {"line": "axis-h"}, 90, line=2)
        with self.assertRaisesRegex(pe.ParamError, "already makes a part"):
            pe.add_revolve(code, "K", "new", {"line": "axis-h"})
        with self.assertRaisesRegex(pe.ParamError, "at most 360"):
            pe.add_revolve(code, "K", "cut", {"line": "axis-h"}, 0)
        with self.assertRaisesRegex(pe.ParamError, "not a parameter"):
            pe.add_revolve(code, "K", "cut", {"line": "axis-h"}, "arc")
        with self.assertRaisesRegex(pe.ParamError, "pick an axis"):
            pe.add_revolve(code, "K", "cut", {})

    def test_steps(self):
        code = ('part = revolve(sketch("Knob"), axis=sketch_line("Knob", "axis-v"), angle=360)\n'
                f'part -= revolve(sketch("Groove"), axis=face_ref({pe._lit(GROOVE_FACE)}), angle=180, both=True)\n'
                'part += revolve(Pos(1, 0, 0) * Rectangle(1, 1), Axis.Y, 360)\n')
        s = pe.steps(code)
        self.assertEqual([(x["op"], x["variant"], x["reopenable"]) for x in s],
                         [("revolve", "new", True), ("revolve", "cut", True), ("revolve", "join", False)])
        self.assertEqual(s[0]["summary"], "New body 'Knob' revolved 360° about the V axis")
        self.assertEqual(s[1]["summary"], "Cut 'Groove' revolved 180° about the boss wall both ways")
        self.assertEqual((s[0]["sketch"], s[1]["faces"]), ("Knob", [GROOVE_FACE]))
        self.assertEqual(s[2]["summary"], "Join · written in code")

    def test_mirror_and_pattern_steps(self):
        base = ('part = Box(100, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN))\n'
                'part -= revolve(sketch("K"), axis=sketch_line("K", "c1"), angle=360)\n')
        code, made, skipped = pe.mirror_steps(base, [2], {"base": "YZ"})
        self.assertEqual((made, skipped), ([{"of": 2, "line": 3}], []))
        self.assertEqual(code.split("\n")[2], 'part -= mirrored(revolve(sketch("K"), axis=sketch_line("K", "c1"), '
                                              'angle=360), "YZ")  # mirror of line 2 across YZ')
        self.assertEqual(pe.op_at(code, 3)["mirror"]["of"], 2)
        # editing the original rewrites its copy
        code2 = pe.add_revolve(code, "K", "cut", {"line": "c1"}, 180, line=2)
        self.assertIn('mirrored(revolve(sketch("K"), axis=sketch_line("K", "c1"), angle=180), "YZ")', code2)
        code, made, _, keys = pe.pattern_steps(base, [2], {"type": "linear", "dir": {"base": "X"}, "count": 3,
                                                          "spacing": 30})
        self.assertEqual(keys, ["k_count", "k_pitch"])
        self.assertIn('part -= patterned(revolve(sketch("K"), axis=sketch_line("K", "c1"), angle=360), '
                      'linear("X", P["k_count"], spacing=P["k_pitch"]))  # pattern of line 4', code)
        # they run: a ring groove of radius 2..4 round x = 15, then its pattern copies at 45 and 75
        sk = _front([_rect(17, 3, 19, 7)], lines={"c1": [[15, 0], [15, 10]]})
        hole = math.pi * (16 - 4) * 4
        r = _run(code, K=sk)
        self.assertAlmostEqual(r["metrics"]["volume"], 100 * 20 * 10 - 3 * hole / 2, places=2)
