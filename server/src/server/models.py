from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Uuid, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

_LOCALE_IN = "IN ('zh-CN', 'zh-TW', 'en')"


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "account"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
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
    account: Mapped[Account] = relationship()
