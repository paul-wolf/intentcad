import json

from django.test import Client, TestCase

from accounts.models import Organisation, User
from documents.models import Document
from projects.models import Project


class CamProfileAPITests(TestCase):
    def setUp(self):
        self.client = Client()
        self.org = Organisation.objects.create(name="Test Org", slug="test-org")
        self.user = User.objects.create_user(
            username="testuser",
            email="test@example.com",
            password="testpass123",
            organisation=self.org,
        )
        self.project = Project.objects.create(
            name="Test Project", organisation=self.org, created_by=self.user,
        )
        self.doc = Document.objects.create(name="Part", project=self.project, created_by=self.user)
        self.client.force_login(self.user)

    def _create(self, document_id, name="Router"):
        return self.client.post(
            "/api/cam/profiles/",
            data=json.dumps({
                "name": name,
                "config": {"tool": {"diameter": 3.175, "type": "flat"}},
                "document_id": str(document_id),
            }),
            content_type="application/json",
        )

    def test_new_profile_is_in_the_documents_project_and_listed(self):
        resp = self._create(self.doc.id)
        self.assertEqual(resp.status_code, 201)
        resp = self.client.get("/api/cam/profiles/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([p["name"] for p in resp.json()], ["Router"])

    def test_refuses_a_document_in_another_organisations_project(self):
        other_org = Organisation.objects.create(name="Other", slug="other")
        other_user = User.objects.create_user(
            username="other", email="other@example.com", password="testpass123", organisation=other_org,
        )
        other_project = Project.objects.create(name="Theirs", organisation=other_org, created_by=other_user)
        other_doc = Document.objects.create(name="Their part", project=other_project, created_by=other_user)
        resp = self._create(other_doc.id)
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(self.client.get("/api/cam/profiles/").json(), [])

    def test_refuses_a_document_without_a_project(self):
        loose = Document.objects.create(name="Loose", created_by=self.user)
        resp = self._create(loose.id)
        self.assertEqual(resp.status_code, 400)


MACHINE_V2 = {
    "name": "Shapeoko",
    "post": {"dialect": "grbl"},
    "maxRpm": 24000, "rapidRate": 5000, "safeZ": 5, "clearanceZ": 15, "spoilboardAllowance": 0.3,
    "toolChange": "M0", "coolant": "none",
    "tools": [{"id": "t1", "number": 1, "name": "6mm flat", "type": "flat", "diameter": 6}],
    "presets": [{"toolId": "t1", "material": "mdf", "rpm": 18000, "chipLoad": 0.05}],
}

JOB_V2 = {
    "version": 2,
    "setup": {
        "material": "mdf", "stock": {"width": 300, "height": 200, "thickness": 12},
        "clamps": [{"id": "c1", "x": 0, "y": 0, "width": 20, "height": 20, "zHeight": 10}],
    },
    "operations": [{"id": "op1", "kind": "profile", "entityIds": ["e1"], "overrides": {"depth": 12}}],
    "thread": [],
    "migrationNotes": [],
}


class ValidatorV2Tests(TestCase):
    def test_a_v2_profile_is_accepted(self):
        from cam.validators import validate_cam_profile_config
        self.assertEqual(validate_cam_profile_config({"version": 2, "machine": MACHINE_V2}), [])
        self.assertEqual(validate_cam_profile_config({"version": 2, "machine": {**MACHINE_V2, "defaultMaterial": "carbon-fibre"}}), [])

    def test_a_v2_profile_with_a_bad_dialect_tool_change_or_tool_is_refused(self):
        from cam.validators import validate_cam_profile_config
        for change, field in (
            ({"post": {"dialect": "fanuc"}}, "dialect"),
            ({"toolChange": "M99"}, "toolChange"),
            ({"tools": [{"type": "flat", "diameter": 0}]}, "diameter"),
            ({"tools": [{"type": "laser", "diameter": 3}]}, "type"),
            ({"safeZ": 0}, "safeZ"),
            ({"safeZ": 10, "clearanceZ": 5}, "clearanceZ"),
            ({"spoilboardAllowance": 9}, "spoilboardAllowance"),
            ({"maxRpm": "fast"}, "maxRpm"),
            ({"defaultMaterial": "balsa"}, "defaultMaterial"),
        ):
            errors = validate_cam_profile_config({"version": 2, "machine": {**MACHINE_V2, **change}})
            self.assertTrue(any(field in e for e in errors), (change, errors))
        self.assertTrue(validate_cam_profile_config({"version": 2, "machine": "x"}))
        self.assertTrue(validate_cam_profile_config({"version": 3}))

    def test_a_v1_profile_is_still_accepted(self):
        from cam.validators import validate_cam_profile_config
        v1 = {"tool": {"diameter": 3.175, "type": "flat"}, "postProcessor": {"dialect": "grbl"}}
        self.assertEqual(validate_cam_profile_config(v1), [])
        self.assertTrue(validate_cam_profile_config({"postProcessor": {"dialect": "fanuc"}}))

    def test_a_v2_job_is_accepted(self):
        from cam.validators import validate_cam_job_config
        self.assertEqual(validate_cam_job_config(JOB_V2), [])

    def test_a_v2_job_with_a_bad_op_stock_or_clamp_is_refused(self):
        from cam.validators import validate_cam_job_config
        bad_kind = {**JOB_V2, "operations": [{"kind": "laser"}]}
        self.assertTrue(any("kind" in e for e in validate_cam_job_config(bad_kind)))
        bad_overrides = {**JOB_V2, "operations": [{"kind": "pocket", "overrides": [1]}]}
        self.assertTrue(any("overrides" in e for e in validate_cam_job_config(bad_overrides)))
        bad_stock = {**JOB_V2, "setup": {"stock": {"thickness": -1}}}
        self.assertTrue(any("thickness" in e for e in validate_cam_job_config(bad_stock)))
        bad_clamp = {**JOB_V2, "setup": {"clamps": [{"x": 0, "y": 0, "width": 1, "height": 1}]}}
        self.assertTrue(any("zHeight" in e for e in validate_cam_job_config(bad_clamp)))

    def test_a_v1_job_is_still_accepted(self):
        from cam.validators import validate_cam_job_config
        v1 = {"operations": [{"kind": "drill"}], "depth": {"totalDepth": 6, "depthPerPass": 2}}
        self.assertEqual(validate_cam_job_config(v1), [])
        self.assertTrue(validate_cam_job_config({"operations": [{"kind": "laser"}]}))


ENTITIES = ["e1", "e2", "c1"]
TOOLS = ["t1", "t2"]
OPS = ["op1", "op2"]


class NormalizeReplyTests(TestCase):
    def norm(self, raw, **kw):
        from cam.chat import normalize_reply
        return normalize_reply(raw, ENTITIES, TOOLS, OPS, **kw)

    def test_a_good_reply_passes_through(self):
        raw = {
            "summary": "  Pocket, then profile.  ",
            "answer": "Done.",
            "choices": ["T2 6mm for the pocket: largest that fits"],
            "assumptions": ["Stock is 12 mm MDF"],
            "setup": {"material": "mdf", "thickness": 12, "width": None, "height": 200,
                      "origin": "front-left", "zZero": "spoilboard"},
            "operations": [{"kind": "pocket", "entityIds": ["e2"], "cutSide": "inside",
                            "overrides": {"toolId": "t2", "depth": 6, "stepover": 0.4}, "reason": "the slot"}],
            "edits": [{"opId": "op1", "overrides": {"tabs": True, "tabCount": 4}, "reset": ["rpm"],
                       "reason": "hold the part"}],
            "remove": ["op2"],
        }
        reply, notes = self.norm(raw)
        self.assertEqual(notes, [])
        self.assertEqual(reply["summary"], "Pocket, then profile.")
        self.assertEqual(reply["setup"], raw["setup"])
        self.assertEqual(reply["operations"], raw["operations"])
        self.assertEqual(reply["edits"], raw["edits"])
        self.assertEqual(reply["remove"], ["op2"])

    def test_garbage_never_raises(self):
        for raw in (None, "plan", 3, [1, 2], {"summary": 5, "choices": "x", "setup": [1],
                    "operations": "op", "edits": {"a": 1}, "remove": 7},
                    {"operations": [None, 1, "x", {"kind": None}, {"kind": "drill", "entityIds": "c1"}],
                     "edits": [None, {"opId": ["op1"]}, {"opId": "op1", "overrides": "x", "reset": "rpm"}],
                     "setup": {"stock": "big", "thickness": "thin", "origin": 5}}):
            reply, notes = self.norm(raw)
            self.assertEqual(set(reply), {"summary", "answer", "choices", "assumptions", "setup",
                                          "operations", "edits", "remove"})
            self.assertTrue(all(isinstance(n, str) for n in notes))
        reply, notes = self.norm(None)
        self.assertEqual(reply["operations"], [])
        self.assertTrue(notes)

    def test_unknown_ids_are_dropped_with_notes(self):
        reply, notes = self.norm({
            "operations": [{"kind": "profile", "entityIds": ["e1", "nope"]},
                           {"kind": "pocket", "entityIds": ["ghost"]},
                           {"kind": "facing", "entityIds": []}],
            "edits": [{"opId": "op9", "overrides": {"depth": 3}}],
            "remove": ["op1", "op9"],
        })
        self.assertEqual([o["kind"] for o in reply["operations"]], ["profile", "facing"])
        self.assertEqual(reply["operations"][0]["entityIds"], ["e1"])
        self.assertEqual(reply["operations"][0]["cutSide"], "outside")
        self.assertEqual(reply["edits"], [])
        self.assertEqual(reply["remove"], ["op1"])
        self.assertTrue(any("nope" in n for n in notes))
        self.assertTrue(any("ghost" in n or "none of its shapes" in n for n in notes))
        self.assertTrue(any("op9" in n for n in notes))

    def test_out_of_range_and_wrong_types_are_dropped(self):
        reply, notes = self.norm({
            "setup": {"thickness": 0, "width": 9000, "material": "steel", "zZero": "floor"},
            "edits": [{"opId": "op1", "overrides": {
                "rpm": 999999, "depth": -1, "toolId": "t9", "tabs": "yes", "tabCount": 2.5,
                "stepover": 0.5, "entry": "dive", "chipLoad": True, "peckDepth": float("nan")}}],
        })
        self.assertEqual(reply["setup"], {})
        self.assertEqual(reply["edits"][0]["overrides"], {"stepover": 0.5})
        for key in ("rpm", "depth", "toolId", "tabs", "tabCount", "entry", "chipLoad", "peckDepth",
                    "thickness", "width", "steel", "floor"):
            self.assertTrue(any(key in n for n in notes), key)

    def test_carbon_fibre_is_a_material(self):
        reply, notes = self.norm({"summary": "x", "setup": {"material": "carbon-fibre", "thickness": 2}})
        self.assertEqual(notes, [])
        self.assertEqual(reply["setup"], {"material": "carbon-fibre", "thickness": 2})

    def test_machine_post_and_feed_keys_are_refused(self):
        reply, notes = self.norm({
            "summary": "x", "safeZ": 2, "postProcessor": {"dialect": "fanuc"}, "machine": {"maxRpm": 1},
            "setup": {"clearanceZ": 1, "material": "mdf"},
            "operations": [{"kind": "profile", "entityIds": ["e1"], "feedRate": 5000,
                            "overrides": {"safeZ": 1, "feedRate": 3000, "depth": 6}}],
            "edits": [{"opId": "op1", "overrides": {"park": [0, 0]}, "reset": ["safeZ"]}],
        })
        self.assertNotIn("safeZ", reply)
        self.assertEqual(reply["setup"], {"material": "mdf"})
        self.assertEqual(reply["operations"][0]["overrides"], {"depth": 6})
        self.assertEqual(reply["edits"], [])
        self.assertIn("Ignored a change to safeZ: the AI can't change machine settings", notes)
        self.assertTrue(any("postProcessor" in n and "post-processor" in n for n in notes))
        self.assertTrue(any("feedRate" in n and "chip load" in n for n in notes))
        self.assertTrue(any("clearanceZ" in n for n in notes))
        self.assertTrue(any("park" in n for n in notes))

    def test_an_override_at_the_wrong_level_moves_into_overrides(self):
        reply, _ = self.norm({"operations": [{"kind": "drill", "entityIds": ["c1"], "holeMethod": "helix"}],
                              "edits": [{"opId": "op2", "depth": 4}]})
        self.assertEqual(reply["operations"][0]["overrides"], {"holeMethod": "helix"})
        self.assertEqual(reply["edits"][0]["overrides"], {"depth": 4})

    def test_an_edit_can_change_the_shapes(self):
        reply, notes = self.norm({"edits": [
            {"opId": "op1", "entityIds": ["c1", "e2", "c1", "ghost"], "reason": "the holes"},
            {"opId": "op2", "entityIds": ["ghost"]},
        ]})
        self.assertEqual(reply["edits"], [{"opId": "op1", "overrides": {}, "reset": [], "reason": "the holes",
                                           "entityIds": ["c1", "e2"]}])
        self.assertIn("Dropped shape ghost from operation 1: no shape has that id", notes)
        self.assertIn("Kept the shapes of operation 2: none of the new ones exist", notes)
        self.assertFalse(any("unknown field" in n for n in notes))

    def test_ids_in_the_text_are_put_in_words(self):
        reply, notes = self.norm(
            {"summary": "Added c1 and e2 to operation op2.", "answer": "op1 cuts e1.",
             "choices": ["T1 for c1"], "edits": [{"opId": "op9", "overrides": {"depth": 3}}]},
            labels={"c1": "the Ø6 circle at (20.0, 20.0)", "e2": "the slot",
                                          "zz": "not a shape"})
        self.assertEqual(reply["summary"], "Added the Ø6 circle at (20.0, 20.0) and the slot to operation 2.")
        self.assertEqual(reply["answer"], "operation 1 cuts e1.")
        self.assertEqual(reply["choices"], ["T1 for the Ø6 circle at (20.0, 20.0)"])
        self.assertIn("Ignored an edit of operation op9: no operation has that id", notes)

    def test_text_and_lists_are_capped(self):
        reply, notes = self.norm({"summary": "s" * 5000, "choices": ["c" * 900] * 30,
                                  "operations": [{"kind": "facing"}] * 25})
        self.assertEqual(len(reply["summary"]), 2000)
        self.assertEqual(len(reply["choices"]), 20)
        self.assertEqual(len(reply["choices"][0]), 500)
        self.assertEqual(len(reply["operations"]), 20)
        self.assertTrue(notes)


SKETCHES = [{"id": "s1", "name": "Plate", "entities": [
    {"id": "e1", "type": "rectangle", "center": {"x": 50, "y": 50}, "width": 100, "height": 80},
    {"id": "c1", "type": "circle", "center": {"x": 20, "y": 20}, "radius": 3},
    {"id": "k1", "type": "line", "construction": True, "points": [{"x": 0, "y": 0}, {"x": 1, "y": 1}]},
]}]

CONTEXT = {
    "setup": {"material": "mdf", "stock": {"width": 120, "height": 100, "thickness": 12}},
    "machine": {"name": "Shapeoko", "maxRpm": 24000, "safeZ": 5},
    "materials": ["birch-ply", "mdf"],
    "tools": [{"id": "t1", "number": 1, "name": "6mm flat", "type": "flat", "diameter": 6, "flutes": 2,
               "fluteLength": 22}],
    "presets": [{"toolId": "t1", "material": "mdf", "rpm": 18000, "chipLoad": 0.05},
                {"toolId": "t1", "material": "acrylic", "rpm": 16000, "chipLoad": 0.04}],
    "plan": [{"id": "op1", "kind": "profile", "entityIds": ["e1"], "cutSide": "outside", "status": "accepted",
              "overrides": {}, "resolved": {"toolId": "t1", "depth": 12}, "problem": None}],
    "issues": [{"severity": "warning", "message": "No tabs on a through cut", "opId": "op1"}],
    "focus_op_id": None,
}


class CamChatAPITests(TestCase):
    def setUp(self):
        self.org = Organisation.objects.create(name="Org", slug="org")
        self.user = User.objects.create_user(username="u", email="u@example.com", password="pw",
                                             organisation=self.org)
        self.project = Project.objects.create(name="P", organisation=self.org, created_by=self.user)
        self.doc = Document.objects.create(name="Part", project=self.project, created_by=self.user)
        self.client = Client()
        self.client.force_login(self.user)
        self.calls = []

    def _post(self, message="", client=None, **extra):
        body = {"document_id": str(self.doc.id), "message": message, "model": None,
                "document_data": {"sketches": SKETCHES}, "context": CONTEXT,
                "history": [{"role": "user", "text": "hi"}, {"role": "ai", "text": "hello"}], **extra}
        return (client or self.client).post("/api/cam/chat", data=json.dumps(body),
                                            content_type="application/json")

    def _fake(self, out):
        def call(system, user, tools, model):
            self.calls.append({"system": system, "user": user, "tools": tools})
            if isinstance(out, Exception):
                raise out
            return {**out, "usage": {"input": 1000, "output": 200, "cache_read": 0, "cache_write": 0}}
        return call

    def _with(self, out, *args, **kwargs):
        from unittest import mock
        with mock.patch("cam.chat._anthropic_call", side_effect=self._fake(out)), \
                mock.patch("cam.chat.list_models", return_value={"default": "claude-opus-test", "models": []}):
            return self._post(*args, **kwargs)

    def test_needs_a_login(self):
        resp = self._post(client=Client())
        self.assertEqual(resp.status_code, 401)

    def test_refuses_another_organisations_document(self):
        other_org = Organisation.objects.create(name="Other", slug="other")
        other = User.objects.create_user(username="o", email="o@example.com", password="pw", organisation=other_org)
        client = Client()
        client.force_login(other)
        resp = self._post(client=client)
        self.assertEqual(resp.status_code, 403)

    def test_a_reply_comes_back_normalised(self):
        from modeling.models import AiEdit
        resp = self._with({"kind": "cam", "summary": "Tabs added.", "answer": "Added 4 tabs.",
                           "edits": [{"opId": "op1", "overrides": {"tabs": True, "tabCount": 4, "safeZ": 1}}],
                           "operations": [{"kind": "drill", "entityIds": ["c1", "k1"]}],
                           "postProcessor": {"dialect": "x"}}, "fix the tabs")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["reply"]["summary"], "Tabs added.")
        self.assertEqual(body["reply"]["edits"][0]["overrides"], {"tabs": True, "tabCount": 4})
        self.assertEqual(body["reply"]["operations"][0]["entityIds"], ["c1"])   # construction isn't cuttable
        self.assertTrue(any("safeZ" in n for n in body["notes"]))
        self.assertTrue(any("postProcessor" in n for n in body["notes"]))
        self.assertFalse({"tokens_in", "cost_usd"} & body.keys())   # not staff
        self.assertEqual(AiEdit.objects.get(user=self.user).instruction, "fix the tabs")
        prompt = self.calls[0]["user"]
        self.assertIn("id=e1", prompt)
        self.assertNotIn("id=k1", prompt)
        self.assertIn("No tabs on a through cut", prompt)
        self.assertIn('"rpm": 18000', prompt)
        self.assertNotIn("acrylic\", \"rpm", prompt)   # only the job material's presets
        self.assertEqual(self.calls[0]["tools"][0]["name"], "cam_reply")

    def test_lines_that_join_are_listed_as_an_outline_and_ids_come_back_in_words(self):
        sq = [(0, 0), (40, 0), (40, 30), (0, 30)]
        lines = [{"id": f"l{i}", "type": "line", "points": [{"x": a[0], "y": a[1]}, {"x": b[0], "y": b[1]}]}
                 for i, (a, b) in enumerate(zip(sq, sq[1:] + sq[:1]))]
        lines.append({"id": "m1", "type": "line", "points": [{"x": 60, "y": 0}, {"x": 70, "y": 0}]})
        lines.append({"id": "m2", "type": "line", "points": [{"x": 70, "y": 0.2}, {"x": 70, "y": 9}]})
        sketches = [{"id": "s2", "name": "Lines", "entities": lines}, *SKETCHES]
        resp = self._with({"kind": "cam", "summary": "Bored c1.", "answer": "",
                           "edits": [{"opId": "op1", "entityIds": ["l0", "l1", "l2", "l3"]}]},
                          "cut the square", document_data={"sketches": sketches})
        body = resp.json()
        self.assertEqual(body["reply"]["edits"][0]["entityIds"], ["l0", "l1", "l2", "l3"])
        self.assertEqual(body["reply"]["summary"], "Bored the Ø6 circle at (20.0, 20.0).")
        self.assertEqual(body["notes"], [])
        prompt = self.calls[0]["user"]
        self.assertIn('lines ["l0", "l1", "l2", "l3"] join end to end into one closed outline, '
                      'bounding box 40.00 x 30.00 from (0.00, 0.00)', prompt)
        self.assertIn('lines ["m1", "m2"] join end to end into one open outline', prompt)
        self.assertIn('- operation 1: id="op1" profile', prompt)

    def test_an_empty_message_asks_for_a_plan_and_staff_see_the_spend(self):
        self.user.is_staff = True
        self.user.save()
        resp = self._with({"kind": "cam", "summary": "Planned.", "answer": ""})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("USER: Plan this job", self.calls[0]["user"])
        self.assertEqual(resp.json()["tokens_in"], 1000)
        self.assertIn("cost_usd", resp.json())

    def test_a_reply_without_the_tool_is_an_answer(self):
        resp = self._with({"kind": "question", "question": "Which material is it?"}, "help")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["reply"]["answer"], "Which material is it?")
        self.assertEqual(resp.json()["reply"]["operations"], [])

    def test_an_assistant_error_is_a_422(self):
        from modeling.assistant import AssistantError
        resp = self._with(AssistantError("ANTHROPIC_KEY is not set"), "plan")
        self.assertEqual(resp.status_code, 422)
        self.assertEqual(resp.json()["message"], "ANTHROPIC_KEY is not set")
