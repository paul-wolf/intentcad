"""Up to face and Up to next (modeling/until.py, paramedit's extrude
section): a boss down to a slanted wall (with an offset either way), a rib
ending on a tube, a lid standoff down to the floor and a set screw into the
bore (both following a parameter), a profile whose regions meet different
faces, the clear errors, the script lines the dialog writes and reads back,
and until extrudes in mirror and pattern copies."""

import json
import math

from django.test import SimpleTestCase

from modeling import paramedit as pe
from modeling.engine import EngineError, run_script

TAN30 = math.tan(math.radians(30))


def _plane(o, n, x=(1, 0, 0)):
    return {"origin": list(o), "normal": list(n), "xAxis": list(x)}


def _circ(cx, cy, r):
    return [{"t": "circle", "c": [cx, cy], "r": r}]


def _rect(x0, y0, x1, y1):
    p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    return [{"t": "line", "p": [p[i], p[(i + 1) % 4]]} for i in range(4)]


def _flat(z, loops, ref=None):
    """A sketch on a horizontal plane at height z, normal +Z (sketch y is
    world -y)."""
    flip = [[{**e, "c": [e["c"][0], -e["c"][1]]} if "c" in e else {**e, "p": [[x, -y] for x, y in e["p"]]}
             for e in loop] for loop in loops]
    out = {"plane": _plane((0, 0, z), (0, 0, 1)), "loops": flip}
    if ref:
        out["planeRef"] = ref
    return out


def _run(code, **sk):
    r = run_script(code, sketches=sk)
    assert not r.get("warning") and not r.get("error"), r.get("warning") or r.get("error")
    return r


def _fails(code, **sk):
    try:
        r = run_script(code, sketches=sk)
    except EngineError as e:
        return str(e)
    return r.get("error") or r.get("warning") or ""


def _vol(r):
    return r["metrics"]["volume"]


def _lit(ref):
    return json.dumps(ref)


# a 40 × 20 × 20 block with its top cut away by a plane through the top
# right edge, 30° down: the slanted wall z = 20 + (x - 20)·tan30
BLOCK = "part = Box(40, 20, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))\n"


def _slanted():
    r = _run(BLOCK)
    top = next(f for f in r["faces"] if f["normal"][2] > 0.99)
    right = next(f for f in r["faces"] if f["normal"][0] > 0.99)
    edge = next(e for e in r["edges"] if set(e["faceIndices"]) == {top["index"], right["index"]})
    code = (BLOCK + f'PLANES["Tilt"] = edge_plane(edge_ref({_lit(edge["ref"])}), angle=-30, '
            f'from_face=face_ref({_lit(top["ref"])}))\n'
            'part -= PLANES["Tilt"] * Box(200, 200, 100, align=(Align.CENTER, Align.CENTER, Align.MIN))\n'
            'PLANES["Above"] = offset_plane("XY", distance=40)\n')
    r = _run(code)
    wall = next(f for f in r["faces"] if f["kind"] == "plane" and 0.3 < f["normal"][2] < 0.99)
    return code, wall


class UpToFaceTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.code, cls.wall = _slanted()
        cls.boss = _flat(40, [_circ(10, 0, 2)], "Above")

    def _end(self, offset):
        """The boss alone (r = 2 at x = 10, from z = 40 down to the wall)."""
        off = f", offset={offset}" if offset else ""
        r = _run(self.code + f'b = extrude(sketch("B"), until=face_ref({_lit(self.wall["ref"])}){off}, dir=-1)\n'
                 'part = b\n', B=self.boss)
        end = [f for f in r["faces"] if f["kind"] == "plane" and 0.3 < f["normal"][2] < 0.99
               or f["kind"] == "plane" and -0.99 < f["normal"][2] < -0.3]
        return r, end

    def test_a_boss_ends_on_the_slanted_wall(self):
        r, end = self._end(0)
        self.assertEqual(len(end), 1)
        (x, y, z), n = end[0]["center"], end[0]["normal"]
        self.assertAlmostEqual(abs(n[0]), 0.5, places=4)
        self.assertAlmostEqual(z, 20 + (x - 20) * TAN30, places=4)  # on the wall's surface
        self.assertAlmostEqual(_vol(r), math.pi * 4 * (40 - (20 - 10 * TAN30)), places=2)

    def test_offset_moves_the_end_past_or_short_of_the_wall(self):
        r0, _ = self._end(0)
        for off in (1, -1):
            r, end = self._end(off)
            (x, _, z) = end[0]["center"]
            # offset along the wall's normal: 1/cos30 lower (past) or higher (short)
            self.assertAlmostEqual(z, 20 + (x - 20) * TAN30 - off / math.cos(math.radians(30)), places=4)
            self.assertAlmostEqual(_vol(r) - _vol(r0), off * math.pi * 4 / math.cos(math.radians(30)), places=2)

    def test_joined_to_the_part(self):
        base = _vol(_run(self.code))
        r = _run(self.code + f'part += extrude(sketch("B"), until=face_ref({_lit(self.wall["ref"])}), dir=-1)\n',
                 B=self.boss)
        self.assertAlmostEqual(_vol(r) - base, math.pi * 4 * (40 - (20 - 10 * TAN30)), places=2)
        self.assertEqual([x["status"] for x in r["face_refs"]][-1], "found")

    def test_a_rib_ends_on_a_tube_shaped_to_it(self):
        tube = "part = Cylinder(8, 40, rotation=(0, 90, 0))\npart -= Cylinder(6, 40, rotation=(0, 90, 0))\n"
        outer = next(f for f in _run(tube)["faces"] if f["kind"] == "cylinder" and abs(f["radius"] - 8) < 1e-6)
        rib = _flat(20, [_rect(-10, -1, 10, 1)])
        r = _run(tube + f'b = extrude(sketch("R"), until=face_ref({_lit(outer["ref"])}), dir=-1)\npart = b\n', R=rib)
        # from z = 20 down to z = sqrt(64 - y²) across y in [-1, 1]
        self.assertAlmostEqual(_vol(r), 20 * (40 - (math.sqrt(63) + 64 * math.asin(1 / 8))), places=2)
        self.assertEqual([round(f["radius"], 6) for f in r["faces"] if f["kind"] == "cylinder"], [8])

    def test_a_face_it_never_reaches(self):
        side = next(f for f in _run(BLOCK)["faces"] if f["normal"][1] < -0.99)
        msg = _fails(self.code + f'part += extrude(sketch("B"), until=face_ref({_lit(side["ref"])}), dir=-1)\n',
                     B=self.boss)
        self.assertRegex(msg, r"never reaches the .*face")


# an open case: an 80 × 60 × 25 box hollowed from z = 3, with a lid plane on top
def _case(h):
    return (f"P = dict(h={h})\n"
            'part = Box(80, 60, P["h"], align=(Align.CENTER, Align.CENTER, Align.MIN))\n'
            'part -= Box(74, 54, P["h"] - 3, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((0, 0, 3)))\n'
            'PLANES["Lid"] = offset_plane("XY", distance=P["h"])\n')


def _hub(r):
    return (f"P = dict(hub_r={r})\n"
            'part = Cylinder(P["hub_r"], 20, align=(Align.CENTER, Align.CENTER, Align.MIN))\n'
            'part -= Cylinder(3, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))\n')


def _screw_removed(r_hub, r=1.5, bore=3.0, n=2000):
    """The volume of a radius-r hole along X at y = 0, from the hub's outer
    wall in to the bore."""
    tot, h = 0.0, 2 * r / n
    for i in range(n):
        y = -r + (i + 0.5) * h
        tot += 2 * math.sqrt(r * r - y * y) * (math.sqrt(r_hub ** 2 - y * y) - math.sqrt(bore ** 2 - y * y)) * h
    return tot


