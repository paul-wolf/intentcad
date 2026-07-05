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

    def test_run_returns_mesh_and_step(self):
        self.client.force_login(self.user)
        resp = self._post(PART)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreater(data["mesh"]["triangle_count"], 0)
        self.assertEqual(len(data["mesh"]["positions"]), data["mesh"]["triangle_count"] * 9)
        self.assertTrue(data["step"].startswith("ISO-10303-21;"))
        self.assertLess(data["metrics"]["volume"], 20 * 20 * 6)  # box minus a hole

    def test_bad_script_returns_422(self):
        self.client.force_login(self.user)
        resp = self._post("part = Box(1, 1, 1")  # syntax error
        self.assertEqual(resp.status_code, 422)
        self.assertIn("message", resp.json())
