"""Mirror (modeling/mirror.py, paramedit's mirror section): mirror_body() of
the whole part, mirrored() copies of steps that land on the other side of a
plane and follow their sketch and P, and the link comment that keeps a copy
in step with its original."""

import math

from django.test import SimpleTestCase

from modeling import paramedit as pe
from modeling.engine import run_script

# a box from x = 0 to w, so the middle plane (x = w/2) moves with w
BOX = ('P = dict(h={h}, w={w}, d=40, depth={depth}, r=3)\n'
       'part = Pos(P["w"] / 2, 0, P["h"] / 2) * Box(P["w"], P["d"], P["h"])\n')


def _box(h=20, w=60, depth=4):
    return BOX.format(h=h, w=w, depth=depth)


def _face(r, normal):
    return next(f["ref"] for f in r["faces"] if f["ref"]
                and sum(a * b for a, b in zip(f["normal"], normal)) > 0.999)


def _rect(x0, y0, x1, y1):
    p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    return [{"t": "line", "p": [p[i], p[(i + 1) % 4]]} for i in range(4)]


def _top(loops=(), points=(), h=20):
    return {"plane": {"origin": [0, 0, h], "normal": [0, 0, 1], "xAxis": [1, 0, 0]},
            "loops": list(loops), "points": [list(p) for p in points]}


def _circles(r):
    """(x, y, radius) of every circular edge."""
    return {(round(e["ref"]["center"][0], 2), round(e["ref"]["center"][1], 2), round(e["ref"]["radius"], 2))
            for e in r["edges"] if e["ref"] and e["ref"].get("kind") == "circle"}


def _floors(r, z):
    """The x of the centre of each upward face at height z (a pocket's floor)."""
    return sorted(round(f["center"][0], 3) for f in r["faces"]
                  if f["kind"] == "plane" and f["normal"][2] > 0.999 and abs(f["center"][2] - z) < 1e-6)


def _mid():
    right = _face(run_script(_box()), [1, 0, 0])
    return f'PLANES["Mid"] = offset_plane(face_ref({right}), distance=-P["w"] / 2)\n'


