"""Construction planes (modeling/planes.py): PLANES["name"] = offset_plane(...)
/ edge_plane(...) / tangent_plane(...), that follow the part when parameters change, and sketches
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


# a 60 x 60 x 10 base under z = 0 and a Z-axis boss on it
BOSS = ('P = dict(r={r}, h={h}, x={x})\npart = Pos(0, 0, -5) * Box(80, 80, 10) '
        '+ Pos(P["x"], 0, P["h"] / 2) * Cylinder(P["r"], P["h"])\n')
# a 60 x 60 x 20 block (z -10 .. 10) with a Ø10 bore down the Z axis
BORE = 'P = dict(cut_d=3)\npart = Box(60, 60, 20) - Cylinder(5, 20)\n'
# a Ø30 knob hub with a Ø6 D-shaft bore, the flat 2.5 mm from the axis on +X
KNOB = ('P = dict(hub_r={r})\npart = Pos(0, 0, 10) * (Cylinder(P["hub_r"], 20) '
        '- (Cylinder(3, 20) - Pos(7.5, 0, 0) * Box(10, 10, 20)))\n')


def _cyl(r, radius=None):
    return next(f["ref"] for f in r["faces"] if f["kind"] == "cylinder"
                and (radius is None or abs(f["radius"] - radius) < 1e-6))


def _boss(r=10, h=20, x=0):
    return BOSS.format(r=r, h=h, x=x)


class TangentPlaneTests(SimpleTestCase):
    def setUp(self):
        self.boss = _cyl(run_script(_boss()))

    def _plane(self, angle, ref='"X"', code=None, face=None):
        r = f", ref={ref}" if ref else ""
        line = f'PLANES["T"] = tangent_plane(face_ref({face or self.boss}), angle={angle}{r})\n'
        return run_script((code or _boss()) + line)["planes"]["T"]

    def test_on_a_boss_angle_zero_from_x_faces_x_at_the_radius(self):
        pl = self._plane(0)
        self.assertEqual((pl["kind"], pl["status"]), ("tangent", "same"))
        _close(self, pl["normal"], [1, 0, 0])
        _close(self, pl["origin"], [10, 0, 0])          # on the tangent line, at the boss's foot
        _close(self, pl["xAxis"], [0, 0, 1])            # sketch x along the axis
        _close(self, pl["cylinder"]["axis"], [0, 0, 1])
        self.assertAlmostEqual(pl["cylinder"]["length"], 20, places=6)
        self.assertFalse(pl["cylinder"]["inward"])

    def test_ninety_degrees_turns_right_handed_about_the_axis(self):
        pl = self._plane(90)
        _close(self, pl["normal"], [0, 1, 0])
        _close(self, pl["origin"], [0, 10, 0])
        s = math.sqrt(0.5)
        _close(self, self._plane(-45)["normal"], [s, -s, 0])

    def test_the_axis_is_the_one_the_reference_stores(self):
        # the same face named with its axis the other way: 90° turns the other way
        down = {**self.boss, "normal": [0, 0, -1]}
        pl = self._plane(90, face=down)
        _close(self, pl["normal"], [0, -1, 0])
        _close(self, pl["xAxis"], [0, 0, -1])
        self.assertAlmostEqual(pl["origin"][2], 20, places=6)    # x runs from the top end down

    def test_the_default_reference_is_the_base_axis_most_square_to_the_axis(self):
        _close(self, self._plane(0, ref=None)["normal"], [1, 0, 0])
        _close(self, self._plane(0, ref='"Y"')["normal"], [0, 1, 0])
        side = run_script('part = Rotation(0, 90, 0) * Cylinder(10, 20)\n')    # its axis along X
        face = _cyl(side)
        pl = self._plane(0, ref=None, code='part = Rotation(0, 90, 0) * Cylinder(10, 20)\n', face=face)
        _close(self, pl["normal"], [0, 1, 0])           # X runs along it: Y is 0°

    def test_on_a_bore_it_faces_the_axis_and_a_cut_goes_into_the_material(self):
        from modeling.paramedit import add_extrude
        r = run_script(BORE)
        face = _cyl(r)
        line = f'PLANES["Bore"] = tangent_plane(face_ref({face}), angle=0, ref="X")\n'
        pl = run_script(BORE + line)["planes"]["Bore"]
        _close(self, pl["normal"], [-1, 0, 0])
        _close(self, pl["origin"], [5, 0, -10])
        self.assertTrue(pl["cylinder"]["inward"])
        # a 2 x 2 square 10 mm up the bore, cut 3 mm the way the Extrude dialog writes it
        prof = {"plane": {k: pl[k] for k in ("origin", "normal", "xAxis")},
                "loops": [_rect(9, -1, 11, 1)], "planeRef": "Bore"}
        code, _ = add_extrude(BORE + line, "hole", "cut", 3)
        out = run_script(code, sketches={"hole": prof})
        self.assertAlmostEqual(r["metrics"]["volume"] - out["metrics"]["volume"], 12, places=2)
        lo, hi = out["metrics"]["bbox_min"], out["metrics"]["bbox_max"]
        self.assertEqual((lo, hi), (r["metrics"]["bbox_min"], r["metrics"]["bbox_max"]))

    def test_it_follows_the_boss(self):
        line = f'PLANES["T"] = tangent_plane(face_ref({self.boss}), angle=90, ref="X")\n'
        pl = run_script(_boss(r=15) + line)["planes"]["T"]        # wider
        _close(self, pl["origin"], [0, 15, 0])
        _close(self, pl["normal"], [0, 1, 0])
        pl = run_script(_boss(x=20) + line)["planes"]["T"]        # moved
        _close(self, pl["origin"], [20, 10, 0])
        pl = run_script(_boss(h=35) + line)["planes"]["T"]        # taller
        _close(self, pl["origin"], [0, 10, 0])
        self.assertAlmostEqual(pl["cylinder"]["length"], 35, places=6)
        self.assertEqual(run_script(_boss() + line)["planes"]["T"]["status"], "same")

    def test_a_flat_reference_sets_zero_toward_it(self):
        r = run_script(KNOB.format(r=15))
        hub = _cyl(r, 15)
        flat = next(f["ref"] for f in r["faces"] if f["kind"] == "plane" and abs(f["normal"][0] + 1) < 1e-6)
        line = f'PLANES["Screw"] = tangent_plane(face_ref({hub}), angle=0, ref=face_ref({flat}))\n'
        for hub_r in (15, 20):
            pl = run_script(KNOB.format(r=hub_r) + line)["planes"]["Screw"]
            _close(self, pl["normal"], [1, 0, 0])       # the flat faces -X, into the bore; 0° is its side
            _close(self, pl["origin"], [hub_r, 0, 0])
            _close(self, pl["cylinder"]["zero"], [1, 0, 0])
        # on the D-bore's own wall too: 0° is the flat's side
        bore = _cyl(r, 3)
        pl = run_script(KNOB.format(r=15) + f'PLANES["B"] = tangent_plane(face_ref({bore}), angle=180, '
                        f'ref=face_ref({flat}))\n')["planes"]["B"]
        _close(self, pl["normal"], [1, 0, 0])           # at 180° the wall faces back toward the axis
        _close(self, pl["origin"], [-3, 0, 0])

    def test_a_reference_along_the_axis_is_a_clear_error(self):
        self.assertIn("the reference Z runs along the cylinder's axis", _warn(
            _boss() + f'PLANES["T"] = tangent_plane(face_ref({self.boss}), angle=0, ref="Z")\n'))
        top = _face(run_script(_boss()), [0, 0, 1])
        self.assertIn("the reference face is square to the cylinder's axis", _warn(
            _boss() + f'PLANES["T"] = tangent_plane(face_ref({self.boss}), angle=0, ref=face_ref({top}))\n'))
        self.assertIn('ref must be "X", "Y", "Z" or a flat face', _warn(
            _boss() + f'PLANES["T"] = tangent_plane(face_ref({self.boss}), angle=0, ref="W")\n'))

    def test_a_face_that_isnt_a_cylinder_is_a_clear_error(self):
        top = _face(run_script(_boss()), [0, 0, 1])
        self.assertIn("tangent_plane needs a cylindrical face; this face is flat",
                      _warn(_boss() + f'PLANES["T"] = tangent_plane(face_ref({top}), angle=0)\n'))

    def test_a_sketch_on_it_follows_the_hub(self):
        # a 2 x 2 square 5 mm up the boss, cut 4 mm in: the cut stays radial as the boss widens
        line = f'PLANES["T"] = tangent_plane(face_ref({self.boss}), angle=0, ref="X")\n'
        pl = run_script(_boss() + line)["planes"]["T"]
        prof = {"plane": {k: pl[k] for k in ("origin", "normal", "xAxis")},
                "loops": [_rect(4, -1, 6, 1)], "planeRef": "T"}
        code = _boss() + line + 'part -= extrude(sketch("s"), amount=-4)\n'
        for r in (10, 14):
            out = run_script(code.replace("r=10", f"r={r}"), sketches={"s": prof})
            cut = [f for f in out["faces"] if f["kind"] == "plane" and abs(f["normal"][0] - 1) < 1e-6
                   and abs(f["area"] - 4) < 0.01]
            self.assertEqual(len(cut), 1)
            self.assertAlmostEqual(cut[0]["center"][0], r - 4, places=4)    # its floor, 4 mm in
            self.assertAlmostEqual(cut[0]["center"][2], 5, places=4)


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
