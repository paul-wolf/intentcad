"""Face sketches follow the face they were drawn on when the part changes
(modeling/sketch_profile.rebind): along the face's normal, onto the face found
again in the part built so far."""

import json
import math

from django.test import SimpleTestCase

from modeling.engine import run_script
from modeling.sensitivity import sensitivity


def _circle(x, y, r):
    return [{"t": "circle", "c": [x, y], "r": r}]


def _rect(x0, y0, x1, y1):
    p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    return [{"t": "line", "p": [p[i], p[(i + 1) % 4]]} for i in range(4)]


def _faces(r, kind, normal=None):
    out = [f for f in r["faces"] if f["kind"] == kind]
    if normal:
        out = [f for f in out if sum(a * b for a, b in zip(f["normal"], normal)) > 0.999]
    return out


TOP = {"origin": [0, 0, 6], "normal": [0, 0, 1], "xAxis": [1, 0, 0]}
# the 60 x 40 plate's top face as drawn on at thick=6 (box in plane u = x, v = y)
TOP_FACE = {"center": [0, 0, 6], "normal": [0, 0, 1], "area": 2400.0,
            "box": [-30, -20, 30, 20], "perimeter": 200.0, "edges": 4, "hint": "top face"}
PLATE = 'P = dict(thick={t})\npart = Pos(0, 0, P["thick"]/2) * Box(60, 40, P["thick"])\n'
HOLE = 'part -= extrude(sketch("hole"), amount=-3)\n'