class UpToNextTests(SimpleTestCase):
    def test_lid_standoffs_reach_the_floor_and_follow_the_height(self):
        lid = _flat(25, [_circ(-30, -20, 3), _circ(30, 20, 3)], "Lid")
        for h in (25, 35):
            base = 80 * 60 * h - 74 * 54 * (h - 3)
            r = _run(_case(h) + 'part += extrude(sketch("Boss"), until="next", dir=-1)\n', Boss=lid)
            self.assertAlmostEqual(_vol(r), base + 2 * math.pi * 9 * (h - 3), places=2)
            self.assertAlmostEqual(r["metrics"]["bbox_max"][2], h, places=6)

    def test_set_screw_reaches_the_bore_not_the_far_side(self):
        for hub_r in (10, 14):
            code = _hub(hub_r)
            outer = max((f for f in _run(code)["faces"] if f["kind"] == "cylinder"), key=lambda f: f["radius"])
            if hub_r == 10:
                ref = outer["ref"]  # found again after the hub grows
            # the tangent plane's x runs along the hub's axis, y round it
            scr = {"plane": _plane((hub_r, 0, 0), (1, 0, 0), (0, 1, 0)), "loops": [_circ(10, 0, 1.5)],
                   "planeRef": "Screw"}
            plane = f'PLANES["Screw"] = tangent_plane(face_ref({_lit(ref)}), angle=0, ref="X")\n'
            base = math.pi * (hub_r ** 2 - 9) * 20
            for d in ("", ", dir=-1"):  # nothing out there: either way it goes in
                r = _run(code + plane + f'part -= extrude(sketch("S"), until="next"{d})\n', S=scr)
                self.assertAlmostEqual(base - _vol(r), _screw_removed(hub_r), places=1)
                self.assertEqual(r["face_refs"][0]["status"], "found")

    def test_regions_stop_at_their_own_faces(self):
        # a floor 2 thick, with a shelf up to 10 over x in [0, 20]
        step = ("part = Box(40, 20, 2, align=(Align.CENTER, Align.CENTER, Align.MIN))\n"
                "part += Box(20, 20, 10, align=(Align.MIN, Align.CENTER, Align.MIN))\n")
        base = 40 * 20 * 2 + 20 * 20 * 8
        two = _flat(30, [_circ(-10, 0, 2), _circ(10, 0, 2)])
        r = _run(step + 'part += extrude(sketch("T"), until="next", dir=-1)\n', T=two)
        self.assertAlmostEqual(_vol(r), base + math.pi * 4 * (28 + 20), places=2)
        # one shape over the step: each side stops at its own face
        span = _flat(30, [_rect(-5, -2, 5, 2)])
        r = _run(step + 'part += extrude(sketch("T"), until="next", dir=-1)\n', T=span)
        self.assertAlmostEqual(_vol(r), base + 5 * 4 * 28 + 5 * 4 * 20, places=2)
        # a cut down from above goes through the shelf (10) and the floor (2)
        # to the empty space under each
        r = _run(step + 'part -= extrude(sketch("T"), until="next", dir=-1)\n', T=span)
        self.assertAlmostEqual(_vol(r), base - 5 * 4 * 10 - 5 * 4 * 2, places=2)

    def test_what_it_cant_do_is_an_error(self):
        step = ("part = Box(40, 20, 2, align=(Align.CENTER, Align.CENTER, Align.MIN))\n"
                "part += Box(20, 20, 10, align=(Align.MIN, Align.CENTER, Align.MIN))\n")
        join = 'part += extrude(sketch("T"), until="next", dir=-1)\n'
        self.assertRegex(_fails(step + join, T=_flat(30, [_rect(15, -2, 25, 2)])), "never meets the part")
        bridge = ("part = Box(40, 20, 2, align=(Align.CENTER, Align.CENTER, Align.MIN))\n"
                  "part += Box(20, 20, 2, align=(Align.MAX, Align.CENTER, Align.MIN)).moved(Location((0, 0, 10)))\n"
                  "part += Box(2, 20, 12, align=(Align.MIN, Align.CENTER, Align.MIN)).moved(Location((-20, 0, 0)))\n")
        self.assertRegex(_fails(bridge + 'part -= extrude(sketch("T"), until="next", dir=-1)\n',
                                T=_flat(30, [_rect(-5, -2, 5, 2)])), "can't stop at the next face")
        self.assertRegex(_fails(step + 'part += extrude(sketch("T"), until="next")\n',
                                T=_flat(1, [_circ(-10, 0, 2)])), "starts inside the part")
        self.assertRegex(_fails('part = extrude(sketch("T"), until="next")\n', T=_flat(1, [_circ(0, 0, 2)])),
                         "no part yet")
        self.assertRegex(_fails(step + 'part += extrude(sketch("T"), until="next", offset=1)\n',
                                T=_flat(30, [_circ(-10, 0, 2)])), "offset= goes with until=a face")


