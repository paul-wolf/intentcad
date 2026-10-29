"""The project tools every chat has: the part chat, a drawn sketch's and a
generated sketch's. Each may propose project parameters
(set_project_parameter) and a new brief (propose_brief_edit) with any kind of
reply; nothing is saved until the user accepts the card, and several
parameters in one reply (a pasted list) come back together, for one card.
"Can't edit drawn shapes" covers only a drawn sketch's drawing."""
from documents.models import Document

from .assistant import AssistantError, edit_script
from .sketch_chat import sketch_chat
from .test_generated_sketch import LAYOUT, PART
from .test_project_context import _scripted
from .test_sketch_chat import SketchChatWorld

PASTED = [("prop_d", 406.4, "mm"), ("arm_count", 6, ""), ("brace_r_in", 42, "mm"), ("tip_gap", 20, "mm")]


def calls(*items):
    """One model turn calling set_project_parameter once per item."""
    cs = [{"id": f"t{i}", "name": "set_project_parameter",
           "input": {"name": n, "value": v, "unit": u, "reason": "pasted"}} for i, (n, v, u) in enumerate(items)]
    return {"kind": "tool", "calls": cs, "content": [{"type": "tool_use", **c} for c in cs], "usage": {}}


def brief(text):
    return {"kind": "tool", "calls": [{"id": "b", "name": "propose_brief_edit",
                                       "input": {"new_text": text, "reason": "the arms"}}],
            "content": [], "usage": {}}


ANSWER = {"kind": "answer", "text": "Proposed them.", "usage": {}, "side": []}


class ProjectToolsInEveryChat(SketchChatWorld):
    def setUp(self):
        super().setUp()
        self.drawn = Document.objects.create(name="Drawn", project=self.drone, created_by=self.user, data={
            "type": "sketch", "sketches": [{"id": "d1", "name": "Sketch 1", "constraints": [],
                                             "entities": [{"id": "c", "type": "circle", "center": {"x": 5, "y": 0},
                                                           "radius": 1.6}]}]})

    def chats(self):
        """Each chat as (its name, a function sending one message with a fake model)."""
        return [
            ("part", lambda text, llm: edit_script(PART, text, document_id=str(self.part.id), llm=llm)),
            ("drawn sketch", lambda text, llm: sketch_chat(self.drawn, text, llm=llm)),
            ("generated sketch", lambda text, llm: sketch_chat(self.layout, text, llm=llm)),
        ]

    def assertNothingSaved(self):
        self.drone.refresh_from_db()
        self.assertEqual([p["name"] for p in self.drone.parameters], ["thick", "w"])
        self.assertEqual(self.drone.brief, "Carbon fibre plates, 2 mm.")

    def test_every_chat_has_both_tools(self):
        for name, ask in self.chats():
            with self.subTest(chat=name):
                llm, seen = _scripted(ANSWER)
                ask("hello", llm)
                self.assertIn("set_project_parameter", seen[0]["tools"])
                self.assertIn("propose_brief_edit", seen[0]["tools"])

    def test_a_parameter_comes_back_with_an_answer(self):
        for name, ask in self.chats():
            with self.subTest(chat=name):
                llm, seen = _scripted(calls(("arm_od", 16, "mm")), ANSWER)
                r = ask("add arm_od 16 mm to the project", llm)
                self.assertEqual(r["kind"], "answer")
                self.assertEqual(r["parameter_proposals"], [{"name": "arm_od", "value": 16, "unit": "mm",
                                                             "description": "", "reason": "pasted"}])
                self.assertIn('proposed project parameter PP["arm_od"]', seen[1]["turns"][1]["content"][0]["content"])
                self.assertNothingSaved()

    def test_a_brief_proposal_comes_back(self):
        for name, ask in self.chats():
            with self.subTest(chat=name):
                llm, _ = _scripted(brief("Carbon fibre plates, 2 mm. 16 mm arm tubes."), ANSWER)
                r = ask("remember the arms are 16 mm tubes", llm)
                self.assertEqual(r["brief_proposal"], {"text": "Carbon fibre plates, 2 mm. 16 mm arm tubes.",
                                                       "reason": "the arms"})
                self.assertNothingSaved()

    def test_a_pasted_list_comes_back_as_one_proposal(self):
        pasted = "\n".join(f"{n} {v} {u}".strip() for n, v, u in PASTED)
        for name, ask in self.chats():
            with self.subTest(chat=name):
                # the model proposes them over two turns; the user still gets one card
                llm, _ = _scripted(calls(*PASTED[:3]), calls(*PASTED[3:]), ANSWER)
                r = ask(f"add these to the project:\n{pasted}", llm)
                self.assertEqual([(p["name"], p["value"], p["unit"]) for p in r["parameter_proposals"]], PASTED)
                self.assertNothingSaved()

    def test_a_proposal_alongside_the_final_reply_counts_too(self):
        side = [{"id": "s", "name": "set_project_parameter",
                 "input": {"name": "arm_od", "value": 16, "unit": "mm", "reason": "r"}},
                {"id": "b", "name": "propose_brief_edit", "input": {"new_text": "New", "reason": "r"}}]
        for name, ask in self.chats():
            with self.subTest(chat=name):
                llm, _ = _scripted({**ANSWER, "side": side})
                r = ask("arm_od is 16", llm)
                self.assertEqual([p["name"] for p in r["parameter_proposals"]], ["arm_od"])
                self.assertEqual(r["brief_proposal"]["text"], "New")

    def test_the_drawn_chat_knows_its_limit_is_only_the_drawing(self):
        llm, seen = _scripted(ANSWER)
        sketch_chat(self.drawn, "add prop_d 406.4 mm", llm=llm)
        system = seen[0]["system"]
        self.assertIn("You can't change drawn shapes", system)
        self.assertIn("That limit is only the drawing", system)
        self.assertIn("PROJECT TOOLS", system)

    def test_a_generated_sketch_edit_reads_parameters_it_proposes(self):
        code = LAYOUT.replace('PP["w"]', 'PP["plate_w"]')
        llm, _ = _scripted(calls(("plate_w", 120, "mm"), ("tip_gap", 20, "mm")),
                           {"kind": "edit", "code": code, "note": "wider", "usage": {}, "side": []})
        r = sketch_chat(self.layout, "make the plate width a project parameter, 120", llm=llm)
        self.assertTrue(r["result"]["ok"], r["result"])
        self.assertEqual(r["result"]["reads"]["plate_w"], 120)
        self.assertEqual([p["name"] for p in r["parameter_proposals"]], ["plate_w", "tip_gap"])
        self.assertNothingSaved()

    def test_a_drawn_sketch_outside_a_project_has_no_project_tools(self):
        loose = Document.objects.create(name="Loose", created_by=self.user, data={
            "type": "sketch", "sketches": [{"id": "d1", "name": "Sketch 1", "entities": [], "constraints": []}]})
        llm, seen = _scripted(ANSWER)
        sketch_chat(loose, "hello", llm=llm)
        self.assertNotIn("set_project_parameter", seen[0]["tools"])
        self.assertNotIn("propose_brief_edit", seen[0]["tools"])


