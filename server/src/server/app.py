from datetime import datetime
from uuid import UUID

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from server.database import db_session
from server.models import Account

_ADMIN_USERNAME = "admin"
_UNAUTHORIZED = "用户名或密码不正确"


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


app = FastAPI()


@app.post("/api/login")
def login(body: LoginRequest) -> LoginResponse:
    # TODO: 现在只允许用户名 admin 登录。
    # 以后改为按 account 表里的用户名查找并核对密码，不要写死这一个账号。
    if body.username != _ADMIN_USERNAME:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    with db_session() as session:
        return _login_admin(session, body.password)


def _login_admin(session: Session, password: str) -> LoginResponse:
    account = session.scalar(select(Account).where(Account.username == _ADMIN_USERNAME))
    if account is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    hasher = PasswordHasher()
    if not _password_matches(hasher, account.password_hash, password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    if hasher.check_needs_rehash(account.password_hash):
        account.password_hash = hasher.hash(password)

    if account.language_setting is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "账号没有语言设置")

    sessions = [
        SessionItem(
            id=item.id,
            title=item.title,
            title_locale=item.title_locale,
            created_at=item.created_at,
        )
        for item in account.sessions
    ]
    return LoginResponse(locale=account.language_setting.locale, sessions=sessions)


def _password_matches(hasher: PasswordHasher, stored_hash: str, password: str) -> bool:
    try:
        hasher.verify(stored_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
    return True
