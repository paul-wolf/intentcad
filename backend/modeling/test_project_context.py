from unittest import mock

from django.test import Client, TestCase

from accounts.models import Organisation, User
from documents.models import Document
from modeling import llm_models
from modeling.assistant import AssistantError, edit_script, prose_reply
from modeling.project_context import code_sha, find_document, project_context, read_part
from projects.models import Project, ProjectBriefVersion

PLATE = ('P = dict(w=120, d=80, thick=2, hole_d=3.2, hole_dx=30.5, hole_dy=30.5, arm_hole=3.2)\n'
         'part = Box(P["w"], P["d"], P["thick"])\n')
BUILD = {"bbox_min": [-60, -40, -1], "bbox_max": [60, 40, 1], "code_sha": code_sha(PLATE),
         "summary": "bbox: min (-60, -40, -1) max (60, 40, 1)\nCYLINDRICAL faces (holes/bosses/rounds):\n"
                    "  r=1.6 (dia 3.2) axis (0, 0, 1) center (15.25, 15.25, 0) hole"}


def part(name, project, code=PLATE, **kw):
    return Document.objects.create(name=name, project=project, data={"type": "part", "modelCode": code}, **kw)


class ProjectWorld(TestCase):
    def setUp(self):
        self.org = Organisation.objects.create(name="Org", slug="org")
        self.user = User.objects.create_user(username="u", email="u@example.com", password="pw", organisation=self.org)
        self.drone = Project.objects.create(name="Drone", organisation=self.org, created_by=self.user,
                                            brief="Carbon fibre plates, 2 mm. M3 hardware throughout.")
        self.top = part("Top plate", self.drone, description="carries the flight controller")
        self.bottom = part("Bottom plate", self.drone, description="battery side", last_build=BUILD)
        self.brace = part("Arm brace", self.drone)
        self.sketch = Document.objects.create(name="Arm outline", project=self.drone, data={
            "type": "sketch", "sketches": [{"id": "s", "entities": [
                {"id": "c1", "type": "circle", "center": {"x": 0, "y": 0}, "radius": 1.6},
                {"id": "r1", "type": "rectangle", "center": {"x": 0, "y": 0}, "width": 30, "height": 10}]}]})
        other = Project.objects.create(name="Boat", organisation=self.org, created_by=self.user,
                                       brief="Marine ply only")
        self.hull = part("Hull plate", other, code='P = dict(secret_len=999)\npart = Box(1, 1, 1)\n')


class ProjectContextTests(ProjectWorld):
    def test_has_the_brief_and_the_other_parts_but_not_other_projects(self):
        text = project_context(str(self.top.id))
        self.assertIn("PROJECT BRIEF", text)
        self.assertIn("Carbon fibre plates, 2 mm.", text)
        self.assertLess(text.index("PROJECT BRIEF"), text.index("PROJECT PARTS"))
        self.assertIn('"Bottom plate" [part, id ', text)
        self.assertIn("battery side; size 120 × 80 × 2 mm", text)
        self.assertIn("key parameters: w=120, d=80, thick=2, hole_d=3.2, hole_dx=30.5, hole_dy=30.5 (+1 more)", text)
        self.assertIn('"Arm brace" [part', text)
        self.assertIn("not built yet", text)
        self.assertIn('"Arm outline" [sketch', text)
        self.assertIn("1 circle, 1 rectangle", text)
        # not this part, not another project's, never a script
        self.assertNotIn('"Top plate" [', text)
        self.assertNotIn("Hull plate", text)
        self.assertNotIn("Marine ply", text)
        self.assertNotIn("secret_len", text)
        self.assertNotIn("Box(", text)

    def test_nothing_outside_a_project(self):
        loose = Document.objects.create(name="Loose", data={"type": "part", "modelCode": PLATE})
        self.assertEqual(project_context(str(loose.id)), "")
        self.assertEqual(project_context("not-an-id"), "")

    def test_no_brief_block_when_the_brief_is_empty(self):
        self.drone.brief = "  "
        self.drone.save()
        text = project_context(str(self.top.id))
        self.assertNotIn("PROJECT BRIEF", text)
        self.assertIn("PROJECT PARTS", text)


