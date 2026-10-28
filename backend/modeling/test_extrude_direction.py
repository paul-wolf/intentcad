"""Extrude depths are never negative: the direction is the line's sign (Flip),
and the steps list says it in plain words (modeling/paramedit.py)."""

from django.test import SimpleTestCase

from modeling.paramedit import _p_values, add_extrude, op_at, positive_depths, set_params, steps
from modeling.test_until import _flat, _run, _vol

SQUARE = [[{"t": "line", "p": [[-10, -10], [10, -10]]}, {"t": "line", "p": [[10, -10], [10, 10]]},
           {"t": "line", "p": [[10, 10], [-10, 10]]}, {"t": "line", "p": [[-10, 10], [-10, -10]]}]]
SLOT = [[{"t": "line", "p": [[-3, -3], [3, -3]]}, {"t": "line", "p": [[3, -3], [3, 3]]},
         {"t": "line", "p": [[3, 3], [-3, 3]]}, {"t": "line", "p": [[-3, 3], [-3, -3]]}]]


class PositiveDepthTests(SimpleTestCase):
    def test_a_negative_depth_turns_positive_and_its_line_flips(self):
        code = ('P = dict(body1_height=5, join1_height=-4, cut1_depth=-2)\n'
                'part = extrude(sketch("Base"), amount=P["body1_height"])\n'
                'part += extrude(sketch("Boss"), amount=P["join1_height"])\n'
                'part -= extrude(sketch("Slot"), amount=-P["cut1_depth"])\n')
        out, keys = positive_depths(code)
        self.assertEqual(keys, ["cut1_depth", "join1_height"])
        self.assertEqual(_p_values(out), {"body1_height": 5, "join1_height": 4, "cut1_depth": 2})
        self.assertIn('part += extrude(sketch("Boss"), amount=-P["join1_height"])', out)
        self.assertIn('part -= extrude(sketch("Slot"), amount=P["cut1_depth"])', out)
        self.assertEqual(positive_depths(out), (out, []))      # nothing left to do

    def test_it_builds_the_same_shape(self):
        sk = {"Base": _flat(0, SQUARE), "Boss": _flat(5, SLOT), "Slot": _flat(5, SLOT)}
        grow = ('P = dict(body1_height=5, join1_height=-3)\n'
                'part = extrude(sketch("Base"), amount=P["body1_height"])\n'
                'part += extrude(sketch("Boss"), amount=P["join1_height"])\n')
        out, _ = positive_depths(grow)
        self.assertAlmostEqual(_vol(_run(out, **sk)), _vol(_run(grow, **sk)), 3)
        self.assertAlmostEqual(_vol(_run(out, **sk)), 20 * 20 * 5, 3)       # down into the base: nothing added
        cut = ('P = dict(body1_height=5, cut1_depth=-2)\n'
               'part = extrude(sketch("Base"), amount=P["body1_height"])\n'
               'part -= extrude(sketch("Slot"), amount=-P["cut1_depth"])\n')
        out, _ = positive_depths(cut)
        self.assertAlmostEqual(_vol(_run(out, **sk)), _vol(_run(cut, **sk)), 3)

    def test_a_key_used_elsewhere_is_left_alone(self):
        code = ('P = dict(h=-4, w=10)\npart = Box(P["w"], P["w"], 5)\n'
                'part += extrude(sketch("Boss"), amount=P["h"])\n'
                'part = fillet(part, edges_ref([]), radius=abs(P["h"]) / 4)\n')
        self.assertEqual(positive_depths(code), (code, []))

    def test_linked_copies_flip_with_their_line_and_both_ways_only_turns_positive(self):
        code = ('P = dict(usb_depth=-5, boss_h=-3)\npart = Box(40, 40, 10)\n'
                'part -= extrude(sketch("USB"), amount=-P["usb_depth"])\n'
                'part -= mirrored(extrude(sketch("USB"), amount=-P["usb_depth"]), PLANES["Mid"])  # mirror of line 3 across Mid\n'
                'part += extrude(sketch("Boss"), amount=P["boss_h"], both=True)\n')
        out, keys = positive_depths(code)
        self.assertEqual(keys, ["boss_h", "usb_depth"])
        self.assertIn('part -= extrude(sketch("USB"), amount=P["usb_depth"])\n', out)
        self.assertIn('mirrored(extrude(sketch("USB"), amount=P["usb_depth"]), PLANES["Mid"])  # mirror of line 3', out)
        self.assertIn('amount=P["boss_h"], both=True', out)
        self.assertEqual(_p_values(out), {"usb_depth": 5, "boss_h": 3})

    def test_a_drag_below_zero_is_a_positive_depth_flipped(self):
        # the face drag and the sliders set the value; the endpoint tidies it
        code = 'P = dict(join1_height=5)\npart = Box(10, 10, 5)\npart += extrude(sketch("Boss"), amount=P["join1_height"])\n'
        out, keys = positive_depths(set_params(code, {"join1_height": -2}))
        self.assertEqual(keys, ["join1_height"])
        self.assertIn("join1_height=2", out)
        self.assertIn('amount=-P["join1_height"]', out)

    def test_the_dialog_writes_a_depth_below_zero_as_positive_flipped(self):
        code = "P = dict(w=10)\npart = Box(10, 10, 5)\n"
        out, key = add_extrude(code, "Boss", "join", -3)
        self.assertEqual(_p_values(out)[key], 3)
        self.assertIn(f'amount=-P["{key}"]', out)
        out, key = add_extrude(code, "Slot", "cut", -2)
        self.assertEqual(_p_values(out)[key], 2)
        self.assertIn(f'amount=P["{key}"]', out)          # a cut flipped: out of the face
        out, key = add_extrude(code, "Pin", "join", -4, datum=True, both=True)
        self.assertEqual(_p_values(out)[key], 4)
        self.assertIn(f'amount=P["{key}"], both=True', out)


    def test_a_line_with_a_negative_depth_reopens_positive_flipped_and_updates_the_same(self):
        sk = {"Base": _flat(0, SQUARE), "Boss": _flat(5, SLOT)}
        code = ('P = dict(body1_height=5, join1_height=-3)\n'
                'part = extrude(sketch("Base"), amount=P["body1_height"])\n'
                'part += extrude(sketch("Boss"), amount=P["join1_height"])\n')
        a = op_at(code, 3)["args"]
        self.assertEqual((a["depth"], a["flip"]), (3, True))
        out, key = add_extrude(code, "Boss", "join", a["depth"], flip=a["flip"], line=3)
        self.assertEqual(_p_values(out)[key], 3)
        self.assertAlmostEqual(_vol(_run(out, **sk)), _vol(_run(code, **sk)), 3)


