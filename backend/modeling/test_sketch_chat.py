"""The sketch chat: what it sees (the project, the sketch's code and last run
or its drawn shapes, which parts use which outputs), what it may do in a
generated sketch (new code, run but not saved, one retry) and in a drawn one
(answer, or offer a generated sketch), and who may use it. The project tools
every chat shares are tested in test_chat_project_tools."""
import json
from unittest import mock

from django.test import Client

from accounts.models import Organisation, User
from documents.models import Document

from . import llm_models
from .assistant import AssistantError
from .sketch_chat import sketch_chat
from .test_generated_sketch import LAYOUT, GeneratedWorld
from .test_project_context import _scripted

WIDER = LAYOUT.replace('check("hole edge"', 'check("wide enough", w >= 50)\ncheck("hole edge"')
NO_HOLES = "\n".join(line for line in LAYOUT.splitlines() if "holes" not in line) + "\n"
BOARD = 'output("board", Rectangle(PP["board_w"], 30))\n'


def edit(code, note="changed"):
    return {"kind": "edit", "code": code, "note": note, "usage": {}, "side": []}


class SketchChatWorld(GeneratedWorld):
    def setUp(self):
        super().setUp()
        self.drone.brief = "Carbon fibre plates, 2 mm."
        self.drone.save()
        llm_models._cache.update(at=9e12, value={
            "models": llm_models.select([{"id": "claude-opus-5-5", "created_at": "2026-01-01T00:00:00Z"}]),
            "default": "claude-opus-5-5", "source": "live"})
        self.layout.refresh_from_db()

    def tearDown(self):
        llm_models._cache.update(at=0.0, value=None)


class GeneratedChatTests(SketchChatWorld):
    def test_it_sees_the_project_the_code_its_last_run_and_who_uses_what(self):
        llm, calls = _scripted({"kind": "answer", "text": "It is 100 wide.", "usage": {}, "side": []})
        r = sketch_chat(self.layout, "how wide is the plate?", history=[{"role": "user", "text": "hello"}], llm=llm)
        self.assertEqual((r["kind"], r["answer"]), ("answer", "It is 100 wide."))
        [c] = calls
        self.assertTrue(c["user"].startswith("PROJECT BRIEF"))
        self.assertIn("Carbon fibre plates", c["user"])
        self.assertIn("PROJECT PARAMETERS", c["user"])
        self.assertIn('"Top plate"', c["user"])                 # PROJECT PARTS
        self.assertIn(LAYOUT, c["user"])                         # CURRENT CODE
        self.assertIn("plate (100 × 60 mm, the outline)", c["user"])
        self.assertIn("check PASSES fits the bed: 100 mm", c["user"])
        self.assertIn("read parameters: w=100", c["user"])
        self.assertIn('- "Plate" as SK[\'layout\']: outputs holes, plate', c["user"])
        self.assertIn("USER: hello", c["user"])
        self.assertEqual(c["tools"], ["write_code", "ask_clarification", "answer", "read_part",
                                      "set_project_parameter", "propose_brief_edit"])
        self.assertIn("GENERATED SKETCH", c["system"])
        self.assertIn("check()", c["system"])

    def test_an_edit_is_run_but_not_saved(self):
        llm, _ = _scripted(edit(WIDER, "added a width check"))
        r = sketch_chat(self.layout, "check it's at least 50 wide", llm=llm)
        self.assertEqual(r["kind"], "edit")
        self.assertEqual(r["code"], WIDER)
        self.assertTrue(r["result"]["ok"])
        self.assertIn("wide enough", [c["name"] for c in r["result"]["checks"]])
        self.assertEqual(r["broken"], [])
        self.layout.refresh_from_db()
        self.assertEqual(self.layout.data["code"], LAYOUT)

    def test_it_says_which_outputs_parts_use_would_go(self):
        llm, _ = _scripted(edit(NO_HOLES))
        r = sketch_chat(self.layout, "drop the holes", llm=llm)
        self.assertEqual(r["broken"], [{"name": "holes", "parts": ["Plate"]}])

    def test_code_that_fails_gets_one_retry_with_the_error(self):
        llm, calls = _scripted(edit('output("plate", Rectangle(PP["nope"], 2))\n'), edit(WIDER))
        r = sketch_chat(self.layout, "change it", llm=llm)
        self.assertEqual(r["code"], WIDER)
        self.assertIn("Your code failed to run (line 1)", calls[1]["user"])
        self.assertIn("nope", calls[1]["user"])

    def test_code_that_fails_twice_is_an_error(self):
        bad = edit("1 / 0\n")
        llm, _ = _scripted(bad, bad)
        with self.assertRaises(AssistantError):
            sketch_chat(self.layout, "change it", llm=llm)

    def test_a_proposed_project_parameter_is_run_with_its_value(self):
        args = {"name": "board_w", "value": 36, "unit": "mm", "reason": "the FC board"}
        call = {"kind": "tool", "calls": [{"id": "t1", "name": "set_project_parameter", "input": args}],
                "content": [], "usage": {}}
        llm, _ = _scripted(call, edit(BOARD))
        r = sketch_chat(self.layout, "add the flight controller board", llm=llm)
        self.assertTrue(r["result"]["ok"], r["result"])
        self.assertEqual(r["result"]["outputs"][0]["size"], "36 × 30 mm")
        self.assertEqual([p["name"] for p in r["parameter_proposals"]], ["board_w"])
        self.drone.refresh_from_db()
        self.assertNotIn("board_w", [p["name"] for p in self.drone.parameters])

    def test_an_error_in_the_last_run_is_in_the_prompt(self):
        self.save_code("plate = Rectangle(PP['w'], 2)\n1 / 0\n")
        self.layout.refresh_from_db()
        llm, calls = _scripted({"kind": "answer", "text": "ok", "usage": {}, "side": []})
        sketch_chat(self.layout, "why is it dimmed?", llm=llm)
        self.assertIn("ERROR at line 2", calls[0]["user"])
        self.assertIn("plate (100 × 60 mm", calls[0]["user"])     # the last good run's outputs


