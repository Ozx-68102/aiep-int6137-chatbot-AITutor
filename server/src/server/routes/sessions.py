"""会话路由：列表、创建、改名、置顶、删除、停止、半截读取、消息与反馈。

从 app.py 抽出：路径、状态码与端点行为原样保留。session_items/session_item
是公开辅助（routes/auth.py 组装登录响应时要用）。
"""

import asyncio
import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Cookie, HTTPException, Response, status
from sqlalchemy import delete

from server import chat_log
from server.db import Account, ChatMessage, ChatSession, db_session
from server.errors import SERVER_ERROR
from server.fastgpt import FastGPTError
from server.history import backfill_session, merge_current_turn
from server.log import set_turn_context
from server.reply_store import (
    current_turn_id,
    discard_reply,
    read_partial,
    request_stop,
)
from server.security import (
    COOKIE_NAME,
    account_from_cookie,
    authorize_session,
    require_session,
)
from server.streaming import registry
from server.streaming.stopping import ask_upstream_to_stop
from server.turn_status import STREAMING
from server.types import (
    AbortRequest,
    FeedbackUpdate,
    HistoryResponse,
    PartialReplyResponse,
    SessionCreate,
    SessionItem,
    SessionPin,
    SessionRename,
)
from server.upstream import require_client

logger = logging.getLogger("server.routes.sessions")

router = APIRouter()

# /partial 只回答「还在写吗」：其余一切情况的 404 都是这句话。
_PARTIAL_NOT_STREAMING = "这一轮已经不在写了"
# 点赞点踩（第四期）：轮次找不到、上游没收到，各一句。detail 一律字符串。
_FEEDBACK_TURN_MISSING = "找不到这一轮，没法记反馈"
_FEEDBACK_UPSTREAM_ERROR = "反馈没送到，稍后再试"


