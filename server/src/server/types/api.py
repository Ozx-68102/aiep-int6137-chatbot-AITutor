from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    # 上限挡住超大的正文：argon2 哈希按字节算成本，别拿它烤一炉大面包。
    password: str = Field(min_length=1, max_length=128)


class PasswordChange(BaseModel):
    # 密码的规则不写在这里：Pydantic 的 422 正文是数组，前端读不出字符串
    # （见 docs/ACCOUNT_MANAGEMENT.md）。端点里手动查，回一句中文。
    # 长度上限除外：超大的正文在门口就 422，不走到 argon2 跟前。
    old_password: str = Field(max_length=128)
    new_password: str = Field(max_length=128)
    new_password_confirm: str = Field(max_length=128)


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


class AdminLoginResponse(BaseModel):
    """控制台登录的结果。界面还没建，先只回用户名。"""

    username: str


class AdminAccountItem(BaseModel):
    """控制台账号列表里的一行。"""

    username: str
    role: str


class AdminAccountsResponse(BaseModel):
    accounts: list[AdminAccountItem]


class AdminPasswordResetRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)


class AdminPasswordResetResponse(BaseModel):
    """重置的结果：新密码只在这一次响应里回显，忘了就只能再重置。"""

    username: str
    password: str


class ProfileResponse(BaseModel):
    id: UUID
    username: str
    locale: Literal["zh-CN", "zh-TW", "en"]
    # 头像的地址。默认头像由前端提供（/avatar-default.svg），
    # 自己传的头像走接口，地址后面带内容哈希：换了图地址就变，缓存自动失效。
    avatar_url: str


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
    # 这一轮写到一半断了。页面靠它显示「消息生成失败」和重试按钮。
    failed: bool = False
    # 这一轮被用户按了停止。页面靠它标出「已停止」。
    aborted: bool = False


class HistoryResponse(BaseModel):
    total: int
    messages: list[HistoryMessageResponse]


class ChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str = Field(min_length=1, max_length=8000)
    chat_id: UUID = Field(alias="chatId")
    turn_id: UUID = Field(alias="turnId")
    locale: str | None = None
    # 重发哪一轮：带着它就是把上一轮删掉，重新答一遍同一句提问。
    retry_of: UUID | None = Field(default=None, alias="retryOf")


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