class MirrorBodyTests(SimpleTestCase):
    def setUp(self):
        self.half = 'part = Pos(15, 0, 10) * Box(30, 40, 20)\n'        # x from 0 to 30
        self.cut = _face(run_script(self.half), [-1, 0, 0])            # the face on x = 0

    def test_a_half_mirrored_on_its_cut_face_fuses_into_one_solid(self):
        r = run_script(self.half + f'part = mirror_body(part, face_ref({self.cut}), join=True)\n')
        self.assertFalse(r.get("warning"))
        self.assertAlmostEqual(r["metrics"]["volume"], 60 * 40 * 20, places=3)
        self.assertEqual(r["metrics"]["solids"], 1)
        self.assertEqual(len(r["faces"]), 6)             # one clean box, no seam
        self.assertAlmostEqual(r["metrics"]["bbox_min"][0], -30, places=6)

    def test_a_base_plane_works_the_same(self):
        r = run_script(self.half + 'part = mirror_body(part, "YZ")\n')
        self.assertAlmostEqual(r["metrics"]["volume"], 48000, places=3)
        self.assertEqual(r["metrics"]["solids"], 1)

    def test_separate_keeps_two_bodies(self):
        r = run_script('part = Pos(25, 0, 10) * Box(30, 40, 20)\n'
                       'part = mirror_body(part, "YZ", join=False)\n')
        self.assertEqual(r["metrics"]["solids"], 2)
        self.assertAlmostEqual(r["metrics"]["volume"], 2 * 30 * 40 * 20, places=3)
        self.assertAlmostEqual(r["metrics"]["bbox_min"][0], -40, places=6)

    def test_across_a_construction_plane_that_moves_with_a_param(self):
        right = _face(run_script(_box()), [1, 0, 0])
        line = (f'PLANES["Side"] = offset_plane(face_ref({right}), distance=5)\n'
                'part = mirror_body(part, PLANES["Side"], join=False)\n')
        for w in (60, 80):          # the copy sits from w + 10 to 2w + 10
            r = run_script(_box(w=w) + line)
            self.assertEqual(r["metrics"]["solids"], 2)
            self.assertAlmostEqual(r["metrics"]["bbox_max"][0], 2 * w + 10, places=4)
            self.assertAlmostEqual(r["metrics"]["volume"], 2 * w * 40 * 20, places=2)

    def test_a_gap_moves_the_copy_exactly_gap_away(self):
        # the half touches the plane at x = 0: its copy ends at x = -gap
        for gap in (0, 10, 4.5):
            r = run_script(self.half + f'part = mirror_body(part, face_ref({self.cut}), join=False, gap={gap})\n')
            self.assertFalse(r.get("warning"))
            self.assertEqual(r["metrics"]["solids"], 2)
            self.assertAlmostEqual(r["metrics"]["bbox_min"][0], -30 - gap, places=6)
            self.assertAlmostEqual(r["metrics"]["volume"], 2 * 30 * 40 * 20, places=3)
        # a plane whose normal points into the part (YZ's +x): still outward
        r = run_script(self.half + 'PLANES["In"] = offset_plane("YZ", distance=0)\n'
                       'part = mirror_body(part, PLANES["In"], join=False, gap=10)\n')
        self.assertAlmostEqual(r["metrics"]["bbox_min"][0], -40, places=6)
        r = run_script('part = Pos(-15, 0, 10) * Box(30, 40, 20)\n'      # on the other side of YZ
                       'part = mirror_body(part, "YZ", join=False, gap=10)\n')
        self.assertAlmostEqual(r["metrics"]["bbox_max"][0], 40, places=6)

    def test_gap_0_is_the_old_mirror(self):
        old = run_script('part = Pos(25, 0, 10) * Box(30, 40, 20)\npart = mirror_body(part, "YZ", join=False)\n')
        new = run_script('part = Pos(25, 0, 10) * Box(30, 40, 20)\npart = mirror_body(part, "YZ", join=False, gap=0)\n')
        self.assertEqual(old["metrics"], new["metrics"])

    def test_a_gap_from_a_param_follows_it(self):
        for g in (6, 12):
            r = run_script(f'P = dict(g={g})\n' + self.half
                           + f'part = mirror_body(part, face_ref({self.cut}), join=False, gap=P["g"])\n')
            self.assertAlmostEqual(r["metrics"]["bbox_min"][0], -30 - g, places=6)

    def test_the_preview_copy_is_the_mirror_image_alone(self):
        r = run_script(self.half + f'part = _mirror_copy(part, face_ref({self.cut}), join=False, gap=10)\n')
        self.assertEqual(r["metrics"]["solids"], 1)
        self.assertAlmostEqual(r["metrics"]["bbox_min"][0], -40, places=6)
        self.assertAlmostEqual(r["metrics"]["bbox_max"][0], -10, places=6)

    def test_a_missing_face_is_reported_on_its_line(self):
        gone = {**self.cut, "center": [-50, 0, 10], "normal": [0, 1, 0]}
        r = run_script(self.half + f'part = mirror_body(part, face_ref({gone}))\n')
        self.assertTrue(r.get("warning") or any(f["status"] != "same" and f["line"] == 2
                                                 for f in r.get("face_refs") or []))


