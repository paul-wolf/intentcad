import uuid

from django.conf import settings
from django.db import models


class Document(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    data = models.JSONField(default=dict)
    history = models.JSONField(default=dict, blank=True)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="documents",
        null=True,
        blank=True,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="documents",
        null=True,
        blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self):
        return self.name


class DocumentVersion(models.Model):
    """An immutable snapshot of a document's data. Append-only: never updated or
    deleted while its document lives, so a saved version can never be lost."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="versions")
    data = models.JSONField()
    label = models.CharField(max_length=200, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="document_versions", null=True, blank=True,
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["document", "created_at"])]


class DocumentAsset(models.Model):
    """An uploaded file (a STEP model) a document's script imports, by content
    hash: the script says ASSETS["<sha256>"]. Append-only like DocumentVersion —
    never updated or deleted while its document lives, so every saved version
    stays buildable."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="assets")
    sha256 = models.CharField(max_length=64)   # hex digest of `data`
    filename = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100, blank=True, default="")
    size = models.PositiveIntegerField()
    data = models.BinaryField()
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="document_assets", null=True, blank=True,
    )

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(fields=["document", "sha256"], name="unique_asset_per_document"),
        ]