class DirectionWordsTests(SimpleTestCase):
    CODE = ('P = dict(body1_height=5, cut1_depth=3, join1_height=2, cut2_depth=1)\n'
            'part = extrude(sketch("Base"), amount=P["body1_height"])\n'
            'part -= extrude(sketch("Slots"), amount=-P["cut1_depth"])\n'
            'part += extrude(sketch("Boss"), amount=P["join1_height"])\n'
            'part -= extrude(sketch("Side"), amount=P["cut2_depth"])\n'
            'part -= extrude(sketch("Hole"), amount=-part.bounding_box().diagonal)\n')

    def test_the_steps_say_which_way_in_plain_words(self):
        normals = {"Base": [0, 0, 1], "Slots": [0, 0, 1], "Boss": [0, 0, 1], "Side": [1, 0, 0], "Hole": [0, 0, 1]}
        got = [s["summary"] for s in steps(self.CODE, datum=["Base"], normals=normals)]
        self.assertEqual(got, [
            "New body 'Base' 5 mm up (+Z)",
            "Cut 'Slots' 3 mm into the part, down (−Z)",
            "Join 'Boss' 2 mm out of the face, up (+Z)",
            "Cut 'Side' 1 mm out of the face, to the right (+X) — cuts nothing there",
            "Cut 'Hole' through the part, down (−Z)",
        ])

    def test_without_normals_it_still_says_in_or_out(self):
        got = [s["summary"] for s in steps(self.CODE, datum=["Base"])]
        self.assertEqual(got[:3], ["New body 'Base' 5 mm", "Cut 'Slots' 3 mm into the part",
                                   "Join 'Boss' 2 mm out of the face"])
