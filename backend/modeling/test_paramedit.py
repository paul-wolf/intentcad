"""Tests for the params editor (modeling/paramedit.py) — pure text/AST."""

from django.test import SimpleTestCase

from modeling.paramedit import (OFF, ParamError, _p_values, add_extrude, add_param, add_plane, delete_step, edit_args, op_at,
                                op_lines, param_names, plane_names, rename_plane, set_params, steps, suppress)


class ParamEditTests(SimpleTestCase):
    def test_dict_call_preserves_formatting_and_comments(self):
        code = "# top\nP = dict(a=1, b=2)  # keep\npart = Box(P['a'], P['b'], 1)\n"
        out = set_params(code, {"b": 5})
        self.assertIn("P = dict(a=1, b=5)  # keep", out)
        self.assertIn("# top", out)

    def test_brace_dict(self):
        code = "P = {'a': 1, 'b': 2}\npart = Box(1,1,1)"
        out = set_params(code, {"a": 9})
        self.assertIn("'a': 9", out)

    def test_float_and_int(self):
        code = "P = dict(x=6)\npart = Box(1,1,1)"
        self.assertIn("x=8", set_params(code, {"x": 8.0}))    # integral float -> int
        self.assertIn("x=2.5", set_params(code, {"x": 2.5}))

    def test_only_named_keys_changed(self):
        code = "P = dict(a=1, b=2, c=3)\npart = Box(1,1,1)"
        out = set_params(code, {"b": 20})
        self.assertIn("a=1", out)
        self.assertIn("b=20", out)
        self.assertIn("c=3", out)

    def test_no_params_dict_raises(self):
        with self.assertRaises(ParamError):
            set_params("part = Box(1,1,1)", {"a": 1})

    def test_empty_overrides_is_noop(self):
        code = "P = dict(a=1)\npart = Box(1,1,1)"
        self.assertEqual(set_params(code, {}), code)


class AddParamTests(SimpleTestCase):
    def test_one_line_dict_call(self):
        out = add_param("P = dict(a=1)  # keep\npart = Box(1,1,1)", "b", 2.0)
        self.assertIn("P = dict(a=1, b=2)  # keep", out)

    def test_one_entry_per_line_keeps_the_layout(self):
        code = "P = dict(\n    a=1,   # first\n    b=2.5\n)\npart = Box(1,1,1)"
        out = add_param(code, "c", 3.0)
        self.assertEqual(out.split("\n")[:5], ["P = dict(", "    a=1,   # first", "    b=2.5,", "    c=3,", ")"])

    def test_brace_dict_and_empty_dict(self):
        self.assertIn('"b": 4', add_param("P = {'a': 1}\n", "b", 4.0))
        self.assertIn("P = dict(b=4)", add_param("P = dict()\n", "b", 4.0))

    def test_no_dict_creates_one_after_the_imports(self):
        out = add_param("import math\npart = Box(1,1,1)\n", "d", 5.0)
        self.assertEqual(out.split("\n")[:3], ["import math", "P = dict(d=5)", ""])
        compile(out, "<t>", "exec")


