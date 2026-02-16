from datetime import datetime
from typing import Any
from uuid import UUID

from ninja import Schema


class PartCreateIn(Schema):
    name: str
    data: dict[str, Any]
    history: dict[str, Any] = {}
    project_id: UUID | None = None


class PartUpdateIn(Schema):
    name: str | None = None
    data: dict[str, Any] | None = None
    history: dict[str, Any] | None = None


class PartOut(Schema):
    id: UUID
    name: str
    data: dict[str, Any]
    history: Any
    project_id: UUID | None = None
    created_at: datetime
    updated_at: datetime


class PartListOut(Schema):
    id: UUID
    name: str
    project_id: UUID | None = None
    created_at: datetime
    updated_at: datetime
