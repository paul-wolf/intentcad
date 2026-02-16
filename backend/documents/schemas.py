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