class AddExtrudeTests(SimpleTestCase):
    code = "P = dict(w=10)\npart = Box(P['w'], 10, 2)\n"

    def test_cut_to_a_depth_adds_a_param(self):
        out, param = add_extrude(self.code, "Sketch 1", "cut", 3)
        self.assertEqual(param, "cut1_depth")
        self.assertIn("P = dict(w=10, cut1_depth=3)", out)
        self.assertTrue(out.endswith('part -= extrude(sketch("Sketch 1"), amount=-P["cut1_depth"])\n'))

    def test_second_cut_gets_a_fresh_name(self):
        once, _ = add_extrude(self.code, "S", "cut", 3)
        _, param = add_extrude(once, "S", "cut", 4)
        self.assertEqual(param, "cut2_depth")

    def test_through_all_has_no_param(self):
        out, param = add_extrude(self.code, "S", "cut", 3, through=True)
        self.assertIsNone(param)
        self.assertIn("amount=-part.bounding_box().diagonal)", out)
        self.assertNotIn("cut1", out)

    def test_join_grows_out_and_flip_reverses(self):
        out, param = add_extrude(self.code, "S", "join", 5)
        self.assertEqual(param, "join1_height")
        self.assertIn('part += extrude(sketch("S"), amount=P["join1_height"])', out)
        flipped, _ = add_extrude(self.code, "S", "join", 5, flip=True)
        self.assertIn('amount=-P["join1_height"]', flipped)

    def test_unknown_op_raises(self):
        with self.assertRaises(ParamError):
            add_extrude(self.code, "S", "revolve", 5)

    def test_new_body_starts_an_empty_script(self):
        out, param = add_extrude("", "Sketch on Top plane", "new", 12)
        self.assertEqual(param, "body1_height")
        self.assertEqual(out, 'P = dict(body1_height=12)\n\n'
                              'part = extrude(sketch("Sketch on Top plane"), amount=P["body1_height"])\n')

    def test_new_body_refuses_a_script_that_has_a_part(self):
        with self.assertRaises(ParamError):
            add_extrude(self.code, "S", "new", 5)

    def test_datum_sketch_cuts_along_the_normal_and_through_both_ways(self):
        out, _ = add_extrude(self.code, "S", "cut", 3, datum=True)
        self.assertIn('amount=P["cut1_depth"])', out)
        through, _ = add_extrude(self.code, "S", "cut", 3, through=True, datum=True)
        self.assertIn("both=True)", through)

    def test_both_ways_from_a_base_plane(self):
        out, param = add_extrude(self.code, "S", "join", 4, datum=True, both=True, flip=True)
        self.assertIn('part += extrude(sketch("S"), amount=P["join1_height"], both=True)', out)
        # a face sketch has no "both": it stays one-sided
        face, _ = add_extrude(self.code, "S", "join", 4, both=True)
        self.assertNotIn("both=True", face)


def _line_of(code: str, text: str) -> int:
    return next(i for i, row in enumerate(code.split("\n"), 1) if text in row)


