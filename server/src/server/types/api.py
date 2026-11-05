from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from server.turn_status import DoneReason, DoneStatus


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
    # 这个账号是不是被标了「必须改密」（预设账号、被控制台重置过密码的
    # 账号）。前端拿它决定要不要先把用户按到改密界面去。命名跟响应模型
    # 的现有约定走：snake_case、不带 alias（同 avatar_url、pinned_at）。
    must_change_password: bool


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
    # 同 LoginResponse.must_change_password。默认 False 是过渡态：构造
    # 这个模型的 routes/profile.py 还没把账号上的真值传进来，在那之前
    # 这个接口先恒回 false；登录响应里的值是真的。
    must_change_password: bool = False


class ProfileUpdate(BaseModel):
    locale: Literal["zh-CN", "zh-TW", "en"]


class PartialReplyResponse(BaseModel):
    """ "还在写吗"——只回答这一个问题。

    这场会话的轮次还在写时才返回（200，status 恒为 streaming）；其余
    一切情况（写完了/失败/被停/键不存在）都是 404（见
    app.read_session_partial）。结局语义（finished/failed/aborted）不再
    由这个接口承担：即时结局随流的 done 帧走，永久结局在库的
    message.status 上。
    """

    status: Literal["streaming"]
    text: str
    turn_id: str | None = None
    question: str | None = None


class TurnDoneEvent(BaseModel):
    """流里结局帧（event: done 命名事件）的 data 载荷。

    一轮写完/失败/被停的结局随流明说，页面不再靠「流怎么断的」反推。
    reason 词汇固定：stop（用户按停）、upstream（上游失败）、
    internal（我们这边出错）；正常写完为 null。

    done 帧是即时判断，库是最终事实：_write_round_end 事后与上游对账
    可能把 failed 改成 completed，done 帧不等待、也不回改
    （2026-11-05 维护者拍板）。
    """

    turn_id: str
    status: DoneStatus
    reason: DoneReason | None = None
    bytes_sent: int


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
    # 语言字段（locale）已删：后端没有任何地方读它，报错文案的三语化
    # 由前端按状态码映射负责。Pydantic v2 默认 extra=ignore，旧前端
    # 继续发 locale 也不会 422，字段被静默丢掉。
    model_config = ConfigDict(populate_by_name=True)

    message: str = Field(min_length=1, max_length=8000)
    chat_id: UUID = Field(alias="chatId")
    turn_id: UUID = Field(alias="turnId")
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


class FeedbackUpdate(BaseModel):
    """点赞/点踩（docs/MESSAGE_ACTIONS.md 第四期）。

    turn_id 是我们的轮次编号，也就是上游那条回答记录的 dataId；
    feedback：good=点赞、bad=点踩、null=清掉之前的反馈。页面没有
    轮次编号时传空串，这里当成没有（端点回 404）。
    """

    model_config = ConfigDict(populate_by_name=True)

    turn_id: UUID | None = Field(default=None, alias="turnId")
    feedback: Literal["good", "bad"] | None = None

    @field_validator("turn_id", mode="before")
    @classmethod
    def _empty_turn_id(cls, value: object) -> object:
        # 页面没有这一轮编号时传空串，这里当成没有。
        if isinstance(value, str) and value.strip() == "":
            return None
        return value
