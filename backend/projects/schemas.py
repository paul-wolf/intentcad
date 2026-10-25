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
    brief: str = ""
    brief_updated_at: datetime | None = None
    parameters: list[dict] = []


class ProjectParameter(Schema):
    name: str
    value: float | str
    unit: str = ""          # "mm", "deg" or "" (a count, or text)
    description: str = ""


class ParametersIn(Schema):
    parameters: list[ProjectParameter]


class BriefIn(Schema):
    text: str
    label: str = ""   # what the save was, e.g. "AI proposal: added the tube sizes"


class BriefVersionOut(Schema):
    id: UUID
    text: str
    label: str
    created_at: datetime
    created_by: str = ""

    @staticmethod
    def resolve_created_by(obj) -> str:
        u = obj.created_by
        return (u.get_full_name() or u.username) if u else ""


class ProjectListOut(Schema):
    id: UUID
    name: str
    description: str
    updated_at: datetime
    document_count: int = 0


class ShareIn(Schema):
    email: str


class ShareOut(Schema):
    id: UUID
    email: str
    username: str
    shared_at: datetime