class MirroredStepTests(SimpleTestCase):
    def test_an_extrude_cut_lands_on_the_other_side_and_follows(self):
        cut = 'part -= extrude(sketch("USB"), amount=-P["depth"])\n'
        copy = 'part -= mirrored(extrude(sketch("USB"), amount=-P["depth"]), PLANES["Mid"])\n'
        usb = _top([_rect(5, -5, 15, 5)])
        for w, depth in ((60, 4), (80, 4), (80, 7)):
            r = run_script(_box(w=w, depth=depth) + _mid() + cut + copy, sketches={"USB": usb})
            self.assertFalse(r.get("warning"))
            self.assertEqual(_floors(r, 20 - depth), [10, w - 10])
            self.assertAlmostEqual(r["metrics"]["volume"], w * 40 * 20 - 2 * 100 * depth, places=2)
        # the sketch moved: so does its copy
        r = run_script(_box() + _mid() + cut + copy, sketches={"USB": _top([_rect(20, -5, 25, 5)])})
        self.assertEqual(_floors(r, 16), [22.5, 37.5])

    def test_holes_with_standoffs_land_on_the_other_side(self):
        args = 'kind="clearance", size="M3", standoff=dict(h=5, d=7))\n'
        code = (_box() + _mid() + 'part = holes(part, at=sketch_points("Posts"), ' + args
                + 'part = holes(part, at=mirrored(sketch_points("Posts"), PLANES["Mid"]), ' + args)
        posts = _top(points=[(10, -10), (10, 10)])
        r = run_script(code, sketches={"Posts": posts})
        self.assertFalse(r.get("warning"))
        xs = sorted({(x, y) for x, y, rad in _circles(r) if rad == 3.5})      # the standoffs' rims
        self.assertEqual(xs, [(10, -10), (10, 10), (50, -10), (50, 10)])
        self.assertAlmostEqual(r["metrics"]["bbox_max"][2], 25, places=6)  # standoffs on top, both sides
        r = run_script(code.replace("w=60", "w=100"), sketches={"Posts": _top(points=[(12, 0)])})
        self.assertEqual(sorted({(x, y) for x, y, rad in _circles(r) if rad == 3.5}), [(12, 0), (88, 0)])

    def test_a_fillets_edges_are_mirrored_and_follow(self):
        top_right = 'part = fillet(part, edges_ref([{edge}]), radius=P["r"])\n'
        r0 = run_script(_box())
        edge = next(e["ref"] for e in r0["edges"] if e["ref"] and e["ref"]["hint"] == "top-right edge")
        line = top_right.format(edge=edge)
        copy = f'part = fillet(part, mirrored(edges_ref([{edge}]), PLANES["Mid"]), radius=P["r"])\n'
        for w, rad in ((60, 3), (80, 3), (80, 5)):
            code = _box(w=w) + _mid() + line + copy
            r = run_script(code.replace("r=3", f"r={rad}"))
            self.assertFalse(r.get("warning"))
            corner = (rad * rad - math.pi * rad * rad / 4) * 40
            self.assertAlmostEqual(r["metrics"]["volume"], w * 40 * 20 - 2 * corner, places=1)
            mine = [e for e in r["edge_refs"] if e["line"] == 5]
            self.assertTrue(mine and all(e["status"] == "found" for e in mine), mine)
            self.assertEqual(mine[0]["hint"], "top-left edge")
            self.assertAlmostEqual(mine[0]["midpoint"][0], 0, places=6)

    def test_a_mirrored_face_ref_is_found_on_the_other_side(self):
        right = _face(run_script(_box()), [1, 0, 0])
        r = run_script(_box() + _mid()
                       + f'part = shell(part, remove=mirrored(face_ref({right}), PLANES["Mid"]), thickness=2)\n')
        self.assertFalse(r.get("warning"))
        self.assertAlmostEqual(r["metrics"]["bbox_min"][0], 0, places=6)
        left_open = [f for f in r["face_refs"] if f["line"] == 4]
        self.assertEqual([(f["hint"], f["status"]) for f in left_open], [("mirrored left face", "found")])


CODE = '''from build123d import *
P = dict(w=60.0, d=40.0, h=20.0, depth=5.0, r=2.0)
part = Pos(P["w"] / 2, 0, P["h"] / 2) * Box(P["w"], P["d"], P["h"])
PLANES["Mid"] = offset_plane("YZ", distance=P["w"] / 2)
part -= extrude(sketch("USB"), amount=-P["depth"])
part = holes(part, at=sketch_points("Posts"), kind="insert", size="M3", standoff=dict(h=5, d=7))
part = fillet(part, edges_ref([{"kind": "line", "midpoint": [60, 0, 20], "hint": "top-right edge"}]), radius=P["r"])
part = shell(part, thickness=2.0)
'''


def _rows(code):
    return code.split("\n")


