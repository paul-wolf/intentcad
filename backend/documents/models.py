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


class ContextFile(models.Model):
    """A reference file (a datasheet PDF, a photo of a board) the AI reads when
    designing. It belongs to a project or to one part document, never both.
    Unlike DocumentAsset no build depends on it, so it may be renamed and
    deleted."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project", on_delete=models.CASCADE, related_name="context_files",
        null=True, blank=True,
    )
    document = models.ForeignKey(
        Document, on_delete=models.CASCADE, related_name="context_files",
        null=True, blank=True,
    )
    filename = models.CharField(max_length=255)
    title = models.CharField(max_length=255)
    note = models.CharField(max_length=500, blank=True, default="")
    content_type = models.CharField(max_length=100)
    size = models.PositiveIntegerField()
    sha256 = models.CharField(max_length=64)
    data = models.BinaryField()
    page_count = models.PositiveIntegerField(null=True, blank=True)   # PDFs
    width = models.PositiveIntegerField(null=True, blank=True)        # images, in px
    height = models.PositiveIntegerField(null=True, blank=True)
    # estimated AI input tokens per page (one entry for an image), so the card
    # can show the cost of the pages currently included
    page_tokens = models.JSONField(default=list, blank=True)
    in_context = models.BooleanField(default=True)   # sent with AI edits
    pages = models.JSONField(null=True, blank=True)  # 1-based pages sent; null = all
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="context_files", null=True, blank=True,
    )

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.CheckConstraint(
                condition=(models.Q(project__isnull=False, document__isnull=True)
                           | models.Q(project__isnull=True, document__isnull=False)),
                name="context_file_has_one_owner",
            ),
        ]

    @property
    def is_pdf(self) -> bool:
        return self.content_type == "application/pdf"

    def included_pages(self) -> list[int]:
        """The 1-based pages sent to the AI (all of them unless chosen)."""
        if not self.is_pdf:
            return [1]
        n = self.page_count or 0
        if self.pages is None:
            return list(range(1, n + 1))
        return sorted({p for p in self.pages if isinstance(p, int) and 1 <= p <= n})


class ContextThumbnail(models.Model):
    """A cached rendering of one page of a ContextFile (JPEG) at one width."""

    file = models.ForeignKey(ContextFile, on_delete=models.CASCADE, related_name="thumbnails")
    page = models.PositiveIntegerField()
    width = models.PositiveIntegerField()
    data = models.BinaryField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["file", "page", "width"], name="unique_context_thumbnail"),
        ]
