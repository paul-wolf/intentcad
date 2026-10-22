import uuid

from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone


class Organisation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    slug = models.SlugField(max_length=255, unique=True)
    description = models.TextField(blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=50, blank=True)
    website = models.URLField(max_length=2048, blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "organisations"
        ordering = ["name"]

    def __str__(self):
        return self.name


class User(AbstractUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    organisation = models.ForeignKey(
        Organisation,
        on_delete=models.PROTECT,
        related_name="users",
        null=True,
        blank=True,
    )

    # Account security
    failed_login_attempts = models.PositiveIntegerField(default=0)
    last_failed_login = models.DateTimeField(null=True, blank=True)
    locked_until = models.DateTimeField(null=True, blank=True)

    # Password reset
    password_reset_token = models.CharField(max_length=64, blank=True)
    password_reset_sent_at = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "users"

    def __str__(self):
        return self.username

    def is_locked(self):
        from django.utils import timezone

        if not self.locked_until:
            return False
        if timezone.now() >= self.locked_until:
            self.locked_until = None
            self.failed_login_attempts = 0
            self.save(update_fields=["locked_until", "failed_login_attempts"])
            return False
        return True

    def record_failed_login(self):
        from django.conf import settings
        from django.utils import timezone

        max_attempts = getattr(settings, "MAX_LOGIN_ATTEMPTS", 5)
        lockout_duration = getattr(settings, "LOCKOUT_DURATION", 1800)

        self.failed_login_attempts += 1
        self.last_failed_login = timezone.now()

        if self.failed_login_attempts >= max_attempts:
            self.locked_until = timezone.now() + timezone.timedelta(
                seconds=lockout_duration
            )

        self.save(
            update_fields=["failed_login_attempts", "last_failed_login", "locked_until"]
        )

    def clear_failed_logins(self):
        self.failed_login_attempts = 0
        self.last_failed_login = None
        self.locked_until = None
        self.save(
            update_fields=["failed_login_attempts", "last_failed_login", "locked_until"]
        )

    def generate_password_reset_token(self):
        import secrets

        from django.utils import timezone

        self.password_reset_token = secrets.token_urlsafe(32)
        self.password_reset_sent_at = timezone.now()
        self.save(update_fields=["password_reset_token", "password_reset_sent_at"])
        return self.password_reset_token

    def is_password_reset_valid(self, token):
        import datetime

        from django.utils import timezone

        if not self.password_reset_token or self.password_reset_token != token:
            return False
        if not self.password_reset_sent_at:
            return False
        expiry = self.password_reset_sent_at + datetime.timedelta(hours=24)
        return timezone.now() < expiry


class LoginLog(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="login_logs")
    login_at = models.DateTimeField(auto_now_add=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.TextField(blank=True)
    success = models.BooleanField(default=True)

    class Meta:
        db_table = "login_logs"
        ordering = ["-login_at"]

    def __str__(self):
        return f"{self.user.username} - {self.login_at}"


class UserEvent(models.Model):
    """Something a user did: signed in or out, made a part or sketch, called the AI.
    AI calls carry what they cost, so spend can be added up per user. The email
    is kept on the row, so the history outlives a deleted user."""

    LOGIN = "login"
    LOGIN_FAILED = "login_failed"
    LOGOUT = "logout"
    DOCUMENT_CREATED = "document_created"
    AI_CALL = "ai_call"
    KINDS = [
        (LOGIN, "Signed in"),
        (LOGIN_FAILED, "Failed sign-in"),
        (LOGOUT, "Signed out"),
        (DOCUMENT_CREATED, "Created a part or sketch"),
        (AI_CALL, "AI call"),
    ]

    user = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True,
                             related_name="events")
    user_email = models.CharField(max_length=254, blank=True)
    kind = models.CharField(max_length=32, choices=KINDS)
    # a default, not auto_now_add, so history copied in keeps its own times
    created_at = models.DateTimeField(default=timezone.now)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=500, blank=True)
    document_id = models.CharField(max_length=64, blank=True)
    document_name = models.CharField(max_length=255, blank=True)
    document_kind = models.CharField(max_length=16, blank=True)   # 'part' | 'sketch'
    # what was asked of the AI, or the name tried in a failed sign-in (searchable)
    text = models.TextField(blank=True)
    cost_usd = models.FloatField(default=0.0)
    # AI calls: source, model and token counts
    detail = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "user_events"
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["created_at"]),
            models.Index(fields=["user", "created_at"]),
            models.Index(fields=["kind", "created_at"]),
        ]

    def __str__(self):
        return f"{self.user_email or '?'} {self.kind} {self.created_at:%Y-%m-%d %H:%M}"
