import uuid

from django.conf import settings
from django.db import models


class Project(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    organisation = models.ForeignKey(
        "accounts.Organisation",
        on_delete=models.CASCADE,
        related_name="projects",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="created_projects",
        null=True,
        blank=True,
    )
    # the project every new organisation gets a copy of (at most one is marked)
    is_examples = models.BooleanField(default=False)
    # the brief (markdown): goals, constraints, materials, conventions, bought
    # parts. Every part chat in the project gets it; each save is kept as a
    # ProjectBriefVersion.
    brief = models.TextField(blank=True, default="")
    brief_updated_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects"
        ordering = ["-updated_at"]

    def __str__(self):
        return self.name


class ProjectShare(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="shares",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="shared_projects",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "project_shares"
        unique_together = [("project", "user")]

    def __str__(self):
        return f"{self.project.name} -> {self.user.email}"


class ProjectBriefVersion(models.Model):
    """One saved text of a project's brief. Append-only, like DocumentVersion."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="brief_versions")
    text = models.TextField(blank=True, default="")
    label = models.CharField(max_length=200, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="brief_versions", null=True, blank=True,
    )

    class Meta:
        db_table = "project_brief_versions"
        ordering = ["-created_at"]
