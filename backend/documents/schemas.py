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


class DescriptionIn(Schema):
    description: str


class DocumentOut(Schema):
    id: UUID
    name: str
    description: str = ""
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
    description: str = ""
    project_id: UUID | None = None
    created_at: datetime
    updated_at: datetime
    kind: str = "sketch"   # 'part' | 'sketch' — so the list can group without fetching each doc
    thumbnail: str | None = None   # PNG data URL preview of a built part, if any
    # a part whose project sketches or parameters changed since it was built:
    # what changed, e.g. ['SK["frame"] changed'] (modeling/shared_defs.stale)
    stale: list[str] = []
    pinned: bool = False   # restored to an old version's sketches and parameters

    @staticmethod
    def resolve_stale(obj) -> list[str]:
        from modeling import shared_defs
        return shared_defs.stale(obj)

    @staticmethod
    def resolve_pinned(obj) -> bool:
        data = obj.data if isinstance(obj.data, dict) else {}
        return bool(data.get("pinned"))

    @staticmethod
    def resolve_kind(obj) -> str:
        from .models import document_kind
        return document_kind(obj.data)

    @staticmethod
    def resolve_thumbnail(obj) -> str | None:
        data = obj.data if isinstance(obj.data, dict) else {}
        thumb = data.get("thumbnail")
        return thumb if isinstance(thumb, str) and thumb.startswith("data:") else None


class AssetBBox(Schema):
    min: list[float]   # [x, y, z]
    max: list[float]


class AssetOut(Schema):
    """An uploaded STEP file, as placed by the import script (see api.IMPORT_SCRIPT)."""
    sha256: str
    filename: str
    size: int
    bbox: AssetBBox
    face_count: int


class AssetListOut(Schema):
    """Metadata for one uploaded file (no bytes)."""
    sha256: str
    filename: str
    content_type: str
    size: int
    created_at: datetime
