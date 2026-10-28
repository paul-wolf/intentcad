"""The local test user, for trying the app in a browser on a test server
(screenshots for the guide, UI checks). Created by `manage.py seed_test_user`,
which only runs against a SQLite database: never a real deployment.

These credentials are for local test databases only; they are not secret."""

TEST_USER = {
    "username": "guide-tester",
    "email": "guide-tester@example.test",
    "password": "Hxhk0Aa7ILTqmZnjqsKc",
}

# The test user joins the organisation that owns this project (so it sees the
# parts the guide's screenshots come from), else the first organisation.
GUIDE_PROJECT = "Guide examples"
