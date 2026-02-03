from django.test import TestCase
from documents.validators import validate_document_data


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
                "entities": [
                    {
                        "id": "ln_abc123",
                        "type": "line",
                        "start": {"x": 0, "y": 0},
                        "end": {"x": 10, "y": 20},
                    }
                ],
            }
        ],
    }


class ValidatorTests(TestCase):
    def test_valid_document(self):
        errors = validate_document_data(_valid_doc_data())
        self.assertEqual(errors, [])

    def test_missing_id(self):
        data = _valid_doc_data()
        del data["id"]
        errors = validate_document_data(data)
        self.assertTrue(any("data.id" in e for e in errors))

    def test_invalid_entity_point(self):
        data = _valid_doc_data()
        data["sketches"][0]["entities"][0]["start"] = {"x": "bad"}
        errors = validate_document_data(data)
        self.assertTrue(any("Point.y" in e for e in errors))

    def test_empty_sketches(self):
        data = _valid_doc_data()
        data["sketches"] = []
        errors = validate_document_data(data)
        self.assertEqual(errors, [])

    def test_not_a_dict(self):
        errors = validate_document_data("not a dict")
        self.assertEqual(errors, ["Document data must be an object"])