class ReadPartTests(ProjectWorld):
    def test_finds_by_name_id_prefix_or_words(self):
        me = str(self.top.id)
        self.assertEqual(find_document(me, "Bottom plate")[0], self.bottom)
        self.assertEqual(find_document(me, "bottom PLATE")[0], self.bottom)
        self.assertEqual(find_document(me, str(self.bottom.id)[:8])[0], self.bottom)
        self.assertEqual(find_document(me, "@brace")[0], self.brace)

    def test_ambiguous_and_missing_names_say_why(self):
        doc, why = find_document(str(self.top.id), "plate")
        self.assertIsNone(doc)
        self.assertIn("more than one", why)
        self.assertIn('"Bottom plate"', why)
        doc, why = find_document(str(self.top.id), "Hull plate")   # another project's part
        self.assertIsNone(doc)
        self.assertIn("No part or sketch called", why)
        self.assertNotIn("Hull", why.split("It has:")[1])

    def test_script_parameters_and_summary(self):
        me = str(self.top.id)
        script = read_part(me, "Bottom plate", "script")
        self.assertIn('part = Box(P["w"], P["d"], P["thick"])', script)
        params = read_part(me, "Bottom plate", "parameters")
        self.assertIn("arm_hole=3.2", params)
        summary = read_part(me, "Bottom plate", "summary")
        self.assertIn("battery side", summary)
        self.assertIn("dia 3.2", summary)   # the saved build: its script hasn't changed, so no rebuild

    def test_summary_builds_a_part_that_was_never_built_and_keeps_it(self):
        out = read_part(str(self.top.id), "Arm brace", "summary")
        self.assertIn("Geometry of its latest build", out)
        self.assertIn("size (120, 80, 2)", out)
        self.brace.refresh_from_db()
        self.assertEqual(self.brace.last_build["bbox_max"], [60.0, 40.0, 1.0])
        updated = self.brace.updated_at
        read_part(str(self.top.id), "Arm brace", "summary")   # now from last_build
        self.brace.refresh_from_db()
        self.assertEqual(self.brace.updated_at, updated)

    def test_a_sketch_lists_its_shapes(self):
        out = read_part(str(self.top.id), "Arm outline", "summary")
        self.assertIn("circle centre (0, 0) dia 3.2", out)
        self.assertIn("rectangle 30 × 10 centre (0, 0)", out)
        self.assertIn("A sketch has no script", read_part(str(self.top.id), "Arm outline", "script"))

    def test_cannot_read_another_projects_part_even_by_id(self):
        out = read_part(str(self.top.id), str(self.hull.id), "script")
        self.assertNotIn("secret_len", out)


def _scripted(*replies):
    """A fake llm that returns `replies` in turn and records each call."""
    calls = []

    def llm(system, user, tools, turns=None):
        calls.append({"system": system, "user": user, "tools": [t["name"] for t in tools], "turns": turns or []})
        return replies[len(calls) - 1]
    return llm, calls


def tool_call(name, i="t1", **args):
    return {"kind": "tool", "calls": [{"id": i, "name": name, "input": args}],
            "content": [{"type": "tool_use", "id": i, "name": name, "input": args}], "usage": {}}


