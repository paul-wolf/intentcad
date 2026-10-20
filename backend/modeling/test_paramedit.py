"""Tests for the params editor (modeling/paramedit.py) — pure text/AST."""

from django.test import SimpleTestCase

from modeling.paramedit import (OFF, ParamError, add_extrude, add_param, delete_step, edit_args, op_at, op_lines,
                                param_names, set_params, steps, suppress)


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
            ("op", "Cut 'USB cutout' 5 mm", 6),
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
        self.assertEqual(got, ["Join 'Boss' 3 mm both ways", "Cut 'Slot' through all",
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