class ExtrudeReopenTests(SimpleTestCase):
    base = "P = dict(w=10)\npart = Box(P['w'], 10, 2)\n"
    # every form add_extrude writes: (op, through, flip, datum, both)
    forms = [(op, through, flip, datum, both)
             for op in ("cut", "join") for through in (False, True) for flip in (False, True)
             for datum in (False, True) for both in (False, True)
             if not (through and op != "cut") and not (both and not datum)]

    def test_every_form_reads_back_and_writes_the_same_line(self):
        for op, through, flip, datum, both in self.forms:
            with self.subTest(op=op, through=through, flip=flip, datum=datum, both=both):
                code, key = add_extrude(self.base, "S", op, 4, through=through, flip=flip, datum=datum, both=both)
                line = len(code.rstrip("\n").split("\n"))
                got = op_at(code, line, datum=["S"] if datum else [])
                a = got["args"]
                self.assertEqual((got["op"], a["sketch"], a["op"], a["through"], a["datum"]),
                                 ("extrude", "S", op, through, datum or (through and datum)))
                self.assertEqual(got["params"].get("depth"), key)
                if not through:
                    self.assertEqual(a["depth"], 4)
                # writing the values read back changes nothing
                again, _ = add_extrude(code, "S", a["op"], a["depth"] or 10, a["through"], a["flip"],
                                       a["datum"], a["both"], line=line)
                self.assertEqual(again, code)

    def test_new_body_reads_back(self):
        code, key = add_extrude("", "Sketch on Top plane", "new", 12, datum=True)
        got = op_at(code, 3, datum=["Sketch on Top plane"])
        self.assertEqual(got["args"]["op"], "new")
        self.assertEqual(got["params"], {"depth": "body1_height"})
        self.assertEqual(op_lines(code), [{"op": "extrude", "line": 3, "end_line": 3}])

    def test_other_shapes_are_not_reopenable(self):
        for line in ("part -= extrude(sketch('S'), amount=-5)", "part -= extrude(Circle(3), amount=-P['w'])",
                     "part -= extrude(sketch('S'), -P['w'])", "part -= extrude(sketch('S'), amount=-P['w'], taper=2)"):
            with self.subTest(line=line):
                code = self.base + line + "\n"
                with self.assertRaises(ParamError):
                    op_at(code, 3)
                st = [s for s in steps(code) if s["kind"] == "op"]
                self.assertEqual(len(st), 1)
                self.assertFalse(st[0]["reopenable"])

    def test_op_change_cut_to_join_rewrites_the_operator_sign_and_key(self):
        code, _ = add_extrude(self.base, "S", "cut", 3)
        out, key = add_extrude(code, "S", "join", 3, line=3)
        self.assertEqual(key, "join1_height")
        self.assertTrue(out.endswith('part += extrude(sketch("S"), amount=P["join1_height"])\n'))
        self.assertIn("P = dict(w=10, join1_height=3)", out)
        self.assertNotIn("cut1_depth", out)

    def test_a_key_of_your_own_stays_when_the_op_changes(self):
        code = self.base + 'part -= extrude(sketch("S"), amount=-P["w"])\n'
        out, key = add_extrude(code, "S", "join", 10, line=3)
        self.assertEqual(key, "w")
        self.assertIn('part += extrude(sketch("S"), amount=P["w"])', out)

    def test_a_depth_edit_changes_only_that_p_key(self):
        code, _ = add_extrude(self.base + "# keep me\n", "S", "cut", 3)
        out, key = add_extrude(code, "S", "cut", 7.5, line=4)
        self.assertEqual(key, "cut1_depth")
        self.assertEqual(out, code.replace("cut1_depth=3", "cut1_depth=7.5"))

    def test_through_drops_the_depth_key_and_back_makes_one(self):
        code, _ = add_extrude(self.base, "S", "cut", 3)
        through, key = add_extrude(code, "S", "cut", 3, through=True, line=3)
        self.assertIsNone(key)
        self.assertNotIn("cut1_depth", through)
        self.assertIn("amount=-part.bounding_box().diagonal)", through)
        back, key = add_extrude(through, "S", "cut", 2, line=3)
        self.assertEqual(key, "cut1_depth")
        self.assertIn("cut1_depth=2", back)

    def test_new_only_for_the_first_body(self):
        code, _ = add_extrude(self.base, "S", "cut", 3)
        with self.assertRaises(ParamError):
            add_extrude(code, "S", "new", 3, line=3)
        first, _ = add_extrude("", "T", "new", 5, datum=True)
        with self.assertRaises(ParamError):
            add_extrude(first, "T", "cut", 5, datum=True, line=3)

    def test_a_trailing_comment_stays(self):
        code = self.base + 'part -= extrude(sketch("S"), amount=-P["w"])  # USB\n'
        out, _ = add_extrude(code, "S", "cut", 4, through=True, line=3)
        self.assertIn("diagonal)  # USB", out)


ROUND = ('part = auto_round(part, convex=P["round_r"], concave=2,\n'
         '                  keep=[part.faces().sort_by(Axis.Z)[0], face_ref({"center": [0, 0, 5], "normal": [0, 0, 1], '
         '"area": 100, "box": [0, 0, 10, 10], "hint": "top face"})],\n'
         '                  time_budget=30)  # AI\n')
TRUSS = ('part = truss_windows(part, part.faces().sort_by(Axis.Z)[-1], rim=P["truss_rim"], rib=4, '
         'anchors=[(0, 0), (10, 5)], corner_r=1.5)\n')


