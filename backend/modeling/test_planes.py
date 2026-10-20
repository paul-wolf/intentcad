"""Construction planes (modeling/planes.py): PLANES["name"] = offset_plane(...)
/ edge_plane(...), that follow the part when parameters change, and sketches
on them (sketch_profile planeRef)."""

import math

from django.test import SimpleTestCase

from modeling.engine import EngineError, run_script

BOX = 'P = dict(h={h}, w={w}, d={d})\npart = Pos(0, 0, P["h"] / 2) * Box(P["w"], P["d"], P["h"])\n'


def _face(r, normal):
    return next(f["ref"] for f in r["faces"] if f["ref"]
                and sum(a * b for a, b in zip(f["normal"], normal)) > 0.999)


def _edge(r, hint):
    return next(e["ref"] for e in r["edges"] if e["ref"] and e["ref"]["hint"] == hint)


def _box(h=20, w=60, d=40):
    return BOX.format(h=h, w=w, d=d)


def _close(tc, a, b, places=6):
    for x, y in zip(a, b):
        tc.assertAlmostEqual(x, y, places=places)


def _warn(code, **kw):
    """The build's error, for a script whose part was built before it failed."""
    return run_script(code, **kw).get("warning") or ""


def _rect(x0, y0, x1, y1):
    p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    return [{"t": "line", "p": [p[i], p[(i + 1) % 4]]} for i in range(4)]


class OffsetPlaneTests(SimpleTestCase):
    def setUp(self):
        r = run_script(_box())
        self.top = _face(r, [0, 0, 1])
        self.right = _face(r, [1, 0, 0])

    def test_offset_from_the_top_face_follows_a_height_change(self):
        line = f'PLANES["Lid"] = offset_plane(face_ref({self.top}), distance=5)\n'
        for h in (20, 30):
            pl = run_script(_box(h=h) + line)["planes"]["Lid"]
            _close(self, pl["origin"], [0, 0, h + 5])
            _close(self, pl["normal"], [0, 0, 1])
            _close(self, pl["xAxis"], [1, 0, 0])      # a top-face sketch's x axis
            self.assertEqual(pl["kind"], "offset")
            self.assertEqual(pl["line"], 3)
        self.assertEqual(run_script(_box(h=20) + line)["planes"]["Lid"]["status"], "same")
        self.assertEqual(run_script(_box(h=30) + line)["planes"]["Lid"]["status"], "moved")

    def test_a_negative_distance_goes_into_the_part(self):
        pl = run_script(_box() + f'PLANES["In"] = offset_plane(face_ref({self.top}), distance=-4)\n')["planes"]["In"]
        _close(self, pl["origin"], [0, 0, 16])

    def test_a_midplane_stays_in_the_middle_when_the_width_changes(self):
        line = f'PLANES["Mid"] = offset_plane(face_ref({self.right}), distance=-P["w"] / 2)\n'
        for w in (60, 80):
            pl = run_script(_box(w=w) + line)["planes"]["Mid"]
            _close(self, pl["origin"], [0, 0, 0])
            _close(self, pl["normal"], [1, 0, 0])
            _close(self, pl["xAxis"], [0, 1, 0])      # a right-face sketch's x axis

    def test_base_plane_offsets(self):
        r = run_script(_box() + 'PLANES["A"] = offset_plane("XY", distance=30)\n'
                       'PLANES["B"] = offset_plane("XZ", distance=10)\n'
                       'PLANES["C"] = offset_plane("YZ", distance=-5)\n')
        a, b, c = (r["planes"][k] for k in "ABC")
        _close(self, a["origin"], [0, 0, 30]); _close(self, a["normal"], [0, 0, 1]); _close(self, a["xAxis"], [1, 0, 0])
        _close(self, b["origin"], [0, -10, 0]); _close(self, b["normal"], [0, -1, 0]); _close(self, b["xAxis"], [1, 0, 0])
        _close(self, c["origin"], [-5, 0, 0]); _close(self, c["normal"], [1, 0, 0]); _close(self, c["xAxis"], [0, 1, 0])
        for k in "ABC":
            self.assertEqual(r["planes"][k]["status"], "same")

    def test_planes_are_build123d_planes_the_script_can_use(self):
        r = run_script(_box() + 'PLANES["Top 30"] = offset_plane("XY", distance=30)\n'
                       'part += PLANES["Top 30"] * Cylinder(2, 4)\nP["n"] = PLANES["Top 30"].z_dir.Z\n')
        self.assertEqual(r["params"]["n"], 1)
        self.assertAlmostEqual(r["metrics"]["bbox_max"][2], 32, places=4)

    def test_a_bad_base_is_a_clear_error(self):
        self.assertIn("base must be a face or one of XY, XZ, YZ",
                      _warn(_box() + 'PLANES["X"] = offset_plane("XX", distance=1)\n'))

    def test_using_a_plane_that_isnt_defined_names_it(self):
        w = _warn(_box() + 'part += PLANES["Lid"] * Box(1, 1, 1)\n')
        self.assertIn("line 3:", w)
        self.assertIn("no construction plane named 'Lid'", w)
        with self.assertRaisesRegex(EngineError, "no construction plane named 'Lid'"):
            run_script('part = PLANES["Lid"] * Box(1, 1, 1)\n')


