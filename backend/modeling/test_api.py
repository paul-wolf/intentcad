"""HTTP-level tests for POST /api/build/ (auth + serialization + build)."""

import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase

BUILD_URL = "/api/build/"

PLATE_WITH_HOLE = {
    "sketches": [
        {
            "id": "sk1",
            "entities": [
                {"type": "rectangle", "center": {"x": 0, "y": 0},
                 "width": 40, "height": 30, "anchor": "corner"},
                {"type": "circle", "center": {"x": 20, "y": 15}, "radius": 5},
            ],
        }
    ],
    "features": [
        {"id": "f1", "type": "extrude", "sketchId": "sk1", "distance": 10, "operation": "add"}
    ],
}


class BuildApiTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.user = get_user_model().objects.create_user(
            username="tester", email="t@example.com", password="pw",
        )

    def _post(self, body):
        return self.client.post(BUILD_URL, data=json.dumps(body), content_type="application/json")

    def test_requires_auth(self):
        self.assertEqual(self._post(PLATE_WITH_HOLE).status_code, 401)

    def test_build_returns_mesh_and_step(self):
        self.client.force_login(self.user)
        resp = self._post(PLATE_WITH_HOLE)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreater(data["mesh"]["triangle_count"], 0)
        self.assertEqual(len(data["mesh"]["positions"]), data["mesh"]["triangle_count"] * 9)
        self.assertTrue(data["step"].startswith("ISO-10303-21;"))
        self.assertEqual(data["warnings"], [])

    def test_invalid_profile_returns_empty_not_422(self):
        """A feature that can't build is skipped with a warning (200 + empty
        mesh), not a hard 422 — so a reload never breaks the panel."""
        self.client.force_login(self.user)
        bad = {"sketches": [{"id": "sk", "entities": []}],
               "features": [{"id": "f", "type": "extrude", "sketchId": "sk", "distance": 5}]}
        resp = self._post(bad)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["mesh"]["triangle_count"], 0)
        self.assertTrue(any("skipped" in w for w in data["warnings"]))