class MirrorStepsTests(SimpleTestCase):
    def test_each_step_gets_one_linked_copy_after_the_last(self):
        code, made, skipped = pe.mirror_steps(CODE, [5, 6, 7, 8], {"plane": "Mid"})
        rows = _rows(code)
        self.assertEqual(made, [{"of": 5, "line": 8}, {"of": 6, "line": 9}, {"of": 7, "line": 10}])
        self.assertEqual(skipped, [{"line": 8, "reason": "Shell can't be mirrored"}])
        self.assertEqual(rows[7], 'part -= mirrored(extrude(sketch("USB"), amount=-P["depth"]), PLANES["Mid"])'
                                  '  # mirror of line 5 across Mid')
        self.assertEqual(rows[8], 'part = holes(part, at=mirrored(sketch_points("Posts"), PLANES["Mid"]), '
                                  'kind="insert", size="M3", standoff=dict(h=5, d=7))  # mirror of line 6 across Mid')
        self.assertTrue(rows[9].startswith('part = fillet(part, mirrored(edges_ref([{'))
        self.assertTrue(rows[9].endswith('PLANES["Mid"]), radius=P["r"])  # mirror of line 7 across Mid'))
        self.assertEqual(rows[10], "part = shell(part, thickness=2.0)")

    def test_base_planes_and_faces(self):
        code, made, _ = pe.mirror_steps(CODE, [5], "XZ")
        self.assertIn('mirrored(extrude(sketch("USB"), amount=-P["depth"]), "XZ")  # mirror of line 5 across XZ',
                      code)
        face = {"center": [0, 0, 10], "normal": [-1, 0, 0], "hint": "left face"}
        code, _, _ = pe.mirror_steps(CODE, [5], {"face": face})
        self.assertIn(f"face_ref({pe._lit(face)}))  # mirror of line 5 across left face", code)

    def test_copies_go_after_the_planes_line(self):
        code = CODE.replace('PLANES["Mid"] = offset_plane("YZ", distance=P["w"] / 2)\n', "") \
            + 'PLANES["Late"] = offset_plane("YZ", distance=1)\n'
        code, made, _ = pe.mirror_steps(code, [4], {"plane": "Late"})
        self.assertEqual(made, [{"of": 4, "line": 9}])

    def test_what_cant_be_mirrored_is_listed(self):
        code, made, _ = pe.mirror_steps(CODE, [5], {"plane": "Mid"})
        self.assertEqual(made, [{"of": 5, "line": 6}])      # right after it
        off = pe.suppress(code, 7, True)
        _, made, skipped = pe.mirror_steps(off, [6, 7, 9], {"plane": "Mid"})
        self.assertEqual(made, [])
        self.assertEqual([s["line"] for s in skipped], [6, 7, 9])
        self.assertIn("mirrored copy already", skipped[0]["reason"])
        self.assertEqual(skipped[1]["reason"], "it is switched off")
        self.assertEqual(skipped[2]["reason"], "Shell can't be mirrored")
        with self.assertRaisesRegex(pe.ParamError, "no plane named 'Nope'"):
            pe.mirror_steps(CODE, [5], {"plane": "Nope"})

    def test_the_copies_run(self):
        code, _, _ = pe.mirror_steps(CODE, [5, 6], {"plane": "Mid"})
        rows = [r for r in _rows(code) if not r.startswith(("from ", "part = fillet", "part = shell"))]
        r = run_script("\n".join(rows),
                       sketches={"USB": _top([_rect(5, -5, 15, 5)]), "Posts": _top(points=[(10, 10)])})
        self.assertFalse(r.get("warning"))
        self.assertEqual(_floors(r, 15)[-1:], [50])


