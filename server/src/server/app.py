import asyncio
import hashlib
import json
import logging
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import Cookie, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from server.db import Account, ChatSession, LoginToken, db_session
from server.fastgpt import FastGPT, FastGPTError, open_fastgpt
from server.reply_store import (
    append_chunk,
    begin_reply,
    discard_reply,
    mark_finished,
    read_partial,
)
from server.settings import load_settings
from server.types import (
    ChatRequest,
    HistoryMessageResponse,
    HistoryResponse,
    LoginRequest,
    LoginResponse,
    PartialReplyResponse,
    ProfileResponse,
    ProfileUpdate,
    SessionCreate,
    SessionItem,
    SessionPin,
    SessionRename,
    empty_fastgpt_fields,
)

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


_UNAUTHORIZED = "用户名或密码不正确"
_LOGIN_REQUIRED = "未登录"
_COOKIE_NAME = "login"
_COOKIE_MAX_AGE = 7 * 24 * 60 * 60
_SERVER_ERROR = "服务器错误"
_NO_LANGUAGE = "账号没有语言设置"
_running: set[asyncio.Task[None]] = set()


class _Relay:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[str | None] = asyncio.Queue()
        self.started = asyncio.Event()
        self.failed = False
        self.sent = False


app = FastAPI(lifespan=_lifespan)


class _RefreshLoginCookie:
    def __init__(self, asgi_app: ASGIApp) -> None:
        self._asgi_app = asgi_app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._asgi_app(scope, receive, send)
            return

        cookie = Request(scope).cookies.get(_COOKIE_NAME)
        refresh = cookie is not None and _cookie_is_valid(cookie)

        async def send_with_refresh(message: Message) -> None:
            starting = message["type"] == "http.response.start"
            if starting and refresh and cookie is not None:
                headers = MutableHeaders(raw=message["headers"])
                already_set = any(
                    value.startswith(f"{_COOKIE_NAME}=")
                    for value in headers.getlist("set-cookie")
                )
                if not already_set:
                    fresh = Response()
                    _set_login_cookie(fresh, cookie)
                    headers.append("set-cookie", fresh.headers["set-cookie"])
            await send(message)

        await self._asgi_app(scope, receive, send_with_refresh)


app.add_middleware(_RefreshLoginCookie)


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
    _sweep_expired_tokens()
    with db_session() as session:
        result, token = _login_account(session, body.username, body.password)

    _set_login_cookie(response, token)
    return result


@app.post("/api/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    with db_session() as session:
        token = _login_token(session, login_cookie)
        if token is None:
            result = JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED,
                content={"detail": _LOGIN_REQUIRED},
            )
            _clear_login_cookie(result)
            return result
        session.delete(token)

    result = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_login_cookie(result)
    return result