class DrawnChatTests(SketchChatWorld):
    def drawn(self, entities):
        return Document.objects.create(name="Drawn", project=self.drone, created_by=self.user, data={
            "type": "sketch", "sketches": [{"id": "d1", "name": "Sketch 1", "entities": entities, "constraints": []}]})

    def test_it_can_only_answer_or_offer_a_generated_sketch(self):
        doc = self.drawn([{"id": "c", "type": "circle", "center": {"x": 5, "y": 0}, "radius": 1.6}])
        llm, calls = _scripted({"kind": "answer", "text": "I can't move drawn shapes.", "usage": {}, "side": []})
        r = sketch_chat(doc, "move the hole left", llm=llm)
        self.assertEqual(r["kind"], "answer")
        [c] = calls
        self.assertEqual(c["tools"], ["propose_generated", "ask_clarification", "answer", "read_part",
                                      "set_project_parameter", "propose_brief_edit"])
        self.assertIn("You can't change drawn shapes", c["system"])
        self.assertIn('THIS SKETCH: "Drawn", drawn.', c["user"])
        self.assertIn("circle centre (5, 0) dia 3.2", c["user"])
        self.assertIn("USED BY:\nno part uses it yet", c["user"])

    def test_a_proposal_comes_with_its_run(self):
        doc = self.drawn([])
        llm, calls = _scripted({"kind": "proposal", "sentence": "I'll make this a generated sketch: a plate from w.",
                                "name": "Frame layout", "code": LAYOUT, "usage": {}, "side": []})
        r = sketch_chat(doc, "a plate as wide as w", llm=llm)
        self.assertIn("EMPTY", calls[0]["user"])
        self.assertEqual((r["kind"], r["name"], r["empty"]), ("proposal", "Frame layout", True))
        self.assertTrue(r["result"]["ok"])
        self.assertEqual(r["result"]["reads"], {"w": 100})
        doc.refresh_from_db()
        self.assertNotIn("source", doc.data)


