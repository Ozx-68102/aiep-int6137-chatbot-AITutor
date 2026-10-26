from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1)


class SessionItem(BaseModel):
    id: UUID
    title: str | None
    title_locale: str | None
    created_at: datetime


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
