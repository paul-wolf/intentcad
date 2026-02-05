from datetime import datetime
from typing import Any
from uuid import UUID

from ninja import Schema


class DocumentCreateIn(Schema):
    name: str
    data: dict[str, Any]
    history: dict[str, Any] = {}


class DocumentUpdateIn(Schema):
    name: str | None = None
    data: dict[str, Any] | None = None
    history: dict[str, Any] | None = None


class DocumentOut(Schema):
    id: UUID
    name: str
    data: dict[str, Any]
    history: Any
    created_at: datetime
    updated_at: datetime


class DocumentListOut(Schema):
    id: UUID
    name: str
    created_at: datetime
    updated_at: datetime
