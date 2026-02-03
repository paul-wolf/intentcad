import json
from django.test import TestCase, Client


def _valid_doc_data():
    return {
        "id": "doc_abc123",
        "name": "Test",
        "activeSketchId": "sk_abc123",
        "sketches": [
            {
                "id": "sk_abc123",
                "name": "Sketch 1",
                "visible": True,
                "entities": [],
            }
        ],
    }


class DocumentAPITests(TestCase):
    def setUp(self):
        self.client = Client()

    def test_create_and_get(self):
        resp = self.client.post(
            "/api/documents/",
            data=json.dumps({"name": "Test Doc", "data": _valid_doc_data()}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201)
        doc_id = resp.json()["id"]

        resp = self.client.get(f"/api/documents/{doc_id}")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["name"], "Test Doc")

    def test_list(self):
        self.client.post(
            "/api/documents/",
            data=json.dumps({"name": "Doc 1", "data": _valid_doc_data()}),
            content_type="application/json",
        )
        resp = self.client.get("/api/documents/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()), 1)

    def test_update(self):
        resp = self.client.post(
            "/api/documents/",
            data=json.dumps({"name": "Original", "data": _valid_doc_data()}),
            content_type="application/json",
        )
        doc_id = resp.json()["id"]

        resp = self.client.put(
            f"/api/documents/{doc_id}",
            data=json.dumps({"name": "Updated"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["name"], "Updated")

    def test_delete(self):
        resp = self.client.post(
            "/api/documents/",
            data=json.dumps({"name": "To Delete", "data": _valid_doc_data()}),
            content_type="application/json",
        )
        doc_id = resp.json()["id"]

        resp = self.client.delete(f"/api/documents/{doc_id}")
        self.assertEqual(resp.status_code, 204)

        resp = self.client.get(f"/api/documents/{doc_id}")
        self.assertEqual(resp.status_code, 404)

    def test_create_invalid_data(self):
        resp = self.client.post(
            "/api/documents/",
            data=json.dumps({"name": "Bad", "data": {"bad": True}}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 422)
