from django.conf import settings
from django.db import models


class AiEdit(models.Model):
    """One AI edit (a /build/edit call): its token usage + cost, logged so we can
    tally spend per document and all-time."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                             related_name="ai_edits")
    document_id = models.CharField(max_length=64, blank=True, default="")
    instruction = models.TextField(blank=True, default="")
    tokens_in = models.IntegerField(default=0)
    tokens_out = models.IntegerField(default=0)
    # of tokens_in, how many were read from / written to the prompt cache
    # (context files are cached across chat turns)
    cache_read_tokens = models.IntegerField(default=0)
    cache_write_tokens = models.IntegerField(default=0)
    cost_usd = models.FloatField(default=0.0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["user", "document_id"])]
        ordering = ["-created_at"]