class ArgOpTests(SimpleTestCase):
    code = "P = dict(round_r=1.5, truss_rim=5)\npart = Box(40, 30, 5)\n" + TRUSS + ROUND

    def test_reads_p_refs_and_literals(self):
        got = op_at(self.code, 4)
        self.assertEqual(got["op"], "auto_round")
        self.assertEqual((got["line"], got["end_line"]), (4, 6))
        a = got["args"]
        self.assertEqual((a["convex"], a["concave"], a["keep_bed"], a["protect_holes"]), (1.5, 2, True, True))
        self.assertEqual(got["params"], {"convex": "round_r"})
        self.assertEqual([k["src"] for k in a["keep"]][0], "part.faces().sort_by(Axis.Z)[0]")
        self.assertIsNone(a["keep"][0]["ref"])
        self.assertEqual(a["keep"][1]["ref"]["hint"], "top face")
        t = op_at(self.code, 3)
        self.assertEqual((t["args"]["rim"], t["args"]["rib"], t["args"]["corner_r"], t["args"]["keep_clear"],
                          t["args"]["pattern"]), (5, 4, 1.5, 3.0, "fan"))
        self.assertEqual(t["params"], {"rim": "truss_rim"})

    def test_an_expression_is_shown_not_edited(self):
        code = self.code.replace("rib=4", 'rib=2 * P["truss_rim"]')
        t = op_at(code, 3)
        self.assertEqual(t["exprs"], {"rib": '2 * P["truss_rim"]'})
        with self.assertRaises(ParamError):
            edit_args(code, 3, "truss_windows", {"rib": 3})

    def test_edit_sets_p_rewrites_literals_and_keeps_the_rest(self):
        out, new = edit_args(self.code, 4, "auto_round", {"convex": 2, "concave": 3.5, "keep_bed": False})
        self.assertEqual(new, [])
        self.assertIn("round_r=2,", out)
        self.assertIn("concave=3.5,", out)
        self.assertIn("time_budget=30, keep_bed=False)  # AI", out)       # unknown args stay; a new one added
        self.assertIn("keep=[part.faces().sort_by(Axis.Z)[0], face_ref(", out)
        self.assertEqual(out.split("\n")[2], TRUSS.rstrip("\n"))           # the other line untouched
        t, _ = edit_args(self.code, 3, "truss_windows", {"rib": 4, "pattern": "triangulate", "keep_clear": 3})
        self.assertIn('rim=P["truss_rim"], rib=4, anchors=[(0, 0), (10, 5)], corner_r=1.5, '
                      'pattern="triangulate")', t)
        self.assertNotIn("keep_clear", t)                                    # the default: not written

    def test_unchanged_values_change_nothing(self):
        a = op_at(self.code, 4)["args"]
        out, _ = edit_args(self.code, 4, "auto_round",
                           {k: a[k] for k in ("convex", "concave", "keep_bed", "protect_holes")},
                           keep=[{"src": k["src"]} for k in a["keep"]])
        self.assertEqual(out, self.code)

    def test_keep_list_remove_and_add(self):
        a = op_at(self.code, 4)["args"]
        ref = {"center": [0, 0, 0], "normal": [0, 0, -1], "area": 100, "box": [0, 0, 10, 10], "hint": "bottom face"}
        out, _ = edit_args(self.code, 4, "auto_round", keep=[{"src": a["keep"][1]["src"]}, {"ref": ref}])
        self.assertNotIn("sort_by(Axis.Z)[0]", out)
        k = op_at(out, 4)["args"]["keep"]
        self.assertEqual([x["ref"]["hint"] for x in k], ["top face", "bottom face"])

    def test_make_parameter_moves_a_literal_into_p(self):
        out, new = edit_args(self.code, 4, "auto_round", {"concave": 2.5}, make_param=["concave"])
        self.assertEqual(new, ["blend_r"])
        self.assertIn("P = dict(round_r=1.5, truss_rim=5, blend_r=2.5)", out)
        self.assertIn('concave=P["blend_r"],', out)
        self.assertEqual(op_at(out, 4)["params"], {"convex": "round_r", "concave": "blend_r"})
        t, new = edit_args(self.code, 3, "truss_windows", make_param=["rib", "corner_r"])
        self.assertEqual(new, ["truss_rib", "truss_corner_r"])
        self.assertIn('rib=P["truss_rib"]', t)
        self.assertIn("truss_rib=4, truss_corner_r=1.5", t)

    def test_bad_values_raise(self):
        with self.assertRaises(ParamError):
            edit_args(self.code, 3, "truss_windows", {"pattern": "hex"})
        with self.assertRaises(ParamError):
            edit_args(self.code, 3, "truss_windows", {"rim": 0})
        with self.assertRaises(ParamError):
            edit_args(self.code, 3, "auto_round", {"convex": 1})          # line 3 is the truss


