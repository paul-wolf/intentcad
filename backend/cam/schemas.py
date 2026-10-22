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


class CamChatTurn(Schema):
    role: str           # 'user' | 'ai'
    text: str


class CamChatIn(Schema):
    document_id: UUID
    message: str = ""                     # "" asks for a first plan
    model: str | None = None              # optional LLM override (else the default)
    document_data: dict[str, Any] = {}    # {"sketches": [...]}, as for /advisor/suggest
    context: dict[str, Any] = {}          # setup, machine, materials, tools, presets, plan, issues, focus_op_id
    history: list[CamChatTurn] = []       # recent turns; the last 10 are sent


class CamChatOut(Schema):
    reply: dict[str, Any]   # summary, answer, choices, assumptions, setup, operations, edits, remove
    notes: list[str]        # what was dropped from the AI's reply, and why
    # the spend, for staff only: left out of the response for everyone else
    tokens_in: int | None = None
    tokens_out: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    cost_usd: float | None = None