class RebindTests(SimpleTestCase):
    def _hole(self, thick, face=TOP_FACE):
        prof = {"plane": TOP, "loops": [_circle(10, 0, 2.5)], "face": face}
        return run_script(PLATE.format(t=thick) + HOLE, sketches={"hole": prof})

    def _assert_hole_from(self, r, top):
        cyl = _faces(r, "cylinder")
        self.assertEqual(len(cyl), 1)
        self.assertAlmostEqual(cyl[0]["center"][2], top - 1.5, places=3)
        self.assertAlmostEqual(cyl[0]["size"][2], 3, places=3)
        bottom = [f for f in _faces(r, "plane", [0, 0, 1]) if abs(f["area"] - math.pi * 6.25) < 0.1]
        self.assertEqual(len(bottom), 1)
        self.assertAlmostEqual(bottom[0]["center"][2], top - 3, places=3)

    def test_a_hole_on_the_top_stays_on_the_top_when_the_plate_gets_thicker(self):
        r = self._hole(6)
        self.assertEqual(r["sketches"]["hole"]["status"], "same")
        self._assert_hole_from(r, 6)

        r = self._hole(10)
        self._assert_hole_from(r, 10)   # top at z=10, bottom at z=7
        rep = r["sketches"]["hole"]
        self.assertEqual(rep["status"], "moved")
        self.assertAlmostEqual(rep["moved_by"], 4, places=6)
        self.assertAlmostEqual(rep["plane"]["origin"][2], 10, places=6)
        # in-plane origin and axes kept
        self.assertEqual(rep["plane"]["origin"][:2], [0, 0])
        self.assertEqual(rep["plane"]["normal"], TOP["normal"])
        self.assertEqual(rep["plane"]["xAxis"], TOP["xAxis"])

    def test_an_old_face_record_still_rebinds(self):
        old = {"center": [0, 0, 6], "normal": [0, 0, 1], "area": 2400.0}
        r = self._hole(10, old)
        self._assert_hole_from(r, 10)
        self.assertEqual(r["sketches"]["hole"]["status"], "moved")

    def test_a_side_wall_sketch_follows_a_width_change(self):
        right = {"origin": [30, 0, 0], "normal": [1, 0, 0], "xAxis": [0, 1, 0]}   # u = y, v = z
        face = {"center": [30, 0, 3], "normal": [1, 0, 0], "area": 240.0, "box": [-20, 0, 20, 6]}
        # a 6 x 2 slot, 5 deep, between z = 2 and 4 (sketch y = -v)
        prof = {"plane": right, "loops": [_rect(-3, -4, 3, -2)], "face": face}
        code = ('P = dict(width={w})\npart = Pos(0, 0, 3) * Box(P["width"], 40, 6)\n'
                'part -= extrude(sketch("slot"), amount=-5)\n')
        r = run_script(code.format(w=80), sketches={"slot": prof})
        rep = r["sketches"]["slot"]
        self.assertEqual(rep["status"], "moved")
        self.assertAlmostEqual(rep["moved_by"], 10, places=6)
        floor = [f for f in _faces(r, "plane", [1, 0, 0]) if abs(f["area"] - 12) < 1e-3]
        self.assertEqual(len(floor), 1)
        self.assertAlmostEqual(floor[0]["center"][0], 35, places=3)
        self.assertAlmostEqual(r["metrics"]["volume"], 80 * 40 * 6 - 6 * 2 * 5, delta=0.01)

    def test_two_bosses_each_sketch_stays_with_its_own(self):
        code = ('P = dict(ha={a}, hb={b})\npart = Pos(0, 0, 3) * Box(60, 40, 6)\n'
                'part += Pos(-15, 0, 6 + P["ha"]/2) * Cylinder(5, P["ha"])\n'
                'part += Pos(15, 0, 6 + P["hb"]/2) * Cylinder(5, P["hb"])\n'
                'part -= extrude(sketch("a"), amount=-2)\npart -= extrude(sketch("b"), amount=-2)\n')
        area = math.pi * 25

        def prof(x, z):
            return {"plane": {"origin": [0, 0, z], "normal": [0, 0, 1], "xAxis": [1, 0, 0]},
                    "loops": [_circle(x, 0, 1.5)],
                    "face": {"center": [x, 0, z], "normal": [0, 0, 1], "area": area,
                             "box": [x - 5, -5, x + 5, 5]}}

        sk = {"a": prof(-15, 16), "b": prof(15, 20)}   # drawn at ha=10, hb=14
        r = run_script(code.format(a=12, b=8), sketches=sk)
        self.assertEqual(r["sketches"]["a"]["status"], "moved")
        self.assertEqual(r["sketches"]["b"]["status"], "moved")
        self.assertAlmostEqual(r["sketches"]["a"]["moved_by"], 2, places=6)
        self.assertAlmostEqual(r["sketches"]["b"]["moved_by"], -6, places=6)
        holes = {round(f["axis_point"][0]): f for f in _faces(r, "cylinder") if abs(f["radius"] - 1.5) < 1e-6}
        self.assertAlmostEqual(holes[-15]["center"][2], 18 - 1, places=3)
        self.assertAlmostEqual(holes[15]["center"][2], 14 - 1, places=3)

    def test_a_removed_face_is_not_found_and_the_stored_plane_is_used(self):
        # a 40 x 40 plate with an ear standing out past its +X side, 10 tall
        ear = {"plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xAxis": [1, 0, 0]},
               "loops": [_circle(30, 0, 2)],
               "face": {"center": [30, 0, 10], "normal": [0, 0, 1], "area": 200.0, "box": [20, -5, 40, 5]}}
        code = 'part = Pos(0, 0, 3) * Box(40, 40, 6)\n{ear}part -= extrude(sketch("pin"), amount=-2)\n'
        r = run_script(code.format(ear="part += Pos(30, 0, 5) * Box(20, 10, 10)\n"), sketches={"pin": ear})
        self.assertEqual(r["sketches"]["pin"]["status"], "same")
        r = run_script(code.format(ear=""), sketches={"pin": ear})
        rep = r["sketches"]["pin"]
        self.assertEqual(rep["status"], "not_found")
        self.assertEqual(rep["moved_by"], 0)
        self.assertEqual(rep["plane"], ear["plane"])
        self.assertFalse(r.get("warning"))

    def test_equally_good_faces_are_ambiguous_and_the_best_is_used(self):
        code = ('part = Pos(0, 0, 3) * Box(60, 40, 6)\n'
                'part += Pos(-4, 0, 9) * Box(6, 6, 6)\npart += Pos(4, 0, 9) * Box(6, 6, 6)\n'
                'part -= extrude(sketch("x"), amount=-1)\n')
        prof = {"plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xAxis": [1, 0, 0]},
                "loops": [_circle(-4, 0, 1)],
                "face": {"center": [0, 0, 10], "normal": [0, 0, 1], "area": 36.0, "box": [-3, -3, 3, 3]}}
        rep = run_script(code, sketches={"x": prof})["sketches"]["x"]
        self.assertEqual(rep["status"], "ambiguous")
        self.assertAlmostEqual(rep["moved_by"], 2, places=6)

    def test_a_case_wall_cutout_stays_on_its_wall_when_the_walls_get_taller(self):
        # the inside of the opposite wall faces the same way and, as the walls
        # grow, gets as big as the outer wall was: the outer one is still nearer
        code = ('P = dict(floor=3, wall_h={h})\n'
                'part = Pos(0, 0, P["floor"]/2) * Box(80, 50, P["floor"])\n'
                'zc = P["floor"] + P["wall_h"]/2\n'
                'part += Pos(0, 0, zc) * Box(80, 50, P["wall_h"]) - Pos(0, 0, zc) * Box(76, 46, P["wall_h"])\n'
                'part -= extrude(sketch("usb"), amount=-5)\n')
        right = {"origin": [40, 0, 0], "normal": [1, 0, 0], "xAxis": [0, 1, 0]}
        face = {"center": [40, 0, 11.5], "normal": [1, 0, 0], "area": 1150.0, "box": [-25, 0, 25, 23],
                "perimeter": 146.0, "edges": 4, "hint": "right face"}
        prof = {"plane": right, "loops": [_rect(-6, -14, 6, -8)], "face": face}   # z 8..14
        for h in (20, 30, 40):
            r = run_script(code.format(h=h), sketches={"usb": prof})
            rep = r["sketches"]["usb"]
            self.assertEqual(rep["status"], "same", h)
            self.assertEqual(rep["plane"]["origin"], [40, 0, 0])
            # cut through the right wall only: 12 x 6 x 2 out of the wall
            walls = 80 * 50 * h - 76 * 46 * h
            self.assertAlmostEqual(r["metrics"]["volume"], 80 * 50 * 3 + walls - 12 * 6 * 2, delta=0.01)

    def test_base_plane_sketches_are_untouched(self):
        front = {"origin": [0, 0, 0], "normal": [0, -1, 0], "xAxis": [1, 0, 0]}
        code = (PLATE.format(t=6)
                + 'part += extrude(sketch("rib"), amount=10, both=True)\n')
        r = run_script(code, sketches={"rib": {"plane": front, "loops": [_rect(-2, -20, 2, 0)]}})
        rep = r["sketches"]["rib"]
        self.assertEqual(rep["status"], "same")
        self.assertEqual(rep["plane"], front)
        self.assertAlmostEqual(r["metrics"]["bbox_max"][2], 20, places=3)

    def test_dragging_the_thickness_moves_the_top_hole_with_the_top(self):
        prof = {"plane": TOP, "loops": [_circle(10, 0, 2.5)], "face": TOP_FACE}
        code = PLATE.format(t=6) + HOLE
        base = run_script(code, sketches={"hole": prof})
        cyl = _faces(base, "cylinder")[0]["index"]
        m = sensitivity(code, sketches={"hole": prof})
        shift = m["thick"]["shifts"][cyl]
        self.assertAlmostEqual(shift[2], 1, places=3)   # up as fast as the top


