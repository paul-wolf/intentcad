"""HTTP-level tests for the modeler endpoint POST /api/build/run (auth + artifacts).

The model is a build123d script; the endpoint runs it and returns mesh + STEP.
(The legacy op-list /build endpoint is deprecated — cadquery is being removed.)
"""

import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase

RUN_URL = "/api/build/run"

PART = 'part = Box(20, 20, 6) - Cylinder(3, 20)'


class RunApiTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.user = get_user_model().objects.create_user(
            username="tester", email="t@example.com", password="pw",
        )

    def _post(self, code):
        return self.client.post(RUN_URL, data=json.dumps({"code": code}),
                                content_type="application/json")

    def test_requires_auth(self):
        self.assertEqual(self._post(PART).status_code, 401)

    def test_run_returns_mesh(self):
        self.client.force_login(self.user)
        resp = self._post(PART)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreater(data["mesh"]["triangle_count"], 0)
        self.assertEqual(len(data["mesh"]["positions"]), data["mesh"]["triangle_count"] * 9)
        self.assertLess(data["metrics"]["volume"], 20 * 20 * 6)  # box minus a hole

    def test_export_stl_and_step(self):
        self.client.force_login(self.user)
        for fmt, head in (("stl", "solid"), ("step", "ISO-10303-21;")):
            resp = self.client.post("/api/build/export",
                                    data=json.dumps({"code": PART, "format": fmt}),
                                    content_type="application/json")
            self.assertEqual(resp.status_code, 200)
            self.assertTrue(resp.json()["data"].lstrip().startswith(head))

    def test_sensitivity_returns_per_face_shifts(self):
        self.client.force_login(self.user)
        code = 'P = dict(thick=6)\npart = Box(20, 20, P["thick"])'
        resp = self.client.post("/api/build/sensitivity", data=json.dumps({"code": code}),
                                content_type="application/json")
        self.assertEqual(resp.status_code, 200)
        info = resp.json()["params"]["thick"]
        self.assertTrue(info["shifts"])
        # JSON object keys: face indices arrive as strings, each a 3-vector
        for face, shift in info["shifts"].items():
            self.assertIn(int(face), info["faces"])
            self.assertEqual(len(shift), 3)

    def test_extrude_a_face_sketch_stored_with_the_document(self):
        from documents.models import Document

        self.client.force_login(self.user)
        prof = {"plane": {"origin": [0, 0, 3], "normal": [0, 0, 1], "xAxis": [1, 0, 0]},
                "loops": [[{"t": "circle", "c": [5, 5], "r": 2}]]}
        doc = Document.objects.create(name="p", created_by=self.user,
                                      data={"sketches": [{"name": "Holes", "profile": prof}]})
        code = "part = Box(20, 20, 6)\n"
        resp = self.client.post("/api/build/add_extrude", content_type="application/json",
                                data=json.dumps({"code": code, "sketch": "Holes", "op": "cut", "through": True}))
        self.assertEqual(resp.status_code, 200)
        cut = resp.json()["code"]
        self.assertIn('sketch("Holes")', cut)
        resp = self.client.post(RUN_URL, content_type="application/json",
                                data=json.dumps({"code": cut, "document_id": str(doc.id)}))
        self.assertEqual(resp.status_code, 200)
        self.assertAlmostEqual(resp.json()["metrics"]["volume"], 20 * 20 * 6 - 3.14159265 * 4 * 6, delta=0.5)
        # a profile sent with the request wins over the stored one (unsaved edits)
        bigger = {**prof, "loops": [[{"t": "circle", "c": [5, 5], "r": 3}]]}
        resp = self.client.post(RUN_URL, content_type="application/json",
                                data=json.dumps({"code": cut, "document_id": str(doc.id), "sketches": {"Holes": bigger}}))
        self.assertAlmostEqual(resp.json()["metrics"]["volume"], 20 * 20 * 6 - 3.14159265 * 9 * 6, delta=0.5)

    def test_bad_script_returns_422(self):
        self.client.force_login(self.user)
        resp = self._post("part = Box(1, 1, 1")  # syntax error
        self.assertEqual(resp.status_code, 422)
        self.assertIn("message", resp.json())


class FailedEditSpendTests(TestCase):
    def test_a_failed_edit_logs_and_returns_its_spend(self):
        from unittest import mock
        from modeling.assistant import AssistantError
        from modeling.models import AiEdit
        user = get_user_model().objects.create_user(username="f", email="f@example.com", password="pw")
        client = Client()
        client.force_login(user)
        usage = {"tokens_in": 2000, "tokens_out": 1000, "cache_read_tokens": 0,
                 "cache_write_tokens": 0, "cost_usd": 0.03}
        with mock.patch("modeling.api.edit_script",
                        side_effect=AssistantError("couldn't produce a script that builds", usage=usage)):
            r = client.post("/api/build/edit", data=json.dumps({"code": PART, "instruction": "x"}),
                            content_type="application/json")
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["cost_usd"], 0.03)
        self.assertEqual(AiEdit.objects.get(user=user).cost_usd, 0.03)


class UsageTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.user = get_user_model().objects.create_user(
            username="u", email="u@example.com", password="pw")

    def test_usage_tallies_per_document_and_all_time(self):
        from modeling.models import AiEdit
        AiEdit.objects.create(user=self.user, document_id="A", tokens_in=100, tokens_out=20, cost_usd=0.01)
        AiEdit.objects.create(user=self.user, document_id="A", tokens_in=200, tokens_out=40, cost_usd=0.02)
        AiEdit.objects.create(user=self.user, document_id="B", tokens_in=50, tokens_out=10, cost_usd=0.005)
        self.client.force_login(self.user)
        data = self.client.get("/api/build/usage?document=A").json()
        self.assertEqual(data["document"]["edits"], 2)
        self.assertAlmostEqual(data["document"]["cost_usd"], 0.03, places=4)
        self.assertEqual(data["all_time"]["edits"], 3)
        self.assertAlmostEqual(data["all_time"]["cost_usd"], 0.035, places=4)

    def test_usage_requires_auth(self):
        self.assertEqual(self.client.get("/api/build/usage?document=A").status_code, 401)