class EditWithProjectTests(ProjectWorld):
    def setUp(self):
        super().setUp()
        llm_models._cache.update(at=9e12, value={
            "models": llm_models.select([{"id": "claude-opus-5-5", "created_at": "2026-01-01T00:00:00Z"}]),
            "default": "claude-opus-5-5", "source": "live"})

    def tearDown(self):
        llm_models._cache.update(at=0.0, value=None)

    def test_answers_through_read_part(self):
        llm, calls = _scripted(
            tool_call("read_part", part="Bottom plate", what="summary"),
            {"kind": "answer", "text": "Four M3 holes on a 30.5 mm square.", "usage": {}, "side": []})
        r = edit_script(PLATE, "what does the bottom plate's hole pattern look like?",
                        document_id=str(self.top.id), llm=llm)
        self.assertEqual(r["kind"], "answer")
        self.assertEqual(r["answer"], "Four M3 holes on a 30.5 mm square.")
        first, second = calls
        self.assertIn("read_part", first["tools"])
        self.assertIn("propose_brief_edit", first["tools"])
        self.assertIn("THE PROJECT", first["system"])
        self.assertTrue(first["user"].startswith("PROJECT BRIEF"))
        self.assertEqual(first["turns"], [])
        assistant, results = second["turns"]
        self.assertEqual(assistant["role"], "assistant")
        [res] = results["content"]
        self.assertEqual(res["tool_use_id"], "t1")
        self.assertIn("dia 3.2", res["content"])

    def test_the_real_call_gets_the_lookup_turns(self):
        seen = []

        def api(system, user, tools, model, turns=None):
            seen.append(turns or [])
            return (tool_call("read_part", part="Arm brace", what="parameters") if len(seen) == 1
                    else {"kind": "answer", "text": "pitch 44", "usage": {}, "side": []})
        with mock.patch("modeling.assistant._anthropic_call", side_effect=api):
            r = edit_script(PLATE, "what is the brace's hole pitch?", document_id=str(self.top.id))
        self.assertEqual(r["answer"], "pitch 44")
        self.assertEqual(len(seen[1]), 2)
        self.assertIn("arm_hole=3.2", seen[1][1]["content"][0]["content"])

    def test_a_question_with_no_question_in_it_is_an_answer(self):
        llm, _ = _scripted({"kind": "question", "question": "- **Stack:** 30.5 mm square.", "usage": {}, "side": []})
        r = edit_script(PLATE, "what's the stack pattern?", document_id=str(self.top.id), llm=llm)
        self.assertEqual((r["kind"], r["answer"]), ("answer", "- **Stack:** 30.5 mm square."))
        llm, _ = _scripted({"kind": "question", "question": "Which face, top or bottom?", "usage": {}, "side": []})
        r = edit_script(PLATE, "add a hole", document_id=str(self.top.id), llm=llm)
        self.assertEqual(r["kind"], "question")

    def test_a_reply_in_prose_with_no_tool_call_is_an_answer(self):
        # with thinking on, the model often answers in plain text instead of calling answer
        self.assertEqual(prose_reply("  The plate is 80 × 80 mm.\n"), {"kind": "answer", "text": "The plate is 80 × 80 mm."})
        self.assertEqual(prose_reply("Do you want them countersunk?"),
                         {"kind": "question", "question": "Do you want them countersunk?"})

    def test_a_brief_proposal_comes_back_and_the_brief_is_unchanged(self):
        llm, _ = _scripted(
            tool_call("propose_brief_edit", new_text="Carbon fibre plates, 2 mm. M3 hardware. 30 mm tubes.",
                      reason="added the arm tubes"),
            {"kind": "answer", "text": "Noted the tubes.", "usage": {}, "side": []})
        r = edit_script(PLATE, "the arms are 30 mm carbon tubes", document_id=str(self.top.id), llm=llm)
        self.assertEqual(r["brief_proposal"], {"text": "Carbon fibre plates, 2 mm. M3 hardware. 30 mm tubes.",
                                               "reason": "added the arm tubes"})
        self.drone.refresh_from_db()
        self.assertEqual(self.drone.brief, "Carbon fibre plates, 2 mm. M3 hardware throughout.")
        self.assertFalse(ProjectBriefVersion.objects.exists())

    def test_a_proposal_alongside_the_final_reply_counts_too(self):
        side = [{"id": "p", "name": "propose_brief_edit", "input": {"new_text": "New", "reason": "r"}}]
        llm, _ = _scripted({"kind": "answer", "text": "ok", "usage": {}, "side": side})
        r = edit_script(PLATE, "remember M3", document_id=str(self.top.id), llm=llm)
        self.assertEqual(r["brief_proposal"]["text"], "New")

    def test_mentions_attach_the_part_summary(self):
        llm, calls = _scripted({"kind": "answer", "text": "ok", "usage": {}, "side": []})
        edit_script(PLATE, "match @Bottom plate", document_id=str(self.top.id),
                    mentions=[str(self.bottom.id), str(self.hull.id)], llm=llm)
        user = calls[0]["user"]
        self.assertIn("MENTIONED PARTS", user)
        self.assertIn("dia 3.2", user)
        self.assertNotIn("Hull", user)
        self.assertLess(user.index("MENTIONED PARTS"), user.index("INSTRUCTION:"))

    def test_lookups_are_capped(self):
        llm, _ = _scripted(*[tool_call("read_part", i=f"t{n}", part="Arm outline", what="summary") for n in range(10)])
        with self.assertRaises(AssistantError):
            edit_script(PLATE, "look at everything", document_id=str(self.top.id), llm=llm)

    def test_outside_a_project_no_project_tools(self):
        loose = Document.objects.create(name="Loose", data={"type": "part", "modelCode": PLATE})
        llm, calls = _scripted({"kind": "answer", "text": "ok", "usage": {}, "side": []})
        edit_script(PLATE, "what is this?", document_id=str(loose.id), llm=llm)
        self.assertEqual(calls[0]["tools"], ["write_script", "ask_clarification", "answer"])
        self.assertNotIn("THE PROJECT", calls[0]["system"])


