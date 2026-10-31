from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    turn_id: str | None = None
    question: str | None = None


class StatusResponse(BaseModel):
    database: Literal["ok", "unavailable"]
    reply_store: Literal["ok", "unavailable"]


class HistoryMessageResponse(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    text: str
    turn_id: str | None = None
    waiting: bool = False


class HistoryResponse(BaseModel):
    total: int
    messages: list[HistoryMessageResponse]


class ChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str = Field(min_length=1)
    chat_id: UUID = Field(alias="chatId")
    turn_id: UUID = Field(alias="turnId")
    locale: str | None = None


class AbortRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    turn_id: UUID | None = Field(default=None, alias="turnId")

    @field_validator("turn_id", mode="before")
    @classmethod
    def _empty_turn_id(cls, value: object) -> object:
        # 页面没有这一轮编号时传空串，这里当成没有。
        if isinstance(value, str) and value.strip() == "":
            return None
        return value