class PartEditParameterTests(ProjectToolsInEveryChat):
    """A part edit may read the project's parameters and those it proposes;
    any other PP["name"] is refused before anything is saved."""
    def edit(self, *replies):
        llm, seen = _scripted(*replies)
        return edit_script(PART, "thicker", document_id=str(self.part.id), llm=llm), seen

    def code(self, extra):
        return PART.rstrip("\n") + extra + "\n"

    def test_a_project_parameter_or_a_proposed_one_is_defined(self):
        r, _ = self.edit({"kind": "edit", "code": self.code(' + Pos(0, 0, PP["thick"]) * Box(1, 1, 1)'),
                          "note": "ok", "usage": {}, "side": []})
        self.assertEqual(r["kind"], "edit")
        r, seen = self.edit(calls(("boss_h", 4, "mm")),
                            {"kind": "edit", "code": self.code(' + Pos(0, 0, PP["boss_h"]) * Box(1, 1, 1)'),
                             "note": "ok", "usage": {}, "side": []})
        self.assertEqual((r["kind"], len(seen)), ("edit", 2))
        self.assertEqual(r["parameter_proposals"][0]["name"], "boss_h")

    def test_an_unknown_project_parameter_is_refused(self):
        bad = {"kind": "edit", "code": self.code(' + Pos(0, 0, PP["plate_t"]) * Box(1, 1, 1)'),
               "note": "x", "usage": {}, "side": []}
        with self.assertRaisesRegex(AssistantError, r'PP\["plate_t"\], which isn\'t defined'):
            self.edit(bad, bad)
        self.assertNothingSaved()