class LinkTests(SimpleTestCase):
    def setUp(self):
        self.code, _, _ = pe.mirror_steps(CODE, [5, 6, 7], {"plane": "Mid"})

    def test_editing_the_original_rewrites_its_copy(self):
        code = pe.add_extrude(self.code, "USB", "cut", through=True, line=5)
        code = code if isinstance(code, str) else code[0]
        rows = _rows(code)
        self.assertEqual(rows[4], 'part -= extrude(sketch("USB"), amount=-part.bounding_box().diagonal)')
        self.assertEqual(rows[7], 'part -= mirrored(extrude(sketch("USB"), amount=-part.bounding_box().diagonal),'
                                  ' PLANES["Mid"])  # mirror of line 5 across Mid')
        self.assertNotIn('"depth"', code)            # no line uses it any more
        code, _ = pe.add_holes(code, {"sketch": "Posts"}, kind="clearance", size="M2.5", line=6)
        self.assertIn('part = holes(part, at=mirrored(sketch_points("Posts"), PLANES["Mid"]), kind="clearance", '
                      'size="M2.5"', _rows(code)[8])
        new_edge = {"kind": "line", "midpoint": [60, 0, 0], "hint": "bottom-right edge"}
        code, _ = pe.add_edge_op(code, "fillet", [new_edge], 4.0, line=7)
        self.assertIn(f"mirrored(edges_ref([{pe._lit(new_edge)}]), PLANES[\"Mid\"])", _rows(code)[9])
        self.assertTrue(_rows(code)[9].endswith("# mirror of line 7 across Mid"))

    def test_a_copy_reads_back_as_mirrored(self):
        got = pe.op_at(self.code, 9)
        self.assertEqual(got["op"], "holes")
        self.assertEqual(got["args"]["at"], {"sketch": "Posts"})
        self.assertEqual(got["mirror"], {"plane": {"plane": "Mid"}, "label": "Mid", "of": 6})
        self.assertEqual(pe.op_at(self.code, 8)["args"]["depth"], 5.0)
        self.assertEqual(len(pe.op_at(self.code, 10)["args"]["edges"]), 1)
        self.assertNotIn("mirror", pe.op_at(self.code, 6))

    def test_unlink_makes_it_independent(self):
        code = pe.unlink(self.code, 9)
        self.assertFalse(_rows(code)[8].endswith("Mid"))
        self.assertIsNone(pe.op_at(code, 9)["mirror"]["of"])
        code, _ = pe.add_holes(code, {"sketch": "Posts"}, kind="tapped", size="M3", line=6)
        self.assertIn('kind="tapped"', _rows(code)[5])
        self.assertIn('kind="insert"', _rows(code)[8])          # the copy kept its own
        # and edited itself it stays mirrored
        code, _ = pe.add_holes(code, {"sketch": "Posts"}, kind="clearance", size="M4", line=9)
        self.assertIn('at=mirrored(sketch_points("Posts"), PLANES["Mid"]), kind="clearance", size="M4"',
                      _rows(code)[8])
        with self.assertRaises(pe.ParamError):
            pe.unlink(code, 9)

    def test_line_numbers_follow_lines_moving(self):
        code = pe.add_param(self.code.replace("P = dict(", "P = dict(\n    "), "extra", 1)
        self.assertTrue(_rows(code)[8].endswith("# mirror of line 6 across Mid"))       # one line down
        code = pe.delete_step(code, 6)          # the extrude: its copy stays, unlinked
        rows = _rows(code)
        self.assertTrue(rows[7].endswith("PLANES[\"Mid\"])"), rows[7])
        self.assertTrue(rows[8].endswith("# mirror of line 6 across Mid"), rows[8])     # holes moved up
        self.assertTrue(rows[9].endswith("# mirror of line 7 across Mid"), rows[9])

    def test_renaming_the_plane_renames_the_comment(self):
        code = pe.rename_plane(self.code, "Mid", "Centre")
        self.assertTrue(_rows(code)[7].endswith('PLANES["Centre"])  # mirror of line 5 across Centre'))

    def test_deleting_the_original_keeps_or_deletes_its_copies(self):
        kept = pe.delete_step(self.code, 6, copies="keep")
        self.assertEqual(len(_rows(kept)), len(_rows(self.code)) - 1)
        self.assertIn('at=mirrored(sketch_points("Posts"), PLANES["Mid"])', kept)
        self.assertTrue(_rows(kept)[7].endswith("standoff=dict(h=5, d=7))"))      # the holes' copy, unlinked
        self.assertTrue(_rows(kept)[8].endswith("# mirror of line 6 across Mid"))  # the fillet's, renumbered
        gone = pe.delete_step(self.code, 6, copies="delete")
        self.assertEqual(len(_rows(gone)), len(_rows(self.code)) - 2)
        self.assertNotIn("sketch_points", gone)
        self.assertEqual([s.get("mirror_of") for s in pe.steps(gone) if s.get("mirror_plane")], [5, 6])

    def test_switching_off_with_or_without_copies(self):
        off = pe.suppress(self.code, 5, True, copies=True)
        self.assertTrue(_rows(off)[4].startswith(pe.OFF) and _rows(off)[7].startswith(pe.OFF))
        alone = pe.suppress(self.code, 5, True)
        self.assertFalse(_rows(alone)[7].startswith(pe.OFF))
        on = pe.suppress(off, 5, False, copies=True)
        self.assertEqual(on, self.code)
        # a switched-off copy is still linked, and still follows its original
        code = pe.suppress(self.code, 8, True)
        code = pe.add_extrude(code, "USB", "cut", depth=6.0, line=5)
        code = code if isinstance(code, str) else code[0]
        self.assertEqual([s["mirror_of"] for s in pe.steps(code) if s["line"] == 8], [5])


