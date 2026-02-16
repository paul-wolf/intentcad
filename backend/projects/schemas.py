from datetime import datetime
from uuid import UUID

from ninja import Schema


class ProjectCreateIn(Schema):
    name: str
    description: str = ""
    organisation_id: UUID | None = None


class ProjectUpdateIn(Schema):
    name: str | None = None
    description: str | None = None


class ProjectOut(Schema):
    id: UUID
    name: str
    description: str
    created_at: datetime
    updated_at: datetime


class ProjectListOut(Schema):
    id: UUID
    name: str
    description: str
    updated_at: datetime
    document_count: int = 0
    part_count: int = 0
