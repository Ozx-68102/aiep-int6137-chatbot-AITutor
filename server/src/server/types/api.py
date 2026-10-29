from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1)


class SessionItem(BaseModel):
    id: UUID
    title: str | None
    pinned: bool
    pinned_at: datetime | None
    created_at: datetime


class SessionCreate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)


class SessionRename(BaseModel):
    title: str = Field(min_length=1, max_length=500)


class SessionPin(BaseModel):
    pinned: bool
    pinned_at: datetime | None = None

    @model_validator(mode="after")
    def _pin_time(self) -> Self:
        if not self.pinned:
            self.pinned_at = None
            return self
        if self.pinned_at is None:
            raise ValueError("置顶需要 pinned_at")
        return self


class LoginResponse(BaseModel):
    locale: str
    sessions: list[SessionItem]


class ProfileResponse(BaseModel):
    id: UUID
    username: str
    locale: Literal["zh-CN", "zh-TW", "en"]


class ProfileUpdate(BaseModel):
    locale: Literal["zh-CN", "zh-TW", "en"]


class PartialReplyResponse(BaseModel):
    status: str | None
    text: str


class HistoryMessageResponse(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    text: str


class HistoryResponse(BaseModel):
    total: int
    messages: list[HistoryMessageResponse]


class ChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str = Field(min_length=1)
    chat_id: UUID = Field(alias="chatId")
    locale: str | None = None
