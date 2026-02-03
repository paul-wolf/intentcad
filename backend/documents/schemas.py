from datetime import datetime
from uuid import UUID
from typing import Any
from ninja import Schema


class DocumentCreateIn(Schema):
    name: str
    data: dict[str, Any]


class DocumentUpdateIn(Schema):
    name: str | None = None
    data: dict[str, Any] | None = None


class DocumentOut(Schema):
    id: UUID
    name: str
    data: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class DocumentListOut(Schema):
    id: UUID
    name: str
    created_at: datetime
    updated_at: datetime