class EdgePlaneTests(SimpleTestCase):
    def setUp(self):
        r = run_script(_box())
        self.edge = _edge(r, "top-front edge")
        self.top = _face(r, [0, 0, 1])
        self.front = _face(r, [0, -1, 0])

    def _plane(self, angle, face=None, code=None):
        f = f", from_face=face_ref({face})" if face else ""
        line = f'PLANES["E"] = edge_plane(edge_ref({self.edge}), angle={angle}{f})\n'
        return run_script((code or _box()) + line)["planes"]["E"]

    def test_at_angle_zero_it_lies_in_from_face(self):
        pl = self._plane(0, self.top)
        _close(self, pl["normal"], [0, 0, 1])
        self.assertAlmostEqual(pl["origin"][2], 20, places=6)   # on the edge's line (y = -20, z = 20)
        self.assertAlmostEqual(pl["origin"][1], -20, places=6)
        self.assertAlmostEqual(abs(pl["xAxis"][0]), 1, places=6)   # along the edge
        pl = self._plane(0, self.front)
        _close(self, pl["normal"], [0, -1, 0])

    def test_the_y_axis_points_across_the_face(self):
        pl = self._plane(0, self.top)
        n, x = pl["normal"], pl["xAxis"]
        y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]]
        _close(self, y, [0, 1, 0])      # from the front edge back over the top face

    def test_without_from_face_the_first_face_is_zero(self):
        first = self.edge["faces"][0]["normal"]
        pl = self._plane(0)
        _close(self, pl["normal"], first)

    def test_a_positive_angle_rotates_away_from_the_material(self):
        pl = self._plane(30, self.top)
        s, c = math.sin(math.radians(30)), math.cos(math.radians(30))
        # the half over the top face lifts: y axis = (0, cos, sin); normal tilts toward the front
        _close(self, pl["normal"], [0, -s, c])
        # a point on the plane 10 mm across from the edge is above the part
        code = (_box() + f'PLANES["E"] = edge_plane(edge_ref({self.edge}), angle=30, from_face=face_ref({self.top}))\n'
                'q = PLANES["E"].from_local_coords((0, 10))\nP["z"] = q.Z\nP["inside"] = int(part.is_inside(q))\n')
        p = run_script(code)["params"]
        self.assertAlmostEqual(p["z"], 20 + 10 * s, places=6)
        self.assertEqual(p["inside"], 0)
        neg = self._plane(-30, self.top)
        _close(self, neg["normal"], [0, s, c])

    def test_the_plane_follows_the_edge_when_the_part_changes(self):
        pl = run_script(_box(h=30, d=50) + f'PLANES["E"] = edge_plane(edge_ref({self.edge}), angle=30, '
                        f'from_face=face_ref({self.top}))\n')["planes"]["E"]
        self.assertAlmostEqual(pl["origin"][2], 30, places=6)
        self.assertAlmostEqual(pl["origin"][1], -25, places=6)
        self.assertEqual(pl["status"], "moved")
        self.assertEqual(self._plane(30, self.top)["status"], "same")

    def test_a_curved_edge_is_a_clear_error(self):
        code = 'part = Cylinder(10, 20)\n'
        rim = next(e["ref"] for e in run_script(code)["edges"] if e["ref"] and e["ref"].get("kind") == "circle")
        self.assertIn("edge_plane needs a straight edge; this edge is curved (circle)",
                      _warn(code + f'PLANES["E"] = edge_plane(edge_ref({rim}), angle=0)\n'))

    def test_a_face_not_on_the_edge_is_refused(self):
        back = _face(run_script(_box()), [0, 1, 0])
        self.assertIn("from_face isn't one of the edge's two faces",
                      _warn(_box() + f'PLANES["E"] = edge_plane(edge_ref({self.edge}), angle=0, '
                            f'from_face=face_ref({back}))\n'))