@router.get("/api/sessions")
def list_sessions(
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> list[SessionItem]:
    with db_session() as session:
        account = account_from_cookie(session, login_cookie)
        return session_items(account)


@router.post("/api/sessions")
def create_session(
    body: SessionCreate | None = None,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> SessionItem:
    with db_session() as session:
        account = account_from_cookie(session, login_cookie)
        created = ChatSession(account=account)
        if body is not None:
            created.title = body.title
        session.add(created)
        session.flush()
        session.refresh(created)
        return session_item(created)


@router.patch("/api/sessions/{session_id}")
def rename_session(
    session_id: UUID,
    body: SessionRename,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> SessionItem:
    with db_session() as session:
        account = account_from_cookie(session, login_cookie)
        chat_session = require_session(session, account, session_id)
        chat_session.title = body.title
        return session_item(chat_session)


@router.patch("/api/sessions/{session_id}/pin")
def pin_session(
    session_id: UUID,
    body: SessionPin,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> SessionItem:
    with db_session() as session:
        account = account_from_cookie(session, login_cookie)
        chat_session = require_session(session, account, session_id)
        chat_session.pinned = body.pinned
        chat_session.pinned_at = body.pinned_at
        return session_item(chat_session)


@router.delete("/api/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: UUID,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> Response:
    await asyncio.to_thread(authorize_session, session_id, login_cookie)
    # 配置检查放在鉴权之后（同 /api/chat 的理由）。
    fastgpt = require_client()

    try:
        await fastgpt.delete_history(session_id)
    except FastGPTError:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            SERVER_ERROR,
        ) from None

    await asyncio.to_thread(_delete_session_row, session_id, login_cookie)
    discard_reply(session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/api/sessions/{session_id}/abort", status_code=status.HTTP_204_NO_CONTENT)
async def abort_session_reply(
    session_id: UUID,
    body: AbortRequest | None = None,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> Response:
    """用户按了停止：掐掉这一轮的上游任务。已经写出来的半截文字留着。

    先把停止记下来，再取消任务：这样即使这一轮还没开始（停止请求先到），
    后到的对话请求也会看到这个编号，不再开这一轮。
    """
    await asyncio.to_thread(authorize_session, session_id, login_cookie)

    turn_id = str(body.turn_id) if body is not None and body.turn_id is not None else ""
    if turn_id == "":
        # 页面没带编号就用当前这一轮的编号。
        turn_id = current_turn_id(session_id)
    # 停止这一侧的日志行也带上轮次编号，跟对话那一侧的日志对得上。
    set_turn_context(turn_id)
    request_stop(session_id, turn_id)

    task = registry.running.get(session_id)
    if not task:
        # 这一轮已经结束了，或者还没开始。不用改状态。
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # 告诉上游停下。v2 的停止是运行态标记，上游看到就收手；v1 只能靠断连接，
    # 那一招在 v2 上不管用。这个接口自己会等上游收尾（最多五秒），所以不等它。
    ask_upstream_to_stop(session_id)

    for running in task:
        running.cancel()
    # 等这一轮真的收尾（状态改成 aborted），页面随后读到的才是最终状态，
    # 不会读到还在写的中间状态。
    await asyncio.wait(task, timeout=2.0)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/api/sessions/{session_id}/partial")
def read_session_partial(
    session_id: UUID,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> PartialReplyResponse:
    """「还在写吗」——只回答这一个问题。

    Redis 里这场会话的状态是 streaming 才回 200（半截文字、轮次编号、
    提问）；其余一切情况（写完了/失败/被停/键不存在）一律 404，页面去
    读库。结局语义不再由这个接口承担：即时结局随流的 done 帧走，永久
    结局在库的 message.status 上（docs/CHAT_STREAM_PROTOCOL.md
    「刷新续传与断流恢复」一节，2026-11-05 维护者拍板）。Redis 读不通照旧抛错（500）：
    那是「问不到服务器」，不是「没在写」，客户端靠状态码区分这两种。
    """
    with db_session() as session:
        account = account_from_cookie(session, login_cookie)
        require_session(session, account, session_id)

    partial = read_partial(session_id)
    if partial.status != STREAMING:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _PARTIAL_NOT_STREAMING)
    return PartialReplyResponse(
        status=STREAMING,
        text=partial.text,
        turn_id=partial.turn_id,
        question=partial.question,
    )


@router.get("/api/sessions/{session_id}/messages")
async def read_session_messages(
    session_id: UUID,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> HistoryResponse:
    """一场会话的完整线程：我们自己存的记录，加上正在写的这一轮。

    历史来自我们自己的表，不是 FastGPT：它清库、上游挂掉，页面照样看得见。
    老会话第一次读到的时候，把上游那一份抄一份过来。
    """
    await asyncio.to_thread(authorize_session, session_id, login_cookie)

    stored = await asyncio.to_thread(chat_log.read_messages, session_id)
    if not stored:
        stored = await backfill_session(session_id)

    messages = merge_current_turn(stored, read_partial(session_id))
    return HistoryResponse(total=len(messages), messages=messages)


@router.post(
    "/api/sessions/{session_id}/feedback", status_code=status.HTTP_204_NO_CONTENT
)
async def update_feedback(
    session_id: UUID,
    body: FeedbackUpdate,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> Response:
    """把一轮的点赞/点踩送到上游（docs/MESSAGE_ACTIONS.md 第四期）。

    反馈不存在我们库里：上游按 dataId（就是我们的轮次编号）记在那条
    回答上。没有轮次编号、或者这场会话的表里没有这一轮，都是 404——
    映射不到上游的 dataId，发过去也是打空。上游没收到是 502。
    """
    await asyncio.to_thread(authorize_session, session_id, login_cookie)
    # 配置检查放在鉴权之后（同 /api/chat 的理由）。
    fastgpt = require_client()
    if body.turn_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _FEEDBACK_TURN_MISSING)
    has_turn = await asyncio.to_thread(chat_log.has_turn, session_id, body.turn_id)
    if not has_turn:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _FEEDBACK_TURN_MISSING)
    try:
        await fastgpt.update_feedback(session_id, str(body.turn_id), body.feedback)
    except FastGPTError:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            _FEEDBACK_UPSTREAM_ERROR,
        ) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _delete_session_row(session_id: UUID, login_cookie: str | None) -> None:
    with db_session() as session:
        account = account_from_cookie(session, login_cookie)
        chat_session = require_session(session, account, session_id)
        # 消息先删：它有外键指着这场会话。
        session.execute(delete(ChatMessage).where(ChatMessage.session_id == session_id))
        session.delete(chat_session)


def session_items(account: Account) -> list[SessionItem]:
    return [session_item(item) for item in account.sessions]


def session_item(item: ChatSession) -> SessionItem:
    return SessionItem(
        id=item.id,
        title=item.title,
        pinned=item.pinned,
        pinned_at=item.pinned_at,
        created_at=item.created_at,
    )
