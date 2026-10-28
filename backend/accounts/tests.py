"""User events: what gets recorded, and the superusers' Events listing."""
import importlib
import json
from datetime import timedelta
from unittest import mock

from django.apps import apps
from django.test import Client, TestCase
from django.utils import timezone

from documents.models import Document
from modeling.models import AiEdit

from .models import LoginLog, Organisation, User, UserEvent

PART = "part = Box(20, 20, 6)"
DOC_DATA = {"id": "doc_1", "name": "Test", "activeSketchId": "sk_1",
            "sketches": [{"id": "sk_1", "name": "Sketch 1", "visible": True, "entities": []}]}
EVENTS = "/api/auth/manage/events"


def _post(client, url, body):
    return client.post(url, data=json.dumps(body), content_type="application/json")


class RecordingTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="ann", email="ann@example.com", password="pw")

    def test_a_sign_in_and_sign_out(self):
        c = Client(HTTP_USER_AGENT="TestBrowser")
        self.assertEqual(_post(c, "/api/auth/login", {"username": "ann", "password": "pw"}).status_code, 200)
        _post(c, "/api/auth/logout", {})
        login, logout = UserEvent.objects.order_by("created_at", "id")
        self.assertEqual((login.kind, login.user, login.user_email), ("login", self.user, "ann@example.com"))
        self.assertEqual(login.user_agent, "TestBrowser")
        self.assertEqual(login.ip_address, "127.0.0.1")
        self.assertEqual((logout.kind, logout.user), ("logout", self.user))

    def test_failed_sign_ins(self):
        _post(Client(), "/api/auth/login", {"username": "ann", "password": "nope"})
        _post(Client(), "/api/auth/login", {"username": "nobody", "password": "pw"})
        wrong, unknown = UserEvent.objects.order_by("created_at", "id")
        self.assertEqual((wrong.kind, wrong.user, wrong.text), ("login_failed", self.user, "wrong password"))
        self.assertEqual((unknown.kind, unknown.user, unknown.text), ("login_failed", None, "nobody"))

    def test_making_a_part(self):
        c = Client()
        c.force_login(self.user)
        doc_id = _post(c, "/api/documents/", {"name": "Bracket", "data": dict(DOC_DATA, modelCode=PART)}).json()["id"]
        e = UserEvent.objects.get(kind="document_created")
        self.assertEqual((e.user, e.document_id, e.document_name, e.document_kind),
                         (self.user, doc_id, "Bracket", "part"))

    def test_an_ai_edit_and_what_it_cost(self):
        doc = Document.objects.create(name="Bracket", data=dict(DOC_DATA, modelCode=PART), created_by=self.user)
        c = Client()
        c.force_login(self.user)
        r = {"kind": "edit", "code": PART + "\n", "note": "Made it.", "tokens_in": 3000, "tokens_out": 400,
             "cache_read_tokens": 1000, "cache_write_tokens": 0, "cost_usd": 0.02, "model": "claude-test"}
        with mock.patch("modeling.api.edit_script", return_value=r):
            _post(c, "/api/build/edit", {"code": PART, "instruction": "add a hole", "document_id": str(doc.id)})
        e = UserEvent.objects.get(kind="ai_call")
        self.assertEqual((e.user, e.cost_usd, e.text, e.document_name), (self.user, 0.02, "add a hole", "Bracket"))
        self.assertEqual(e.detail["source"], "part chat")
        self.assertEqual(e.detail["model"], "claude-test")
        self.assertEqual(e.detail["tokens_in"], 3000)

    def test_a_failed_ai_edit_still_counts(self):
        from modeling.assistant import AssistantError
        c = Client()
        c.force_login(self.user)
        usage = {"tokens_in": 2000, "tokens_out": 1000, "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "cost_usd": 0.03}
        with mock.patch("modeling.api.edit_script", side_effect=AssistantError("no", usage=usage)):
            _post(c, "/api/build/edit", {"code": PART, "instruction": "x"})
        e = UserEvent.objects.get(kind="ai_call")
        self.assertEqual(e.cost_usd, 0.03)
        self.assertTrue(e.detail["failed"])

    def test_the_history_outlives_the_user(self):
        UserEvent.objects.create(user=self.user, user_email=self.user.email, kind="login")
        self.user.delete()
        e = UserEvent.objects.get()
        self.assertEqual((e.user, e.user_email), (None, "ann@example.com"))


class EventListTests(TestCase):
    def setUp(self):
        org = Organisation.objects.create(name="Shop", slug="shop")
        self.root = User.objects.create_user(username="root", email="root@example.com", password="pw",
                                             is_superuser=True)
        self.ann = User.objects.create_user(username="ann", email="ann@example.com", password="pw",
                                            first_name="Ann", last_name="Lee", organisation=org)
        self.bob = User.objects.create_user(username="bob", email="bob@example.com", password="pw")
        now = timezone.now()

        def ev(user, kind, days=0, **kw):
            return UserEvent.objects.create(user=user, user_email=user.email, kind=kind,
                                            created_at=now - timedelta(days=days), **kw)

        ev(self.ann, "login", 10)
        ev(self.ann, "ai_call", 10, cost_usd=0.5, text="add fillets", document_name="Bracket")
        ev(self.ann, "ai_call", 1, cost_usd=0.25, text="plan the job", document_name="Tray")
        ev(self.ann, "document_created", 1, document_name="Tray")
        ev(self.bob, "login", 0)
        ev(self.bob, "ai_call", 0, cost_usd=1.0, text="make it lighter", document_name="Arm")
        self.client = Client()
        self.client.force_login(self.root)

    def _get(self, **params):
        r = self.client.get(EVENTS, params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_superusers_only(self):
        self.assertEqual(Client().get(EVENTS).status_code, 401)
        staff = User.objects.create_user(username="s", email="s@example.com", password="pw", is_staff=True)
        c = Client()
        c.force_login(staff)
        self.assertEqual(c.get(EVENTS).status_code, 403)
        c.force_login(self.ann)
        self.assertEqual(c.get(EVENTS).status_code, 403)

    def test_everything_newest_first_with_the_spend(self):
        body = self._get()
        self.assertEqual(body["total"], 6)
        self.assertEqual(body["events"][0]["user_email"], "bob@example.com")
        self.assertEqual(body["spend"], {"cost_usd": 1.75, "ai_calls": 3})
        self.assertEqual([u["email"] for u in body["by_user"]], ["bob@example.com", "ann@example.com"])
        ann = body["by_user"][1]
        self.assertEqual((ann["name"], ann["organisation"], ann["ai_calls"], ann["cost_usd"], ann["logins"],
                          ann["documents_created"]), ("Ann Lee", "Shop", 2, 0.75, 1, 1))
        self.assertEqual(len(body["users"]), 3)

    def test_filter_by_kind_user_search_and_dates(self):
        self.assertEqual(self._get(kind="login")["total"], 2)
        by_kind = self._get(kind="login")
        self.assertEqual(len(by_kind["by_user"]), 2)   # the totals ignore the kind
        self.assertEqual(by_kind["spend"]["cost_usd"], 0)
        by_ann = self._get(user=str(self.ann.id))
        self.assertEqual(by_ann["total"], 4)
        self.assertEqual(by_ann["spend"]["cost_usd"], 0.75)
        self.assertEqual(len(by_ann["by_user"]), 2)   # and the user
        self.assertEqual(self._get(q="fillets")["total"], 1)
        self.assertEqual(self._get(q="ann tray")["total"], 2)
        self.assertEqual(self._get(q="Lee")["total"], 4)
        recent = self._get(since=(timezone.now() - timedelta(days=5)).isoformat())
        self.assertEqual(recent["total"], 4)
        self.assertEqual(recent["spend"]["cost_usd"], 1.25)
        self.assertEqual(self._get(until=(timezone.now() - timedelta(days=5)).date().isoformat())["total"], 2)

    def test_pages(self):
        body = self._get(limit=2, offset=2)
        self.assertEqual(body["total"], 6)
        self.assertEqual(len(body["events"]), 2)

    def test_bad_filters(self):
        self.assertEqual(self.client.get(EVENTS, {"kind": "nope"}).status_code, 400)
        self.assertEqual(self.client.get(EVENTS, {"since": "yesterday"}).status_code, 400)


class BackfillTests(TestCase):
    def test_copies_the_earlier_history(self):
        backfill = importlib.import_module("accounts.migrations.0003_backfill_user_events").backfill
        ann = User.objects.create_user(username="ann", email="ann@example.com", password="pw")
        LoginLog.objects.create(user=ann, ip_address="10.0.0.1", success=True)
        LoginLog.objects.create(user=ann, success=False)
        doc = Document.objects.create(name="Bracket", data={"modelCode": PART}, created_by=ann)
        AiEdit.objects.create(user=ann, document_id=str(doc.id), instruction="add a hole", tokens_in=10,
                              cost_usd=0.04)
        UserEvent.objects.all().delete()   # what the requests above recorded
        backfill(apps, None)
        kinds = sorted(UserEvent.objects.values_list("kind", flat=True))
        self.assertEqual(kinds, ["ai_call", "document_created", "login", "login_failed"])
        ai = UserEvent.objects.get(kind="ai_call")
        self.assertEqual((ai.cost_usd, ai.document_name, ai.document_kind, ai.text), (0.04, "Bracket", "part", "add a hole"))
        self.assertEqual(UserEvent.objects.get(kind="login").ip_address, "10.0.0.1")
        backfill(apps, None)   # only ever into an empty table
        self.assertEqual(UserEvent.objects.count(), 4)


class SeedTestUserTests(TestCase):
    """manage.py seed_test_user: the local test user from accounts/dev_seed.py."""

    def _seed(self):
        from io import StringIO
        from django.core.management import call_command
        call_command("seed_test_user", stdout=StringIO())

    def test_signs_in_and_joins_the_guide_project_s_organisation(self):
        from projects.models import Project
        from .dev_seed import GUIDE_PROJECT, TEST_USER
        Organisation.objects.create(name="Other", slug="other")
        org = Organisation.objects.create(name="Guides", slug="guides")
        Project.objects.create(name=GUIDE_PROJECT, organisation=org)
        self._seed()
        user = User.objects.get(username=TEST_USER["username"])
        self.assertEqual(user.organisation, org)
        r = _post(Client(), "/api/auth/login", {"username": TEST_USER["email"], "password": TEST_USER["password"]})
        self.assertEqual(r.status_code, 200)

    def test_running_it_again_resets_the_password_and_lockout(self):
        from .dev_seed import TEST_USER
        self._seed()
        user = User.objects.get(username=TEST_USER["username"])
        user.set_password("something else")
        user.failed_login_attempts, user.locked_until = 9, timezone.now() + timedelta(hours=1)
        user.save()
        self._seed()
        user.refresh_from_db()
        self.assertTrue(user.check_password(TEST_USER["password"]))
        self.assertIsNone(user.locked_until)
        self.assertEqual(User.objects.filter(username=TEST_USER["username"]).count(), 1)

    def test_refuses_anything_but_sqlite(self):
        from django.core.management.base import CommandError
        from django.test import override_settings
        with override_settings(DATABASES={"default": {"ENGINE": "django.db.backends.postgresql"}}):
            with self.assertRaises(CommandError):
                self._seed()
