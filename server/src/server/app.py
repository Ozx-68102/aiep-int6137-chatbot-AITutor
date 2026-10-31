import asyncio
import hashlib
import json
import logging
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
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
from sqlalchemy import delete, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from server.db import Account, ChatSession, LoginToken, db_session
from server.fastgpt import ChatRecord, FastGPT, FastGPTError, open_fastgpt
from server.reply_store import (
    FAILED,
    STREAMING,
    PartialReply,
    append_chunk,
    begin_reply,
    current_turn_id,
    discard_reply,
    mark_aborted,
    mark_failed,
    mark_finished,
    read_partial,
    request_stop,
    round_in_flight,
    stop_requested,
    store_available,
)
from server.settings import load_settings
from server.types import (
    AbortRequest,
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
    StatusResponse,
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
_STATUS_PATH = "/api/status"
_SERVER_ERROR = "服务器错误"
_NO_LANGUAGE = "账号没有语言设置"
_ROUND_BUSY = "这一场会话还有一轮在写，等它答完再发"
_UPSTREAM_ERROR = "暂时问不到上游，请稍后重试"
_running: dict[UUID, set[asyncio.Task[None]]] = {}
_stop_tasks: set[asyncio.Task[None]] = set()
# 失败时叫停的那几下：要等它们落地（停止标记晚到的话，
# 新开的那一轮会被自己人写的标记掐掉）。
_pending_stops: dict[UUID, set[asyncio.Task[None]]] = {}
_STOP_WAIT_SECONDS = 7.0
_records_cache: dict[UUID, tuple[float, list[ChatRecord]]] = {}
_RECORDS_CACHE_SECONDS = 5.0
_RECORDS_PAGE_SIZE = 100


class _Relay:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[str | None] = asyncio.Queue()
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
        # 状态检查是心跳，不该把登录有效期往后推。
        refresh = (
            scope.get("path") != _STATUS_PATH
            and cookie is not None
            and _cookie_is_valid(cookie)
        )

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

    # 这里只记一行。栈由 uvicorn 打一遍就够，打两遍会把日志撑爆。
    logger.error("请求失败 %s %s：%s", request.method, request.url.path, exc)
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


@app.get("/api/status")
def read_status() -> StatusResponse:
    """页面用它做常驻提示。只报状态，不带任何内容，也不需要登录。"""
    return StatusResponse(
        database="ok" if _database_available() else "unavailable",
        reply_store="ok" if store_available() else "unavailable",
    )


def _database_available() -> bool:
    try:
        with db_session() as session:
            session.execute(select(1))
        return True
    except SQLAlchemyError:
        logger.warning("数据库不可用", exc_info=True)
        return False


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
    await asyncio.to_thread(_authorize_session, session_id, login_cookie)

    try:
        await fastgpt.delete_history(session_id)
    except FastGPTError:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            _SERVER_ERROR,
        ) from None

    await asyncio.to_thread(_delete_session_row, session_id, login_cookie)
    discard_reply(session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/sessions/{session_id}/abort", status_code=status.HTTP_204_NO_CONTENT)
async def abort_session_reply(
    session_id: UUID,
    body: AbortRequest | None = None,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    """用户按了停止：掐掉这一轮的上游任务。已经写出来的半截文字留着。

    先把停止记下来，再取消任务：这样即使这一轮还没开始（停止请求先到），
    后到的对话请求也会看到这个编号，不再开这一轮。
    """
    await asyncio.to_thread(_authorize_session, session_id, login_cookie)

    turn_id = str(body.turn_id) if body is not None and body.turn_id is not None else ""
    if turn_id == "":
        # 页面没带编号就用当前这一轮的编号。
        turn_id = current_turn_id(session_id)
    request_stop(session_id, turn_id)

    task = _running.get(session_id)
    if not task:
        # 这一轮已经结束了，或者还没开始。不用改状态。
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # 告诉上游停下。v2 的停止是运行态标记，上游看到就收手；v1 只能靠断连接，
    # 那一招在 v2 上不管用。这个接口自己会等上游收尾（最多五秒），所以不等它。
    _ask_upstream_to_stop(session_id)

    for running in task:
        running.cancel()
    # 等这一轮真的收尾（状态改成 aborted），页面随后读到的才是最终状态，
    # 不会读到还在写的中间状态。
    await asyncio.wait(task, timeout=2.0)
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
    return PartialReplyResponse(
        status=partial.status,
        text=partial.text,
        turn_id=partial.turn_id,
        question=partial.question,
    )


@app.get("/api/sessions/{session_id}/messages")
async def read_session_messages(
    session_id: UUID,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> HistoryResponse:
    """一场会话的完整线程：FastGPT 的历史，加上正在写的这一轮。"""
    fastgpt = _fastgpt()

    await asyncio.to_thread(_authorize_session, session_id, login_cookie)

    try:
        records = await _session_records(session_id, fastgpt)
    except FastGPTError:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            _UPSTREAM_ERROR,
        ) from None

    messages = _merge_current_turn(records, read_partial(session_id))
    return HistoryResponse(total=len(messages), messages=messages)


async def _session_records(
    session_id: UUID,
    fastgpt: FastGPT,
    cached: bool = True,
) -> list[ChatRecord]:
    """一场会话的全部历史。

    刷新一次页面就要读一次历史，刷新得急了会把上游打垮（实测：上游连不上了，
    每次失败在日志里留下两百多行）。这里留几秒的缓存：刷新多少次，
    上游就只被问一次。

    找记录要删的时候不能读缓存：缓存里可能是这一轮之前的那份，
    少了刚写上去的那条。
    """
    now = time.monotonic()
    if cached:
        stored = _records_cache.get(session_id)
        if stored is not None and now - stored[0] < _RECORDS_CACHE_SECONDS:
            return stored[1]

    records: list[ChatRecord] = []
    offset = 0
    while True:
        page = await fastgpt.records(session_id, offset, _RECORDS_PAGE_SIZE)
        records.extend(page.records)
        offset += _RECORDS_PAGE_SIZE
        if offset >= page.total:
            break

    _records_cache[session_id] = (now, records)
    _drop_stale_records(now)
    return records


def _drop_stale_records(now: float) -> None:
    for key in [
        key
        for key, (stamp, _) in _records_cache.items()
        if now - stamp > _RECORDS_CACHE_SECONDS * 20
    ]:
        del _records_cache[key]


def _merge_current_turn(
    records: list[ChatRecord],
    partial: PartialReply,
) -> list[HistoryMessageResponse]:
    """把 Redis 里当前这一轮接在历史后面。

    历史来自 FastGPT：写完的轮次都在里面。正在写的那一轮还没落库，
    刷新以后要靠 Redis 里这份把它补回来，这样用户提问和三个点都还在。
    """
    messages = [
        HistoryMessageResponse(id=item.id, role=item.role, text=item.text)
        for item in records
    ]
    if partial.turn_id is None:
        return messages

    # 这一轮已经落在 FastGPT 的历史里了（回答的编号就是我们的编号），不用再补。
    if any(item.id == partial.turn_id for item in messages):
        return messages

    last = messages[-1] if messages else None
    if partial.question is not None and not (
        last is not None
        and last.role == "user"
        and last.text.strip() == partial.question.strip()
    ):
        messages.append(
            HistoryMessageResponse(
                id=f"{partial.turn_id}-q",
                role="user",
                text=partial.question,
                turn_id=partial.turn_id,
            )
        )

    messages.append(
        HistoryMessageResponse(
            id=partial.turn_id,
            role="assistant",
            text=partial.text,
            turn_id=partial.turn_id,
            waiting=partial.status == STREAMING,
            failed=partial.status == FAILED,
        )
    )
    return messages


async def _clear_failed_turn(
    chat_id: UUID,
    turn_id: UUID,
    question: str,
    fastgpt: FastGPT,
) -> None:
    """删掉上一轮在上游留下的记录。

    重发的是同一句提问，上游会再记一遍。不删的话，历史里就有两遍问答。
    回答那一条的编号是我们给的（responseChatItemId），提问那一条要从记录里找。
    """
    try:
        records = await _session_records(chat_id, fastgpt, cached=False)
    except FastGPTError:
        logger.warning("读不到上游记录，重发的这一轮删不掉旧的 %s", chat_id)
        return

    content_ids = _failed_turn_content_ids(records, str(turn_id), question)
    for content_id in content_ids:
        if not await fastgpt.delete_item(chat_id, content_id):
            logger.warning("删不掉上游记录 %s", content_id)
    if content_ids:
        _records_cache.pop(chat_id, None)


def _failed_turn_content_ids(
    records: list[ChatRecord],
    turn_id: str,
    question: str,
) -> list[str]:
    """要删的记录：回答（我们的编号）和它前面那条提问。"""
    for index, record in enumerate(records):
        if record.role != "assistant" or record.id != turn_id:
            continue
        ids = [record.id]
        if index > 0 and records[index - 1].role == "user":
            ids.append(records[index - 1].id)
        return ids

    # 回答没写下来（上游在写之前就断了）：提问那条还在。
    # 只有它就是最后一条记录时才删：这一轮是最近的一轮，
    # 失败以后用户又问了别的，那条记录就不是我们的，不能删。
    if not records:
        return []
    last = records[-1]
    if last.role == "user" and last.text.strip() == question.strip():
        return [last.id]
    return []


@app.post("/api/chat")
async def chat(
    body: ChatRequest,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    # 排查流式输出用，确认后再收窄。这里只有对话正文，没有登录 cookie。
    logger.info("对话请求 %s", body.model_dump_json(by_alias=True))
    fastgpt = _fastgpt()

    await asyncio.to_thread(_authorize_session, body.chat_id, login_cookie)

    turn_id = str(body.turn_id)

    # 同一个请求又来了（重复点击、页面重发）：这一轮已经登记过了，
    # 不能再开一轮，不然上游会生成两遍。
    if current_turn_id(body.chat_id) == turn_id:
        if round_in_flight(body.chat_id):
            raise HTTPException(status.HTTP_409_CONFLICT, _ROUND_BUSY)
        logger.info("这一轮已经登记过 %s，不再重开", body.chat_id)
        return StreamingResponse(_empty_sse(), media_type="text/event-stream")

    # 同一场会话同时只跑一轮。上一轮还在写的时候再发一次，
    # FastGPT 那边会多出一轮，Redis 里的半截文字也会被清掉重来，两轮的片段交错着写。
    if round_in_flight(body.chat_id):
        raise HTTPException(status.HTTP_409_CONFLICT, _ROUND_BUSY)

    if stop_requested(body.chat_id, turn_id):
        # 用户在对话请求到达之前就按了停止：这一轮不开。
        # 提问照样登记，刷新以后还能看到「问了什么、这一轮被停了」。
        begin_reply(body.chat_id, turn_id, body.message)
        mark_aborted(body.chat_id)
        logger.info("这一轮发出之前就被停止 %s", body.chat_id)
        return StreamingResponse(_empty_sse(), media_type="text/event-stream")

    # 之前叫停上游的那一下要落地：停止标记晚到的话，
    # 新开的这一轮会被自己人写的标记掐掉。
    await _wait_for_stop(body.chat_id)

    # 重发：把上一轮在上游留下的记录删掉，历史里才不会出现两遍问答。
    if body.retry_of is not None:
        await _clear_failed_turn(body.chat_id, body.retry_of, body.message, fastgpt)

    # 先登记这一轮，页面断流之后才知道请求有没有落地。
    begin_reply(body.chat_id, turn_id, body.message)
    relay = _Relay()
    task = asyncio.create_task(
        _relay(body.chat_id, body.message, turn_id, relay, fastgpt)
    )
    _running.setdefault(body.chat_id, set()).add(task)
    task.add_done_callback(lambda done: _forget(body.chat_id, done))
    # 先把响应头发出去，页面的等待气泡立刻就转起来。
    # 上游出问题时流会直接结束（没有 [DONE]），页面据此判断这一轮没写完。
    return StreamingResponse(_sse(relay), media_type="text/event-stream")


async def _relay(
    chat_id: UUID,
    message: str,
    turn_id: str,
    relay: _Relay,
    fastgpt: FastGPT,
) -> None:
    try:
        async for event in fastgpt.events(chat_id, message, turn_id):
            if isinstance(event, str):
                append_chunk(chat_id, event)
                outgoing = _chunk(event)
                logger.info("发给页面 %s", outgoing.removesuffix("\n\n"))
                await relay.queue.put(outgoing)
                relay.sent = True
                continue

            mark_finished(chat_id)
            logger.info("发给页面 %s", "data: [DONE]")
            await relay.queue.put("data: [DONE]\n\n")
            relay.sent = True
            break
        else:
            relay.failed = True
    except asyncio.CancelledError:
        # 用户按了停止。状态在这里写：任务被掐掉时它确实还在写，
        # 页面轮询 /partial 时就能看到 aborted。
        logger.info("这一轮被停止 %s", chat_id)
        mark_aborted(chat_id)
        raise
    except FastGPTError:
        relay.failed = True
    except Exception as exc:
        logger.error("FastGPT 读取失败 %s", chat_id, exc_info=exc)
        relay.failed = True
    finally:
        try:
            if relay.failed:
                if relay.sent:
                    mark_failed(chat_id)
                else:
                    discard_reply(chat_id)
        finally:
            # 不能 await：任务被取消时再 await 会把取消吞掉。
            relay.queue.put_nowait(None)
        # 失败以后也要叫上游收手。v2 不看连接断没断，不叫停的话
        # 上游会把这一轮写完：token 白花，那条记录还会晚到我们的历史里。
        # 放在结束流以后叫：页面不用等这一下。
        # 这一下要等它落地：那时候上游可能正卡着，请求过去得慢一些。
        if relay.failed:
            _ask_upstream_to_stop(chat_id, wait=True)


def _forget(chat_id: UUID, task: asyncio.Task[None]) -> None:
    tasks = _running.get(chat_id)
    if tasks is None:
        return
    tasks.discard(task)
    if not tasks:
        del _running[chat_id]


async def _sse(relay: _Relay) -> AsyncIterator[str]:
    while True:
        item = await relay.queue.get()
        if item is None:
            break
        yield item


async def _empty_sse() -> AsyncIterator[str]:
    """这一轮被停止了：流直接结束，没有 [DONE]。"""
    for piece in ():
        yield piece


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


def _upstream_client() -> FastGPT | None:
    """上游客户端没有就返回 None。

    停止是尽力而为：上游连不上不能让停止接口整个失败，
    我们自己的状态（Redis 里的停止标记）才是页面要看的东西。
    """
    fastgpt = app.state.fastgpt
    if not isinstance(fastgpt, FastGPT):
        return None
    return fastgpt


def _ask_upstream_to_stop(session_id: UUID, wait: bool = False) -> None:
    """给上游发停止请求，不等它返回。

    wait 为真时把它记在会话上：开新一轮之前要等它落地
    （停止标记晚到的话，新开的那一轮会被自己人写的标记掐掉）。
    按停止那条路不用等：那时候上游还好好着，标记很快就写进去了。
    """
    task = asyncio.create_task(_stop_upstream(session_id))
    _stop_tasks.add(task)
    task.add_done_callback(_stop_tasks.discard)
    if wait:
        _pending_stops.setdefault(session_id, set()).add(task)
        task.add_done_callback(lambda done: _forget_pending_stop(session_id, done))


def _forget_pending_stop(session_id: UUID, task: asyncio.Task[None]) -> None:
    tasks = _pending_stops.get(session_id)
    if tasks is None:
        return
    tasks.discard(task)
    if not tasks:
        del _pending_stops[session_id]


async def _wait_for_stop(session_id: UUID) -> None:
    """等叫停上游的那几下落定。

    停止是一个运行态标记：标记写进去，上游才会在下一个节点边界收手。
    标记晚到的话，新开的那一轮会被自己人写的停止标记掐掉。
    """
    tasks = _pending_stops.get(session_id)
    if not tasks:
        return
    await asyncio.wait(list(tasks), timeout=_STOP_WAIT_SECONDS)


async def _stop_upstream(session_id: UUID) -> None:
    fastgpt = _upstream_client()
    if fastgpt is None:
        logger.warning("上游客户端没建起来 %s，这一轮停不了上游", session_id)
        return
    try:
        stopped = await fastgpt.stop_chat(session_id)
    except Exception:
        logger.error("上游停止失败 %s", session_id, exc_info=True)
        return
    logger.info(
        "上游停止 %s：%s", session_id, "上游收到了" if stopped else "上游没回成功"
    )


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


def _authorize_session(session_id: UUID, login_cookie: str | None) -> None:
    """确认这场会话是这个账号的。

    数据库是同步的，接口是异步的：这一步要放到线程里跑，
    别把事件循环卡住（卡住的时候，正在流式输出的那一轮也发不出去）。
    """
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        _require_session(session, account, session_id)


def _delete_session_row(session_id: UUID, login_cookie: str | None) -> None:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        chat_session = _require_session(session, account, session_id)
        session.delete(chat_session)


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
    session.add(
        LoginToken(
            account=account,
            token_hash=_token_hash(token),
            expires_at=_login_deadline(),
        )
    )
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