@app.get("/api/profile")
def read_profile(
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> ProfileResponse:
    with db_session() as session:
        return _profile(_account_from_cookie(session, login_cookie))


@app.patch("/api/profile")
def update_profile(
    body: ProfileUpdate,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> ProfileResponse:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        language = account.language_setting
        if language is None:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _NO_LANGUAGE)
        language.locale = body.locale
        return _profile(account)


@app.get("/api/sessions")
def list_sessions(
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> list[SessionItem]:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        return _session_items(account)


@app.post("/api/sessions")
def create_session(
    body: SessionCreate | None = None,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> SessionItem:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        created = ChatSession(account=account)
        if body is not None:
            created.title = body.title
        session.add(created)
        session.flush()
        session.refresh(created)
        return _session_item(created)


@app.patch("/api/sessions/{session_id}")
def rename_session(
    session_id: UUID,
    body: SessionRename,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> SessionItem:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        chat_session = _require_session(session, account, session_id)
        chat_session.title = body.title
        return _session_item(chat_session)


@app.patch("/api/sessions/{session_id}/pin")
def pin_session(
    session_id: UUID,
    body: SessionPin,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> SessionItem:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        chat_session = _require_session(session, account, session_id)
        chat_session.pinned = body.pinned
        chat_session.pinned_at = body.pinned_at
        return _session_item(chat_session)


@app.delete("/api/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: UUID,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    fastgpt = _fastgpt()
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        _require_session(session, account, session_id)

    try:
        await fastgpt.delete_history(session_id)
    except FastGPTError:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            _SERVER_ERROR,
        ) from None

    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        chat_session = _require_session(session, account, session_id)
        session.delete(chat_session)

    discard_reply(session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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


@app.get("/api/sessions/{session_id}/messages")
async def read_session_messages(
    session_id: UUID,
    offset: Annotated[int, Query(ge=0)],
    page_size: Annotated[int, Query(ge=1)],
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> HistoryResponse:
    fastgpt = _fastgpt()

    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        _require_session(session, account, session_id)

    try:
        page = await fastgpt.records(session_id, offset, page_size)
    except FastGPTError:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            _SERVER_ERROR,
        ) from None

    return HistoryResponse(
        total=page.total,
        messages=[
            HistoryMessageResponse(id=item.id, role=item.role, text=item.text)
            for item in page.records
        ],
    )


@app.post("/api/chat")
async def chat(
    body: ChatRequest,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    # 排查流式输出用，确认后再收窄。这里只有对话正文，没有登录 cookie。
    logger.info("对话请求 %s", body.model_dump_json(by_alias=True))
    fastgpt = _fastgpt()

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
                outgoing = _chunk(event)
                logger.info("发给页面 %s", outgoing.removesuffix("\n\n"))
                await relay.queue.put(outgoing)
                relay.sent = True
                relay.started.set()
                continue

            mark_finished(chat_id)
            logger.info("发给页面 %s", "data: [DONE]")
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


def _fastgpt() -> FastGPT:
    missing = empty_fastgpt_fields(load_settings())
    if missing:
        logger.error("FastGPT 配置为空：%s", "、".join(missing))
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _SERVER_ERROR)

    fastgpt = app.state.fastgpt
    if not isinstance(fastgpt, FastGPT):
        logger.error("FastGPT 客户端未建立")
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _SERVER_ERROR)
    return fastgpt


def _require_session(
    session: Session,
    account: Account,
    session_id: UUID,
) -> ChatSession:
    found = session.scalar(
        select(ChatSession).where(
            ChatSession.id == session_id,
            ChatSession.account_id == account.id,
        ),
    )
    if not isinstance(found, ChatSession):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "会话不存在")
    return found


def _login_account(
    session: Session,
    username: str,
    password: str,
) -> tuple[LoginResponse, str]:
    account = session.scalar(select(Account).where(Account.username == username))
    if not isinstance(account, Account):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    hasher = PasswordHasher()
    if not _password_matches(hasher, account.password_hash, password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    if hasher.check_needs_rehash(account.password_hash):
        account.password_hash = hasher.hash(password)

    language = account.language_setting
    if language is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _NO_LANGUAGE)

    token = secrets.token_urlsafe(32)
    session.add(LoginToken(
        account=account,
        token_hash=_token_hash(token),
        expires_at=_login_deadline(),
    ))
    result = LoginResponse(
        locale=language.locale,
        sessions=_session_items(account),
    )
    return result, token


def _account_from_cookie(session: Session, login_cookie: str | None) -> Account:
    token = _login_token(session, login_cookie)
    if token is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _LOGIN_REQUIRED)
    return token.account


def _login_token(session: Session, login_cookie: str | None) -> LoginToken | None:
    if login_cookie is None or login_cookie == "":
        return None

    _sweep_expired_tokens()
    token = session.scalar(
        select(LoginToken).where(LoginToken.token_hash == _token_hash(login_cookie)),
    )
    if not isinstance(token, LoginToken):
        return None
    token.expires_at = _login_deadline()
    return token


def _login_deadline() -> datetime:
    return datetime.now(UTC) + timedelta(seconds=_COOKIE_MAX_AGE)


def _sweep_expired_tokens() -> None:
    with db_session() as session:
        session.execute(
            delete(LoginToken).where(
                LoginToken.expires_at <= datetime.now(UTC),
            ),
        )


def _profile(account: Account) -> ProfileResponse:
    language = account.language_setting
    if language is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _NO_LANGUAGE)

    locale = language.locale
    if locale != "zh-CN" and locale != "zh-TW" and locale != "en":
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _NO_LANGUAGE)
    return ProfileResponse(id=account.id, username=account.username, locale=locale)


def _cookie_is_valid(login_cookie: str) -> bool:
    with db_session() as session:
        return _login_token(session, login_cookie) is not None


def _set_login_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=_COOKIE_NAME,
        value=token,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        path="/",
    )


def _clear_login_cookie(response: Response) -> None:
    response.delete_cookie(
        key=_COOKIE_NAME,
        path="/",
        httponly=True,
        samesite="lax",
    )


def _session_items(account: Account) -> list[SessionItem]:
    return [_session_item(item) for item in account.sessions]


def _session_item(item: ChatSession) -> SessionItem:
    return SessionItem(
        id=item.id,
        title=item.title,
        pinned=item.pinned,
        pinned_at=item.pinned_at,
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
