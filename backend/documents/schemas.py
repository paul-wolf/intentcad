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
    project_id: UUID | None = None       # set to move the document to another project
    base_updated_at: str | None = None   # the updated_at the client last saw (concurrency)
    version_label: str = ""              # optional label for the version snapshot
    snapshot: bool = True                # whether this save should record an immutable version
                                         # (False for in-progress drafts between builds)


class DocumentOut(Schema):
    id: UUID
    name: str
    data: dict[str, Any]
    history: Any
    project_id: UUID | None = None
    created_at: datetime
    updated_at: datetime


class VersionListOut(Schema):
    """Metadata for one immutable version (no full data — kept light for the list)."""
    id: UUID
    label: str
    created_at: datetime
    chars: int = 0
    preview: str = ""

    @staticmethod
    def resolve_chars(obj) -> int:
        d = obj.data if isinstance(obj.data, dict) else {}
        return len(d.get("modelCode") or "")

    @staticmethod
    def resolve_preview(obj) -> str:
        d = obj.data if isinstance(obj.data, dict) else {}
        code = d.get("modelCode") or ""
        for line in code.splitlines():
            s = line.strip()
            if s and not s.startswith("#") and not s.startswith("P ") and not s.startswith("P="):
                return s[:60]
        return ""


class VersionOut(Schema):
    id: UUID
    label: str
    created_at: datetime
    data: dict[str, Any]


class DocumentListOut(Schema):
    id: UUID
    name: str
    project_id: UUID | None = None
    created_at: datetime
    updated_at: datetime
    kind: str = "sketch"   # 'part' | 'sketch' — so the list can group without fetching each doc
    thumbnail: str | None = None   # PNG data URL preview of a built part, if any

    @staticmethod
    def resolve_kind(obj) -> str:
        data = obj.data if isinstance(obj.data, dict) else {}
        t = data.get("type")
        if t in ("part", "sketch"):
            return t
        mc = data.get("modelCode")
        return "part" if isinstance(mc, str) and mc.strip() else "sketch"

    @staticmethod
    def resolve_thumbnail(obj) -> str | None:
        data = obj.data if isinstance(obj.data, dict) else {}
        thumb = data.get("thumbnail")
        return thumb if isinstance(thumb, str) and thumb.startswith("data:") else None