DRONE = ("from build123d import *\n"
         "P = dict(w=60, wall=2, cut1_depth=5, fillet_r=1, insert_depth=4, standoff_h=6, standoff_d=7, hole_comp=0)\n"
         "part = Box(P['w'], 40, 20)\n"
         "part = part.translate((0, 0, 10))\n"
         'part = shell(part, remove=[face_ref({"center": [0, 0, 20], "normal": [0, 0, 1], "area": 2400, '
         '"box": [0, 0, 1, 1], "hint": "top face"})], thickness=P["wall"], inside=True)\n'
         'part -= extrude(sketch("USB cutout"), amount=-P["cut1_depth"])\n'
         'part = fillet(part, edges_ref([{"kind": "line"}, {"kind": "line"}, {"kind": "line"}, {"kind": "line"}]), '
         'radius=P["fillet_r"])\n'
         'part = holes(part, at=sketch_points("PCB"), kind="insert", size="M3", depth=P["insert_depth"], '
         'standoff=dict(h=P["standoff_h"], d=P["standoff_d"], fillet=1))\n'
         "part = auto_round(part, convex=1, concave=2)\n")


class StepsTests(SimpleTestCase):
    def test_summaries(self):
        st = steps(DRONE, points={"PCB": 4})
        self.assertEqual([(s["kind"], s.get("summary"), s["line"]) for s in st], [
            ("script", None, 3),
            ("op", "Shell 2 mm, top open", 5),
            ("op", "Cut 'USB cutout' 5 mm into the part", 6),
            ("op", "Fillet 1 mm · 4 edges", 7),
            ("op", "Holes M3 insert ×4 + standoffs", 8),
            ("op", "Round 1 mm, blends 2 mm", 9),
        ])
        self.assertEqual((st[0]["count"], st[0]["end_line"]), (2, 4))
        self.assertTrue(all(s["reopenable"] for s in st[1:]))
        self.assertEqual(st[2]["sketch"], "USB cutout")
        self.assertEqual(st[1]["faces"][0]["hint"], "top face")
        self.assertEqual(len(st[3]["edges"]), 4)
        self.assertEqual((st[2]["op"], st[2]["variant"]), ("extrude", "cut"))

    def test_more_summaries(self):
        code = ("P = dict(d=3)\npart = Box(1, 1, 1)\n"
                'part += extrude(sketch("Boss"), amount=P["d"], both=True)\n'
                'part -= extrude(sketch("Slot"), amount=-part.bounding_box().diagonal)\n'
                "part = shell(part, thickness=1.5, inside=False)\n"
                + TRUSS + "part = shell(part, remove=[part.faces().sort_by(Axis.Z)[-1]], thickness=2)\n")
        got = [s["summary"] for s in steps(code)[1:]]
        self.assertEqual(got, ["Join 'Boss' 3 mm each way", "Cut 'Slot' through the part",
                               "Shell 1.5 mm, closed · walls outward", "Lighten: rim ?, rib 4 mm, fan",
                               "Shell · written in code"])

    def test_suppress_then_unsuppress_restores_the_exact_line(self):
        code = "P = dict(round_r=1.5, truss_rim=5)\npart = Box(40, 30, 5)\n" + TRUSS + ROUND
        for line in (3, 5):
            with self.subTest(line=line):
                off = suppress(code, line)
                rows = off.split("\n")
                if line == 3:
                    self.assertEqual(rows[2], OFF + TRUSS.rstrip("\n"))
                else:
                    self.assertTrue(all(r.startswith(OFF) for r in rows[3:6]))
                st = [s for s in steps(off) if s["kind"] == "op"]
                self.assertEqual([s["off"] for s in st], [line == 3, line == 5])
                self.assertFalse(any(s["reopenable"] for s in st if s["off"]))
                compile(off, "<t>", "exec")
                self.assertEqual(suppress(off, line, off=False), code)
        # two off steps side by side stay two steps
        both = suppress(suppress(code, 3), 4)
        st = [s for s in steps(both) if s["kind"] == "op"]
        self.assertEqual([(s["op"], s["line"], s["end_line"]) for s in st],
                         [("truss_windows", 3, 3), ("auto_round", 4, 6)])
        self.assertEqual(suppress(suppress(both, 4, off=False), 3, off=False), code)

    def test_delete_removes_only_p_keys_no_other_line_uses(self):
        code = DRONE.replace('"insert", size="M3", depth=P["insert_depth"]', '"insert", size="M3", depth=P["cut1_depth"]')
        out = delete_step(code, 6)                          # the cut: cut1_depth is still used by the holes
        self.assertNotIn("USB cutout", out)
        self.assertIn("cut1_depth", param_names(out))
        out = delete_step(DRONE, 7)                         # the fillet: fillet_r only it used
        self.assertNotIn("fillet(", out)
        self.assertNotIn("fillet_r", out)
        self.assertEqual(param_names(out), param_names(DRONE) - {"fillet_r"})

    def test_delete_keeps_keys_a_switched_off_step_uses(self):
        code = DRONE + 'part -= extrude(sketch("USB cutout 2"), amount=-P["cut1_depth"])\n'
        off = suppress(code, 10)
        out = delete_step(off, 6)
        self.assertIn("cut1_depth", param_names(out))
        gone = delete_step(out, _line_of(out, OFF))         # the switched-off one goes too, and its key
        self.assertNotIn("cut1_depth", gone)
        self.assertNotIn(OFF, gone)