class MirrorPatternTests(SimpleTestCase):
    STEP = ("part = Box(40, 20, 2, align=(Align.CENTER, Align.CENTER, Align.MIN))\n"
            "part += Box(20, 20, 10, align=(Align.MIN, Align.CENTER, Align.MIN))\n")
    LINE = 'part += extrude(sketch("T"), until="next", dir=-1)\n'

    def test_next_is_evaluated_for_each_copy(self):
        # the original (x = -10) reaches the floor; its copy (x = +10) the shelf
        one = _flat(30, [_circ(-10, 0, 2)])
        want = 40 * 20 * 2 + 20 * 20 * 8 + math.pi * 4 * (28 + 20)
        code, made, _ = pe.mirror_steps(self.STEP + self.LINE, [3], {"base": "YZ"})
        self.assertEqual(made, [{"of": 3, "line": 4}])
        self.assertEqual(code.split("\n")[3], 'part += mirrored(extrude(sketch("T"), until="next", dir=-1), "YZ")'
                                              '  # mirror of line 3 across YZ')
        self.assertAlmostEqual(_vol(_run(code, T=one)), want, places=2)
        code, made, _, keys = pe.pattern_steps(self.STEP + self.LINE, [3], {"type": "linear", "dir": {"base": "X"},
                                                                           "count": 2, "spacing": 20})
        self.assertIn('part += patterned(extrude(sketch("T"), until="next", dir=-1), '
                      'linear("X", P["t_count"], spacing=P["t_pitch"]))', code)
        self.assertAlmostEqual(_vol(_run(code, T=one)), want, places=2)

    def test_the_until_face_moves_with_the_copy(self):
        # two roofs tilted 20° the same way at x = -10 and x = +10 (pattern) /
        # mirror images of each other (mirror); a post up from the floor at x = -10
        def roofs(b):
            return ("part = Box(40, 20, 2, align=(Align.CENTER, Align.CENTER, Align.MIN))\n"
                    f"part += Box(16, 20, 2).rotate(Axis.Y, 20).moved(Location((-10, 0, 20)))\n"
                    f"part += Box(16, 20, 2).rotate(Axis.Y, {b}).moved(Location((10, 0, 20)))\n")
        up = _flat(2, [_circ(-10, 0, 2)])
        for b, how in ((-20, "mirror"), (20, "pattern")):
            base = roofs(b)
            r0 = _run(base)
            under = min((f for f in r0["faces"] if f["normal"][2] < -0.5 and f["center"][0] < 0 and f["center"][2] > 5),
                        key=lambda f: f["center"][2])
            line = f'part += extrude(sketch("U"), until=face_ref({_lit(under["ref"])}))\n'
            one = _vol(_run(base + line, U=up)) - _vol(r0)
            self.assertAlmostEqual(one, math.pi * 4 * (20 - 1 / math.cos(math.radians(20)) - 2), places=1)
            if how == "mirror":
                code, _, _ = pe.mirror_steps(base + line, [4], {"base": "YZ"})
            else:
                code, _, _, _ = pe.pattern_steps(base + line, [4], {"type": "linear", "dir": {"base": "X"},
                                                                   "count": 2, "spacing": 20})
            r = _run(code, U=up)
            self.assertAlmostEqual(_vol(r) - _vol(r0), 2 * one, places=2, msg=how)
            self.assertEqual({x["status"] for x in r["face_refs"]}, {"found"})


