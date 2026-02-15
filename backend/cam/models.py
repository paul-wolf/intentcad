import uuid

from django.db import models


class CamProfile(models.Model):
    """Reusable machine/tool profile - setup once, use everywhere."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    name = models.CharField(max_length=255)
    config = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]


class CamJob(models.Model):
    """A specific G-code generation job tied to a document."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    document = models.ForeignKey(
        "documents.Document", on_delete=models.CASCADE, related_name="cam_jobs"
    )
    name = models.CharField(max_length=255)
    profile = models.ForeignKey(
        CamProfile, on_delete=models.SET_NULL, null=True, blank=True
    )
    config = models.JSONField(default=dict)
    gcode = models.TextField(blank=True, default="")
    errors = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
