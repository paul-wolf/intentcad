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

    def test_bad_script_returns_422(self):
        self.client.force_login(self.user)
        resp = self._post("part = Box(1, 1, 1")  # syntax error
        self.assertEqual(resp.status_code, 422)
        self.assertIn("message", resp.json())


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
