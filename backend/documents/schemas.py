from datetime import datetime
from typing import Any
from uuid import UUID

from ninja import Schema


class DocumentCreateIn(Schema):
    name: str
    data: dict[str, Any]
    history: dict[str, Any] = {}
    project_id: UUID | None = None


class DocumentUpdateIn(Schema):
    name: str | None = None
    data: dict[str, Any] | None = None
    history: dict[str, Any] | None = None
    project_id: UUID | None = None   # set to move the document to another project


class DocumentOut(Schema):
    id: UUID
    name: str
    data: dict[str, Any]
    history: Any
    project_id: UUID | None = None
    created_at: datetime
    updated_at: datetime


class DocumentListOut(Schema):
    id: UUID
    name: str
    project_id: UUID | None = None
    created_at: datetime
    updated_at: datetime
    kind: str = "sketch"   # 'part' | 'sketch' — so the list can group without fetching each doc

    @staticmethod
    def resolve_kind(obj) -> str:
        data = obj.data if isinstance(obj.data, dict) else {}
        t = data.get("type")
        if t in ("part", "sketch"):
            return t
        mc = data.get("modelCode")
        return "part" if isinstance(mc, str) and mc.strip() else "sketch"
