from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

_LOCALE_IN = "IN ('zh-CN', 'zh-TW', 'en')"
_ROLE_IN = "IN ('chat', 'admin')"


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "account"
    __table_args__ = (CheckConstraint(f"role {_ROLE_IN}", name="account_role_check"),)

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    # 这个账号能进哪一边：chat 是聊天页，admin 是控制台。没有第三种。
    # 默认 chat，所以已有的库跑一遍 init 之后，老账号都还是聊天账号。
    role: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'chat'")
    )
    # 用户自己传的头像。存的是处理过的图（256 见方的 PNG），空着就用默认头像。
    avatar: Mapped[bytes | None] = mapped_column(LargeBinary)
    language_setting: Mapped["LanguageSetting | None"] = relationship(
        back_populates="account",
        uselist=False,
    )
    sessions: Mapped[list["ChatSession"]] = relationship(
        back_populates="account",
        order_by="ChatSession.created_at",
    )


class LanguageSetting(Base):
    __tablename__ = "language_setting"
    __table_args__ = (
        CheckConstraint(
            f"locale {_LOCALE_IN}",
            name="language_setting_locale_check",
        ),
    )

    account_id: Mapped[UUID] = mapped_column(ForeignKey("account.id"), primary_key=True)
    locale: Mapped[str] = mapped_column(String(5))
    account: Mapped[Account] = relationship(back_populates="language_setting")


class ChatSession(Base):
    __tablename__ = "session"
    __table_args__ = (
        CheckConstraint(
            f"title_locale IS NULL OR title_locale {_LOCALE_IN}",
            name="session_title_locale_check",
        ),
        Index("session_account_id_created_at_idx", "account_id", "created_at"),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    account_id: Mapped[UUID] = mapped_column(ForeignKey("account.id"))
    title: Mapped[str | None] = mapped_column(String(500))
    title_locale: Mapped[str | None] = mapped_column(String(5))
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
    account: Mapped[Account] = relationship(back_populates="sessions")


class LoginToken(Base):
    __tablename__ = "login_token"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    account_id: Mapped[UUID] = mapped_column(ForeignKey("account.id"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    account: Mapped[Account] = relationship()


class ChatMessage(Base):
    """一场会话里的消息。

    FastGPT 那边也有一份，但那是它工作流的副产品：它清库就没了，
    被按停止的那一轮还会留下一条只有提问的记录。这里存一份我们自己说了算的，
    页面上的历史从这份来。
    """

    __tablename__ = "message"
    __table_args__ = (
        Index("message_session_id_seq_idx", "session_id", "seq"),
        UniqueConstraint(
            "session_id",
            "turn_id",
            "role",
            name="message_session_turn_role_key",
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    session_id: Mapped[UUID] = mapped_column(ForeignKey("session.id"))
    # 这一轮的编号。跟 FastGPT 那边的回答记录（dataId）是同一个值。
    turn_id: Mapped[UUID] = mapped_column(Uuid)
    role: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text)
    # 这一轮的状态：streaming（还在写）、completed、failed、aborted。
    status: Mapped[str] = mapped_column(String(16))
    # 会话里的先后顺序。同一轮的提问和回答各占一个号。
    seq: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
