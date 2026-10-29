"""Create (or reset) the local test user from accounts/dev_seed.py.

Only with DEBUG on and against SQLite: a test server's database, never
Postgres or production.
    DB_HOST= .venv/bin/python manage.py seed_test_user
"""
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from accounts.dev_seed import GUIDE_PROJECT, TEST_USER
from accounts.models import Organisation, User


class Command(BaseCommand):
    help = "Create or reset the local test user (accounts/dev_seed.py); DEBUG on and SQLite databases only."

    def handle(self, *args, **options):
        if not settings.DEBUG:
            raise CommandError("seed_test_user only runs with DEBUG on (a test server, not production).")
        if "sqlite" not in settings.DATABASES["default"]["ENGINE"]:
            raise CommandError("seed_test_user only runs against a SQLite database (run with DB_HOST empty).")
        from projects.models import Project

        guide = Project.objects.filter(name=GUIDE_PROJECT).select_related("organisation").first()
        org = guide.organisation if guide else Organisation.objects.order_by("created_at").first()
        if org is None:
            org = Organisation.objects.create(name="Test organisation", slug="test-organisation")
        user = User.objects.filter(username=TEST_USER["username"]).first() or User(username=TEST_USER["username"])
        user.email = TEST_USER["email"]
        user.organisation = org
        user.is_active = True
        user.set_password(TEST_USER["password"])
        user.failed_login_attempts, user.last_failed_login, user.locked_until = 0, None, None
        user.save()
        self.stdout.write(f"Test user {user.username} ({user.email}) in {org.name}; password in accounts/dev_seed.py")
