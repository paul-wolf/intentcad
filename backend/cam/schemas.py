from datetime import datetime
from typing import Any
from uuid import UUID

from ninja import Schema


class CamProfileCreateIn(Schema):
    name: str
    config: dict[str, Any]
    document_id: UUID


class CamProfileUpdateIn(Schema):
    name: str | None = None
    config: dict[str, Any] | None = None


class CamProfileOut(Schema):
    id: UUID
    name: str
    config: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class CamProfileListOut(Schema):
    id: UUID
    name: str
    updated_at: datetime


class CamJobCreateIn(Schema):
    document_id: UUID
    name: str
    profile_id: UUID | None = None
    config: dict[str, Any] = {}


class CamJobUpdateIn(Schema):
    name: str | None = None
    profile_id: UUID | None = None
    config: dict[str, Any] | None = None


class CamJobOut(Schema):
    id: UUID
    name: str
    document_id: UUID
    profile_id: UUID | None = None
    config: dict[str, Any]
    gcode: str
    errors: list[Any]
    created_at: datetime
    updated_at: datetime


class CamJobListOut(Schema):
    id: UUID
    name: str
    document_id: UUID
    updated_at: datetime
    has_gcode: bool
    error_count: int


class AdvisorRequestIn(Schema):
    document_data: dict[str, Any]
    profile_config: dict[str, Any] | None = None
    material: str | None = None


class AdvisorOut(Schema):
    config: dict[str, Any]
    notes: list[str]