class StepsAndBodyTests(SimpleTestCase):
    def test_steps_show_copies_with_their_original(self):
        code, _, _ = pe.mirror_steps(CODE, [5, 7], {"plane": "Mid"})
        rows = {s["line"]: s for s in pe.steps(code)}
        self.assertEqual(rows[8]["summary"], "Cut 'USB' 5 mm · mirrored across Mid")
        self.assertEqual((rows[8]["mirror_of"], rows[8]["mirror_plane"]), (5, "Mid"))
        self.assertEqual((rows[9]["mirror_of"], rows[9]["mirror_plane"]), (7, "Mid"))
        self.assertIsNone(rows[8]["sketch"])               # nothing of its own to highlight
        self.assertEqual(rows[9]["edges"], [])
        self.assertTrue(rows[8]["reopenable"])
        self.assertIsNone(rows[5]["mirror_of"])
        self.assertIsNone(rows[5]["mirror_plane"])

    def test_mirror_body_round_trip(self):
        code = pe.add_mirror_body(CODE, {"plane": "Mid"}, join=True)
        self.assertTrue(code.endswith('part = mirror_body(part, PLANES["Mid"], join=True)\n'))
        got = pe.op_at(code, 9)
        self.assertEqual((got["op"], got["args"]), ("mirror_body", {"plane": {"plane": "Mid"}, "join": True, "gap": 0.0}))
        code = pe.add_mirror_body(code, "XY", join=False, line=9)
        self.assertIn('part = mirror_body(part, "XY", join=False, gap=0)', code)
        self.assertEqual(pe.op_at(code, 9)["args"], {"plane": {"base": "XY"}, "join": False, "gap": 0.0})
        step = next(s for s in pe.steps(code) if s["line"] == 9)
        self.assertEqual(step["summary"], "Mirror body across XY · separate body")
        self.assertTrue(step["reopenable"])
        face = {"center": [0, 0, 10], "normal": [-1, 0, 0], "hint": "left face"}
        code = pe.add_mirror_body(code, {"face": face}, line=9)
        self.assertEqual(pe.op_at(code, 9)["args"]["plane"], {"face": face})
        self.assertIn("across left face · joined", next(s for s in pe.steps(code) if s["line"] == 9)["summary"])
        with self.assertRaisesRegex(pe.ParamError, "no part"):
            pe.add_mirror_body("P = dict()\n", "XY")

    def test_mirror_body_gap_round_trip(self):
        code = pe.add_mirror_body(CODE, {"plane": "Mid"}, join=False, gap=10)
        self.assertTrue(code.endswith('part = mirror_body(part, PLANES["Mid"], join=False, gap=10)\n'))
        got = pe.op_at(code, 9)
        self.assertEqual((got["args"]["join"], got["args"]["gap"], got["exprs"]), (False, 10.0, {}))
        self.assertEqual(next(s for s in pe.steps(code) if s["line"] == 9)["summary"],
                         "Mirror body across Mid · separate body · 10 mm apart")
        # an expression of P stays one, and reads back as it was typed
        code = pe.add_mirror_body(code, {"plane": "Mid"}, join=False, gap="depth * 2", line=9)
        self.assertIn('join=False, gap=P["depth"] * 2)', code)
        got = pe.op_at(code, 9)
        self.assertEqual((got["args"]["gap"], got["exprs"]), (10.0, {"gap": "depth * 2"}))
        # joined: no gap written
        code = pe.add_mirror_body(code, {"plane": "Mid"}, join=True, gap=10, line=9)
        self.assertTrue(code.endswith('part = mirror_body(part, PLANES["Mid"], join=True)\n'))
        with self.assertRaisesRegex(pe.ParamError, "not a parameter"):
            pe.add_mirror_body(CODE, "XY", join=False, gap="nope + 1")

    def test_an_old_line_without_gap_reads_as_gap_0(self):
        code = CODE + 'part = mirror_body(part, "YZ", join=False)\n'
        self.assertEqual(pe.op_at(code, 9)["args"]["gap"], 0.0)
