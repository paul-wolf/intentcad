"""Fill the event log from what was already recorded: sign-ins (the login log),
AI calls (the AI edit log, with their cost) and parts and sketches made
(documents' creation times). Sign-outs weren't recorded before."""
from django.db import migrations

BATCH = 1000


def _kind(data) -> str:
    data = data if isinstance(data, dict) else {}
    if data.get("type") in ("part", "sketch"):
        return data["type"]
    mc = data.get("modelCode")
    return "part" if isinstance(mc, str) and mc.strip() else "sketch"


def backfill(apps, schema_editor):
    UserEvent = apps.get_model("accounts", "UserEvent")
    LoginLog = apps.get_model("accounts", "LoginLog")
    AiEdit = apps.get_model("modeling", "AiEdit")
    Document = apps.get_model("documents", "Document")
    if UserEvent.objects.exists():
        return
    docs = {str(i): (n, _kind(d)) for i, n, d in Document.objects.values_list("id", "name", "data").iterator()}
    rows = []

    def add(**kw):
        rows.append(UserEvent(**kw))
        if len(rows) >= BATCH:
            UserEvent.objects.bulk_create(rows)
            rows.clear()

    for log in LoginLog.objects.select_related("user").iterator():
        add(user=log.user, user_email=log.user.email, created_at=log.login_at,
            kind="login" if log.success else "login_failed", ip_address=log.ip_address,
            user_agent=(log.user_agent or "")[:500], text="" if log.success else "wrong password",
            detail={"backfilled": True})
    for e in AiEdit.objects.select_related("user").iterator():
        name, kind = docs.get(e.document_id, ("", ""))
        add(user=e.user, user_email=e.user.email, created_at=e.created_at, kind="ai_call",
            document_id=e.document_id, document_name=name[:255], document_kind=kind,
            text=e.instruction, cost_usd=e.cost_usd,
            detail={"backfilled": True,
                    "tokens_in": e.tokens_in, "tokens_out": e.tokens_out,
                    "cache_read_tokens": e.cache_read_tokens, "cache_write_tokens": e.cache_write_tokens})
    for d in Document.objects.select_related("created_by").exclude(created_by=None).iterator():
        add(user=d.created_by, user_email=d.created_by.email, created_at=d.created_at,
            kind="document_created", document_id=str(d.id), document_name=d.name[:255],
            document_kind=_kind(d.data), detail={"backfilled": True})
    UserEvent.objects.bulk_create(rows)


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0002_user_events"),
        ("modeling", "0002_context_files"),
        ("documents", "0004_context_files"),
    ]

    operations = [migrations.RunPython(backfill, migrations.RunPython.noop)]