class BriefApiTests(ProjectWorld):
    def setUp(self):
        super().setUp()
        self.client = Client()
        self.client.force_login(self.user)

    def put(self, text, label="", project=None):
        return self.client.put(f"/api/projects/{(project or self.drone).id}/brief",
                               {"text": text, "label": label}, content_type="application/json")

    def test_save_keeps_each_text_as_a_version(self):
        r = self.put("v1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["brief"], "v1")
        self.assertIsNotNone(r.json()["brief_updated_at"])
        self.put("v1")                                 # unchanged: no new version
        self.put("v2", "AI proposal: added tubes")
        versions = self.client.get(f"/api/projects/{self.drone.id}/brief/versions").json()
        self.assertEqual([(v["text"], v["label"]) for v in versions], [("v2", "AI proposal: added tubes"), ("v1", "")])
        self.assertEqual(versions[0]["created_by"], "u")

    def test_another_organisation_cannot_read_or_save(self):
        other = Organisation.objects.create(name="Other", slug="other")
        outsider = User.objects.create_user(username="o", email="o@example.com", password="pw", organisation=other)
        self.client.force_login(outsider)
        self.assertEqual(self.put("hijack").status_code, 403)
        self.assertEqual(self.client.get(f"/api/projects/{self.drone.id}/brief/versions").status_code, 403)

    def test_description_saves_without_moving_updated_at(self):
        before = self.top.updated_at
        r = self.client.put(f"/api/documents/{self.top.id}/description",
                            {"description": "  carries\nthe FC  "}, content_type="application/json")
        self.assertEqual(r.status_code, 200)
        self.top.refresh_from_db()
        self.assertEqual(self.top.description, "carries the FC")
        self.assertEqual(self.top.updated_at, before)

    def test_a_build_through_the_api_is_remembered(self):
        with mock.patch("modeling.api.run_script", return_value={
                "mesh": {"positions": [], "normals": [], "triangle_count": 0}, "faces": [], "edges": [],
                "params": {}, "metrics": {"volume": 1, "area": 1, "bbox_min": [0, 0, 0],
                                          "bbox_max": [10, 20, 2], "solids": 1}}):
            r = self.client.post("/api/build/run", {"code": PLATE, "document_id": str(self.brace.id)},
                                 content_type="application/json")
        self.assertEqual(r.status_code, 200)
        self.brace.refresh_from_db()
        self.assertEqual(self.brace.last_build["bbox_max"], [10, 20, 2])
        self.assertIn("size 10 × 20 × 2 mm", project_context(str(self.top.id)))