RIGHT = {"center": [30, 0, 10], "normal": [1, 0, 0], "area": 800.0, "hint": "right face"}
TOP_EDGE = {"faces": [{"center": [0, 0, 20], "normal": [0, 0, 1], "area": 2400.0, "hint": "top face"},
                      {"center": [0, -20, 10], "normal": [0, -1, 0], "area": 1200.0, "hint": "front face"}],
            "kind": "line", "midpoint": [0, -20, 20], "length": 60.0, "hint": "top-front edge"}
BOXP = 'P = dict(width=60, h=20, cam_tilt=30)\npart = Pos(0, 0, P["h"] / 2) * Box(P["width"], 40, P["h"])\n'


class PlaneLineTests(SimpleTestCase):
    def test_offset_plane_round_trip_with_an_expression(self):
        code, renamed = add_plane(BOXP, "offset_plane", "Mid", base={"face": RIGHT}, distance="-width / 2")
        self.assertIsNone(renamed)
        self.assertIn('PLANES["Mid"] = offset_plane(face_ref({"center": [30, 0, 10], "normal": [1, 0, 0], '
                      '"area": 800, "hint": "right face"}), distance=-P["width"] / 2)', code)
        at = op_at(code, 3)
        self.assertEqual(at["op"], "offset_plane")
        self.assertEqual(at["args"], {"name": "Mid", "base": {"face": RIGHT}, "distance": -30.0})
        self.assertEqual(at["exprs"], {"distance": "-width / 2"})
        # written again from what it read: the same line
        again, _ = add_plane(code, "offset_plane", "Mid", base=at["args"]["base"], distance=at["exprs"]["distance"],
                             line=3)
        self.assertEqual(again, code)

    def test_base_plane_offsets_and_numbers(self):
        code, _ = add_plane(BOXP, "offset_plane", "Top 30", base="XY", distance=30)
        self.assertIn('PLANES["Top 30"] = offset_plane("XY", distance=30)', code)
        self.assertEqual(op_at(code, 3)["args"], {"name": "Top 30", "base": "XY", "distance": 30.0})
        code, _ = add_plane(code, "offset_plane", "Lid", base="xz", distance=-2.5)
        self.assertIn('PLANES["Lid"] = offset_plane("XZ", distance=-2.5)', code)
        self.assertEqual(op_at(code, 4)["args"]["distance"], -2.5)
        self.assertEqual(op_at(code, 4)["exprs"], {})
        self.assertEqual(plane_names(code), ["Top 30", "Lid"])
        # P["k"] on its own reads as the expression "k"
        code = BOXP + 'PLANES["G"] = offset_plane("XY", distance=P["h"])\n'
        self.assertEqual((op_at(code, 3)["args"]["distance"], op_at(code, 3)["exprs"]), (20.0, {"distance": "h"}))

    def test_edge_plane_round_trip(self):
        code, _ = add_plane(BOXP, "edge_plane", "Cam tilt", edge=TOP_EDGE, angle="cam_tilt",
                            from_face=TOP_EDGE["faces"][0])
        self.assertIn('PLANES["Cam tilt"] = edge_plane(edge_ref({', code)
        self.assertIn('angle=P["cam_tilt"], from_face=face_ref({"center": [0, 0, 20]', code)
        at = op_at(code, 3)
        self.assertEqual(at["args"], {"name": "Cam tilt", "edge": TOP_EDGE, "angle": 30.0,
                                      "from_face": TOP_EDGE["faces"][0]})
        self.assertEqual(at["exprs"], {"angle": "cam_tilt"})
        again, _ = add_plane(code, "edge_plane", "Cam tilt", edge=at["args"]["edge"], angle="cam_tilt",
                             from_face=at["args"]["from_face"], line=3)
        self.assertEqual(again, code)
        code, _ = add_plane(BOXP, "edge_plane", "E", edge=TOP_EDGE, angle=-15)
        self.assertIn("angle=-15)", code)
        self.assertIsNone(op_at(code, 3)["args"]["from_face"])

    def test_tangent_plane_round_trip(self):
        hub = {"center": [0, 0, 10], "normal": [0, 0, 1], "area": 1885, "kind": "cylinder", "hint": "hub"}
        code, _ = add_plane(BOXP, "tangent_plane", "Set screw", face=hub, angle="cam_tilt", ref="x")
        self.assertIn('PLANES["Set screw"] = tangent_plane(face_ref({"center": [0, 0, 10], "normal": [0, 0, 1], '
                      '"area": 1885, "kind": "cylinder", "hint": "hub"}), angle=P["cam_tilt"], ref="X")', code)
        at = op_at(code, 3)
        self.assertEqual(at["op"], "tangent_plane")
        self.assertEqual(at["args"], {"name": "Set screw", "face": hub, "angle": 30.0, "ref": "X"})
        self.assertEqual(at["exprs"], {"angle": "cam_tilt"})
        again, _ = add_plane(code, "tangent_plane", "Set screw", face=hub, angle="cam_tilt", ref="X", line=3)
        self.assertEqual(again, code)
        # a number goes in P, after the plane's name; from a flat face
        code, _ = add_plane(BOXP, "tangent_plane", "Set screw", face=hub, angle=12.5, ref={"face": RIGHT})
        self.assertIn('angle=P["set_screw_angle"], ref=face_ref({"center": [30, 0, 10]', code)
        self.assertEqual(_p_values(code)["set_screw_angle"], 12.5)
        self.assertEqual(op_at(code, 3)["args"]["ref"], {"face": RIGHT})
        self.assertEqual(op_at(code, 3)["exprs"], {"angle": "set_screw_angle"})
        # reopened and set to another number: the same key
        again, _ = add_plane(code, "tangent_plane", "Set screw", face=hub, angle=40, ref={"face": RIGHT}, line=3)
        self.assertEqual(_p_values(again)["set_screw_angle"], 40)
        self.assertEqual(again, code.replace("set_screw_angle=12.5", "set_screw_angle=40"))
        code, _ = add_plane(BOXP, "tangent_plane", "T", face=hub, angle="cam_tilt / 2", ref={"face": RIGHT})
        st = steps(code)[1]
        self.assertEqual(st["summary"], "Plane 'T' · tangent at 15° from right face on hub")
        self.assertEqual((st["op"], st["plane"], st["reopenable"], st["faces"]), ("tangent_plane", "T", True, [hub, RIGHT]))
        code, _ = add_plane(BOXP, "tangent_plane", "T", face=hub, angle=0, ref=None)
        self.assertIn("tangent_plane(face_ref({", code)
        self.assertIn('angle=P["t_angle"])', code)
        self.assertIsNone(op_at(code, 3)["args"]["ref"])
        self.assertEqual(steps(code)[1]["summary"], "Plane 'T' · tangent at 0° on hub")
        with self.assertRaisesRegex(ParamError, "select a cylindrical face"):
            add_plane(BOXP, "tangent_plane", "T", face=None, angle=0)
        with self.assertRaisesRegex(ParamError, "measure the angle from X, Y, Z or a flat face"):
            add_plane(BOXP, "tangent_plane", "T", face=hub, angle=0, ref="W")

    def test_bad_names_and_expressions_are_refused(self):
        code, _ = add_plane(BOXP, "offset_plane", "Lid", base="XY", distance=5)
        with self.assertRaisesRegex(ParamError, "a plane named 'Lid' already"):
            add_plane(code, "offset_plane", "Lid", base="XY", distance=6)
        with self.assertRaisesRegex(ParamError, "give the plane a name"):
            add_plane(code, "offset_plane", " ", base="XY", distance=6)
        with self.assertRaisesRegex(ParamError, "uses 'depth', which is not a parameter"):
            add_plane(code, "offset_plane", "X", base="XY", distance="depth + 1")
        with self.assertRaisesRegex(ParamError, "may only use numbers, parameters"):
            add_plane(code, "offset_plane", "X", base="XY", distance="__import__('os')")
        with self.assertRaisesRegex(ParamError, "pick a flat face, or the XY, XZ or YZ plane"):
            add_plane(code, "offset_plane", "X", base=None, distance=1)

    def test_renaming_rewrites_its_key_and_every_use(self):
        code, _ = add_plane(BOXP, "offset_plane", "Lid", base="XY", distance=5)
        code += "part += PLANES['Lid'] * Box(1, 1, 1)\n" + OFF + 'part += PLANES["Lid"] * Box(2, 2, 2)\n'
        out = rename_plane(code, "Lid", "Cover")
        self.assertNotIn("Lid", out)
        self.assertEqual(out.count('PLANES["Cover"]'), 3)
        with self.assertRaisesRegex(ParamError, "no plane named 'Nope'"):
            rename_plane(code, "Nope", "X")
        # reopened with a new name: renamed everywhere, and the old name returned
        out, renamed = add_plane(code, "offset_plane", "Cover", base="XY", distance=7, line=3)
        self.assertEqual(renamed, "Lid")
        self.assertEqual(out.count('PLANES["Cover"]'), 3)
        self.assertIn("distance=7", out)

    def test_steps_summaries(self):
        code, _ = add_plane(BOXP, "offset_plane", "Mid", base={"face": RIGHT}, distance="-width / 2")
        code, _ = add_plane(code, "offset_plane", "Top 30", base="XY", distance=30)
        code, _ = add_plane(code, "edge_plane", "Cam", edge=TOP_EDGE, angle="cam_tilt", from_face=TOP_EDGE["faces"][0])
        st = steps(code)[1:]
        self.assertEqual([s["summary"] for s in st], ["Plane 'Mid' · -30 mm from right face",
                                                      "Plane 'Top 30' · 30 mm from XY plane",
                                                      "Plane 'Cam' · 30° on top-front edge"])
        self.assertEqual([(s["op"], s["plane"], s["reopenable"]) for s in st],
                         [("offset_plane", "Mid", True), ("offset_plane", "Top 30", True), ("edge_plane", "Cam", True)])
        self.assertEqual(st[0]["faces"], [RIGHT])
        self.assertEqual(st[2]["edges"], [TOP_EDGE])
        # switched off, it still shows as the plane
        off = steps(suppress(code, 3))[1]
        self.assertEqual((off["op"], off["off"], off["plane"]), ("offset_plane", True, "Mid"))
        self.assertEqual(plane_names(delete_step(code, 3)), ["Top 30", "Cam"])
