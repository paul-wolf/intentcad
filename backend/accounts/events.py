"""Recording user events (see UserEvent). Recording never gets in the way of
what the user did: a failure is logged and the request goes on."""
import logging

from .models import UserEvent

log = logging.getLogger(__name__)


def client_ip(request) -> str | None:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return forwarded.split(",")[0].strip() or None
    return request.META.get("REMOTE_ADDR") or None


def document_kind(doc) -> str:
    """'part' or 'sketch', as the document list tells them apart."""
    from documents.schemas import DocumentListOut

    return DocumentListOut.resolve_kind(doc)


def record_event(kind: str, request=None, user=None, document=None, document_id: str = "",
                 text: str = "", cost_usd: float = 0.0, detail: dict | None = None,
                 user_email: str = "") -> UserEvent | None:
    """Record one event for `user` (default: the request's user). `document` (a
    Document) or `document_id` names the part or sketch it concerns."""
    try:
        if user is None and request is not None and request.user.is_authenticated:
            user = request.user
        if document is None and document_id:
            from documents.models import Document

            document = Document.objects.filter(id=document_id).only("id", "name", "data").first()
        return UserEvent.objects.create(
            user=user,
            user_email=(user.email if user else user_email)[:254],
            kind=kind,
            ip_address=client_ip(request) if request is not None else None,
            user_agent=request.META.get("HTTP_USER_AGENT", "")[:500] if request is not None else "",
            document_id=str(document.id) if document else str(document_id or ""),
            document_name=document.name[:255] if document else "",
            document_kind=document_kind(document) if document else "",
            text=text,
            cost_usd=cost_usd or 0.0,
            detail=detail or {},
        )
    except Exception:   # noqa: BLE001 — an event must never break the request
        log.exception("could not record a %s event", kind)
        return None


SPEND_KEYS = ("tokens_in", "tokens_out", "cache_read_tokens", "cache_write_tokens")


def record_ai_call(request, source: str, document_id: str, instruction: str, r: dict,
                   failed: bool = False) -> None:
    """Record one AI call (a part chat edit, a CAM chat turn) and what it cost."""
    detail = {"source": source, "model": r.get("model", ""),
              **{k: r.get(k, 0) for k in SPEND_KEYS}}
    if failed:
        detail["failed"] = True
    record_event(UserEvent.AI_CALL, request, document_id=document_id, text=instruction[:500],
                 cost_usd=r.get("cost_usd", 0.0), detail=detail)