# an off-centre plate with rounded corners and a through hole: its top face's
# outline has lines, arcs and a circle, and isn't symmetric in y
ROUNDED = ('P = dict(thick={t})\n'
           'part = Pos(5, 7, P["thick"]/2) * Box(60, 40, P["thick"])\n'
           'part = fillet(part.edges().filter_by(Axis.Z), radius=3)\n'
           'part -= Pos(10, 5, 0) * Cylinder(3, 100)\n'
           'part -= extrude(sketch("hole"), amount=-1)\n')


class OutlineTests(SimpleTestCase):
    """The rebind also returns the matched face's outline in the sketch's own
    (x, y) — y flipped, as the profile — for its reference outline to follow."""

    def _outline(self, thick):
        face = {"center": [5, 7, 6], "normal": [0, 0, 1], "area": 2364.0,
                "box": [-25, -13, 35, 27], "hint": "top face"}
        prof = {"plane": TOP, "loops": [_circle(-10, 0, 2)], "face": face}
        r = run_script(ROUNDED.format(t=thick), sketches={"hole": prof})
        b = r["sketches"]["hole"]
        self.assertEqual(b["plane"]["origin"][2], thick)
        return b["outline"]

    def test_the_outline_of_a_moved_face_is_that_face_in_sketch_coordinates(self):
        out = self._outline(9)
        kinds = sorted(e["t"] for e in out)
        self.assertEqual(kinds, ["arc"] * 4 + ["circle"] + ["line"] * 4)
        # the hole at world (10, 5): sketch y is minus world y
        circle = next(e for e in out if e["t"] == "circle")
        self.assertAlmostEqual(circle["c"][0], 10, places=4)
        self.assertAlmostEqual(circle["c"][1], -5, places=4)
        self.assertAlmostEqual(circle["r"], 3, places=4)
        # the back edge (world y = 27) is the line at sketch y = -27, between the corner arcs
        lines = [e for e in out if e["t"] == "line"]
        back = [e for e in lines if all(abs(p[1] + 27) < 1e-4 for p in e["p"])]
        self.assertEqual(len(back), 1)
        self.assertEqual(sorted(round(p[0], 4) for p in back[0]["p"]), [-22, 32])
        front = [e for e in lines if all(abs(p[1] - 13) < 1e-4 for p in e["p"])]
        self.assertEqual(len(front), 1)
        # the corner arcs: radius 3 about (5 ± 27, -(7 ± 17)), their points on them
        centres = sorted((round(e["c"][0], 4), round(e["c"][1], 4)) for e in out if e["t"] == "arc")
        self.assertEqual(centres, [(-22, -24), (-22, 10), (32, -24), (32, 10)])
        for a in (e for e in out if e["t"] == "arc"):
            self.assertAlmostEqual(a["r"], 3, places=4)
            for p in a["p"]:
                self.assertAlmostEqual(math.hypot(p[0] - a["c"][0], p[1] - a["c"][1]), 3, places=4)

    def test_the_outline_is_the_same_wherever_the_face_moves_along_its_normal(self):
        def key(out):
            return sorted(json.dumps(e, sort_keys=True) for e in out)
        self.assertEqual(key(self._outline(6)), key(self._outline(11)))

    def test_no_outline_without_a_face(self):
        prof = {"plane": TOP, "loops": [_circle(10, 0, 2.5)]}
        r = run_script(PLATE.format(t=6) + HOLE, sketches={"hole": prof})
        self.assertNotIn("outline", r["sketches"]["hole"])

    def test_no_outline_when_the_face_is_gone(self):
        far = {**TOP_FACE, "center": [500, 0, 6], "box": [470, -20, 530, 20]}
        r = run_script(PLATE.format(t=6) + HOLE, sketches={"hole": {"plane": TOP, "loops": [_circle(10, 0, 2.5)], "face": far}})
        self.assertEqual(r["sketches"]["hole"]["status"], "not_found")
        self.assertNotIn("outline", r["sketches"]["hole"])
