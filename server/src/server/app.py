import hashlib
import logging
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated
from uuid import UUID

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import Cookie, FastAPI, HTTPException, Request, Response, status
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from server.db import Account, ChatSession, LoginToken, db_session
from server.settings import load_settings

logger = logging.getLogger("server.app")


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    load_settings()
    yield


_ADMIN_USERNAME = "admin"
_UNAUTHORIZED = "用户名或密码不正确"
_LOGIN_REQUIRED = "未登录"
_COOKIE_NAME = "login"


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


app = FastAPI(lifespan=_lifespan)


@app.exception_handler(Exception)
async def _unhandled_error(request: Request, exc: Exception) -> Response:
    if isinstance(exc, HTTPException):
        return await http_exception_handler(request, exc)
    if isinstance(exc, RequestValidationError):
        return await request_validation_exception_handler(request, exc)

    logger.exception("请求失败 %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "服务器错误"},
    )


@app.post("/api/login")
def login(body: LoginRequest, response: Response) -> LoginResponse:
    # TODO: 现在只允许用户名 admin 登录。
    # 以后改为按 account 表里的用户名查找并核对密码，不要写死这一个账号。
    if body.username != _ADMIN_USERNAME:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    with db_session() as session:
        result, token = _login_admin(session, body.password)

    response.set_cookie(
        key=_COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        path="/",
    )
    return result


@app.get("/api/sessions")
def list_sessions(
    login: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> list[SessionItem]:
    with db_session() as session:
        account = _account_from_cookie(session, login)
        return _session_items(account)


@app.post("/api/sessions")
def create_session(
    login: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> SessionItem:
    with db_session() as session:
        account = _account_from_cookie(session, login)
        chat = ChatSession(account=account)
        session.add(chat)
        session.flush()
        session.refresh(chat)
        return _session_item(chat)


def _login_admin(session: Session, password: str) -> tuple[LoginResponse, str]:
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

    token = secrets.token_urlsafe(32)
    session.add(LoginToken(account=account, token_hash=_token_hash(token)))
    result = LoginResponse(
        locale=account.language_setting.locale,
        sessions=_session_items(account),
    )
    return result, token


def _account_from_cookie(session: Session, login: str | None) -> Account:
    if login is None or login == "":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _LOGIN_REQUIRED)

    token = session.scalar(
        select(LoginToken).where(LoginToken.token_hash == _token_hash(login)),
    )
    if token is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _LOGIN_REQUIRED)

    return token.account


def _session_items(account: Account) -> list[SessionItem]:
    return [_session_item(item) for item in account.sessions]


def _session_item(item: ChatSession) -> SessionItem:
    return SessionItem(
        id=item.id,
        title=item.title,
        title_locale=item.title_locale,
        created_at=item.created_at,
    )


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _password_matches(hasher: PasswordHasher, stored_hash: str, password: str) -> bool:
    try:
        hasher.verify(stored_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
    return True