class SketchOnPlaneTests(SimpleTestCase):
    """A sketch whose profile has planeRef takes its plane from PLANES."""

    def setUp(self):
        r = run_script(_box())
        self.top = _face(r, [0, 0, 1])
        self.right = _face(r, [1, 0, 0])

    def test_a_boss_on_a_plane_above_the_top_follows_the_height(self):
        # drawn when the plane was at z = 25; a 10 x 10 square joined down to the part
        prof = {"plane": {"origin": [0, 0, 25], "normal": [0, 0, 1], "xAxis": [1, 0, 0]},
                "loops": [_rect(-5, -5, 5, 5)], "planeRef": "Lid"}
        line = (f'PLANES["Lid"] = offset_plane(face_ref({self.top}), distance=5)\n'
                'part += extrude(sketch("boss"), amount=-5)\n')
        for h in (20, 30):
            r = run_script(_box(h=h) + line, sketches={"boss": prof})
            self.assertAlmostEqual(r["metrics"]["bbox_max"][2], h + 5, places=4)
            self.assertAlmostEqual(r["metrics"]["volume"], 60 * 40 * h + 500, places=2)
            self.assertEqual(r["sketches"]["boss"]["planeRef"], "Lid")
        self.assertEqual(r["sketches"]["boss"]["status"], "moved")
        self.assertAlmostEqual(r["sketches"]["boss"]["plane"]["origin"][2], 35, places=6)

    def test_a_slot_on_a_midplane_stays_centred(self):
        # 4 wide (along y), 6 tall around z = 10, cut both ways 3 mm
        prof = {"plane": {"origin": [0, 0, 0], "normal": [1, 0, 0], "xAxis": [0, 1, 0]},
                "loops": [_rect(-2, -13, 2, -7)], "planeRef": "Mid"}
        line = (f'PLANES["Mid"] = offset_plane(face_ref({self.right}), distance=-P["w"] / 2)\n'
                'part -= extrude(sketch("slot"), amount=3, both=True)\n')
        for w in (60, 90):
            r = run_script(_box(w=w) + line, sketches={"slot": prof})
            self.assertAlmostEqual(r["metrics"]["volume"], w * 40 * 20 - 6 * 4 * 6, places=2)
            cut = [f for f in r["faces"] if f["kind"] == "plane" and abs(f["area"] - 36) < 0.01
                   and abs(abs(f["normal"][1]) - 1) < 1e-6]
            self.assertTrue(cut)
            for f in cut:
                self.assertAlmostEqual(f["center"][0], 0, places=6)

    def test_a_missing_plane_is_a_clear_error_naming_it(self):
        prof = {"plane": {"origin": [0, 0, 25], "normal": [0, 0, 1], "xAxis": [1, 0, 0]},
                "loops": [_rect(-5, -5, 5, 5)], "planeRef": "Lid"}
        self.assertIn("sketch 'boss' is on the construction plane 'Lid', which isn't defined",
                      _warn(_box() + 'part += extrude(sketch("boss"), amount=-5)\n', sketches={"boss": prof}))