class AskEndpointTests(SketchChatWorld):
    def ask(self, client, doc, body):
        return client.post(f"/api/sketches/{doc.id}/ask", content_type="application/json",
                           data=json.dumps({"instruction": "how wide?", **body}))

    def test_it_replies_and_logs_the_spend(self):
        reply = {"kind": "answer", "text": "100 mm.", "side": [],
                 "usage": {"input": 1000, "output": 20, "cache_read": 0, "cache_write": 0}}
        with mock.patch("modeling.sketch_chat._anthropic_call", return_value=reply) as call:
            r = self.ask(self.client, self.layout, {"history": [{"role": "user", "text": "hi"}],
                                                    "mentions": [str(self.plate.id)]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["kind"], r.json()["answer"]), ("answer", "100 mm."))
        self.assertNotIn("cost_usd", r.json())                  # spend is for staff
        prompt = call.call_args.args[1]
        self.assertIn("USER: hi", prompt)
        self.assertIn("MENTIONED PARTS", prompt)
        from .models import AiEdit
        self.assertEqual(AiEdit.objects.get().document_id, str(self.layout.id))

    def test_an_edit_says_what_it_was_made_from(self):
        """base_code: the code the AI edited; base_version: the saved code's
        version when asked (PUT /code's expect_version)."""
        from documents.versions import code_version
        with mock.patch("modeling.sketch_chat._anthropic_call", return_value=edit(WIDER)):
            r = self.ask(self.client, self.layout, {"instruction": "check the width"}).json()
        self.assertEqual((r["kind"], r["base_code"], r["base_version"]), ("edit", LAYOUT, code_version(LAYOUT)))

    def test_ask_again_on_unsaved_code(self):
        """With `code`, the AI edits the editor's unsaved code; nothing is saved."""
        from documents.versions import code_version
        mine = LAYOUT + "# mine\n"
        with mock.patch("modeling.sketch_chat._anthropic_call", return_value=edit(WIDER + "# mine\n")) as call:
            r = self.ask(self.client, self.layout, {"instruction": "check the width", "code": mine}).json()
        self.assertIn("# mine", call.call_args.args[1])
        self.assertEqual((r["base_code"], r["base_version"]), (mine, code_version(LAYOUT)))
        self.layout.refresh_from_db()
        self.assertEqual(self.layout.data["code"], LAYOUT)

    def test_an_answer_has_no_base(self):
        with mock.patch("modeling.sketch_chat._anthropic_call",
                        return_value={"kind": "answer", "text": "100 mm.", "side": [], "usage": {}}):
            r = self.ask(self.client, self.layout, {}).json()
        self.assertNotIn("base_version", r)

    def test_an_ai_edit_isnt_saved_over_code_saved_meanwhile(self):
        from documents.versions import code_version
        asked = code_version(LAYOUT)
        self.save_code(LAYOUT + "# from another tab\n")
        r = self.save_code(WIDER, expect_version=asked)
        self.assertEqual((r["saved"], r["changed"]), (False, True))
        self.layout.refresh_from_db()
        self.assertEqual(self.layout.data["code"], LAYOUT + "# from another tab\n")
        # with the saved code's version, it saves
        r = self.save_code(WIDER, expect_version=code_version(LAYOUT + "# from another tab\n"))
        self.assertTrue(r["saved"])

    def test_a_stranger_cant_ask(self):
        other = Organisation.objects.create(name="Other", slug="other")
        stranger = Client()
        stranger.force_login(User.objects.create_user(username="x", email="x@example.com", password="pw",
                                                      organisation=other))
        with mock.patch("modeling.sketch_chat._anthropic_call") as call:
            self.assertEqual(self.ask(stranger, self.layout, {}).status_code, 403)
            self.assertEqual(self.ask(stranger, self.holes, {}).status_code, 403)
        call.assert_not_called()
