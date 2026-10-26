import asyncio
import hashlib
import json
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
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from server.db import Account, ChatSession, LoginToken, db_session
from server.fastgpt import FastGPT, FastGPTError, open_fastgpt
from server.reply_store import (
    append_chunk,
    begin_reply,
    discard_reply,
    mark_finished,
    read_partial,
)
from server.settings import empty_fastgpt_fields, load_settings

logger = logging.getLogger("server.app")


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    _app.state.fastgpt = open_fastgpt(load_settings())
    try:
        yield
    finally:
        fastgpt = _app.state.fastgpt
        if isinstance(fastgpt, FastGPT):
            await fastgpt.aclose()


_ADMIN_USERNAME = "admin"
_UNAUTHORIZED = "用户名或密码不正确"
_LOGIN_REQUIRED = "未登录"
_COOKIE_NAME = "login"
_SERVER_ERROR = "服务器错误"
_running: set[asyncio.Task[None]] = set()


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


class PartialReplyResponse(BaseModel):
    status: str | None
    text: str


class ChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str = Field(min_length=1)
    chat_id: UUID = Field(alias="chatId")
    locale: str | None = None


class _Relay:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[str | None] = asyncio.Queue()
        self.started = asyncio.Event()
        self.failed = False
        self.sent = False


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
        content={"detail": _SERVER_ERROR},
    )


@app.post("/api/login")
def login(body: LoginRequest, response: Response) -> LoginResponse:
    # TODO: 现在只允许用户名 admin 登录。
    #  以后改为按 account 表里的用户名查找并核对密码，不要写死这一个账号。
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
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> list[SessionItem]:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        return _session_items(account)


@app.post("/api/sessions")
def create_session(
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> SessionItem:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        created = ChatSession(account=account)
        session.add(created)
        session.flush()
        session.refresh(created)
        return _session_item(created)


@app.get("/api/sessions/{session_id}/partial")
def read_session_partial(
    session_id: UUID,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> PartialReplyResponse:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        _require_session(session, account, session_id)

    partial = read_partial(session_id)
    return PartialReplyResponse(status=partial.status, text=partial.text)


@app.post("/api/chat")
async def chat(
    body: ChatRequest,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    missing = empty_fastgpt_fields(load_settings())
    if missing:
        logger.error("FastGPT 配置为空：%s", "、".join(missing))
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _SERVER_ERROR)

    fastgpt = app.state.fastgpt
    if not isinstance(fastgpt, FastGPT):
        logger.error("FastGPT 客户端未建立")
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _SERVER_ERROR)

    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        _require_session(session, account, body.chat_id)

    relay = _Relay()
    task = asyncio.create_task(_relay(body.chat_id, body.message, relay, fastgpt))
    _running.add(task)
    task.add_done_callback(_running.discard)
    await relay.started.wait()
    if relay.failed and not relay.sent:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": _SERVER_ERROR},
        )

    return StreamingResponse(_sse(relay), media_type="text/event-stream")


async def _relay(chat_id: UUID, message: str, relay: _Relay, fastgpt: FastGPT) -> None:
    try:
        begin_reply(chat_id)
        async for event in fastgpt.events(chat_id, message):
            if isinstance(event, str):
                append_chunk(chat_id, event)
                await relay.queue.put(_chunk(event))
                relay.sent = True
                relay.started.set()
                continue

            mark_finished(chat_id)
            await relay.queue.put("data: [DONE]\n\n")
            relay.sent = True
            relay.started.set()
            break
        else:
            relay.failed = True
            relay.started.set()
    except FastGPTError:
        relay.failed = True
        relay.started.set()
    except Exception as exc:
        logger.error("FastGPT 读取失败 %s", chat_id, exc_info=exc)
        relay.failed = True
        relay.started.set()
    finally:
        if relay.failed and not relay.sent:
            discard_reply(chat_id)
        await relay.queue.put(None)


async def _sse(relay: _Relay) -> AsyncIterator[str]:
    while True:
        item = await relay.queue.get()
        if item is None:
            break
        yield item


def _chunk(content: str) -> str:
    payload = json.dumps(
        {"choices": [{"delta": {"content": content}}]},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"data: {payload}\n\n"


def _require_session(session: Session, account: Account, session_id: UUID) -> None:
    found = session.scalar(
        select(ChatSession).where(
            ChatSession.id == session_id,
            ChatSession.account_id == account.id,
        ),
    )
    if not isinstance(found, ChatSession):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "会话不存在")


def _login_admin(session: Session, password: str) -> tuple[LoginResponse, str]:
    account = session.scalar(select(Account).where(Account.username == _ADMIN_USERNAME))
    if not isinstance(account, Account):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    hasher = PasswordHasher()
    if not _password_matches(hasher, account.password_hash, password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    if hasher.check_needs_rehash(account.password_hash):
        account.password_hash = hasher.hash(password)

    language = account.language_setting
    if language is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "账号没有语言设置")

    token = secrets.token_urlsafe(32)
    session.add(LoginToken(account=account, token_hash=_token_hash(token)))
    result = LoginResponse(
        locale=language.locale,
        sessions=_session_items(account),
    )
    return result, token


def _account_from_cookie(session: Session, login_cookie: str | None) -> Account:
    if login_cookie is None or login_cookie == "":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _LOGIN_REQUIRED)

    token = session.scalar(
        select(LoginToken).where(LoginToken.token_hash == _token_hash(login_cookie)),
    )
    if not isinstance(token, LoginToken):
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