FACE = {"kind": "plane", "hint": "slanted wall", "normal": [-0.5, 0, 0.866], "origin": [10, 0, 14.2]}


class ScriptTests(SimpleTestCase):
    BASE = "P = dict(w=10)\npart = Box(40, 20, 20)\n"

    def test_add_and_read_back_each_extent(self):
        code, _ = pe.add_extrude(self.BASE, "Boss", "join", extent="next", flip=True)
        self.assertEqual(code.split("\n")[-2], 'part += extrude(sketch("Boss"), until="next", dir=-1)')
        op = pe.op_at(code, 3)["args"]
        self.assertEqual((op["extent"], op["flip"], op["op"]), ("next", True, "join"))
        code, _ = pe.add_extrude(self.BASE, "Rib", "join", extent="face", face=FACE, offset="w / 50")
        self.assertEqual(code.split("\n")[-2],
                         f'part += extrude(sketch("Rib"), until=face_ref({pe._lit(FACE)}), offset=P["w"] / 50)')
        op = pe.op_at(code, 3)
        self.assertEqual((op["args"]["extent"], op["args"]["face"], op["args"]["offset"]), ("face", FACE, 0.2))
        self.assertEqual(op["exprs"]["offset"], "w / 50")
        code, _ = pe.add_extrude(self.BASE, "S", "cut", extent="next")
        self.assertEqual(code.split("\n")[-2], 'part -= extrude(sketch("S"), until="next", dir=-1)')
        self.assertFalse(pe.op_at(code, 3)["args"]["flip"])
        code, _ = pe.add_extrude(self.BASE, "S", "cut", extent="face", face=FACE, offset=-1, datum=True)
        self.assertEqual(code.split("\n")[-2], f'part -= extrude(sketch("S"), until=face_ref({pe._lit(FACE)}), '
                                               'offset=-1)')

    def test_switching_keeps_the_depth_for_switching_back(self):
        code, _ = pe.add_extrude(self.BASE, "S", "cut", 4)
        self.assertIn("cut1_depth=4", code)
        code, key = pe.add_extrude(code, "S", "cut", extent="next", line=3, key="cut1_depth")
        self.assertEqual(key, "cut1_depth")
        self.assertIn("cut1_depth=4", code)  # still in P
        self.assertIn('until="next"', code.split("\n")[2])
        self.assertEqual(pe.op_at(code, 3)["args"]["extent"], "next")
        code, key = pe.add_extrude(code, "S", "cut", 6, extent="distance", line=3, key="cut1_depth")
        self.assertEqual(key, "cut1_depth")
        self.assertIn('P["cut1_depth"]', code.split("\n")[2])
        self.assertIn("cut1_depth=6", code)
        self.assertEqual(code.count("depth="), 1)

    def test_errors(self):
        with self.assertRaisesRegex(pe.ParamError, "needs a part to reach"):
            pe.add_extrude("", "S", "new", extent="next")
        with self.assertRaisesRegex(pe.ParamError, "pick the face"):
            pe.add_extrude(self.BASE, "S", "join", extent="face")

    def test_steps(self):
        code = (self.BASE + 'part += extrude(sketch("Boss"), until="next", dir=-1)\n'
                f'part += extrude(sketch("Rib"), until=face_ref({pe._lit(FACE)}), offset=0.2)\n')
        s = pe.steps(code)
        self.assertEqual([x["reopenable"] for x in s[1:]], [True, True])
        self.assertEqual(s[1]["summary"], "Join 'Boss' up to next, into the part")
        self.assertEqual(s[2]["summary"], "Join 'Rib' up to slanted wall 0.2 mm past, out of the face")
        self.assertEqual(s[2]["faces"], [FACE])
