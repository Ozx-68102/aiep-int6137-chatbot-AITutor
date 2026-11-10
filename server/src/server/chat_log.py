"""我们自己存的会话记录。

FastGPT 那边也有一份，但那是它工作流的副产品：它清库就没了，
被按停止的那一轮还会留下一条只有提问的记录。这里存一份我们自己说了算的。

分工写在这里，以后改动照着来：

- 模型看到什么：FastGPT（我们传 chatId，历史由它拼，最近 6 轮）。
- 用户看到什么：这张表。

两边不一致时以这张表为准：它是用户当时看见的那一份。
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID, uuid4

from sqlalchemy import CursorResult, delete, func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from server.db import ChatMessage, db_session
from server.turn_status import ABORTED, COMPLETED, FAILED, STREAMING
from server.upstream import ChatRecord

logger = logging.getLogger("server.chat_log")

ROLE_USER = "user"
ROLE_ASSISTANT = "assistant"


@dataclass(frozen=True)
class StoredMessage:
    id: str
    turn_id: str
    role: Literal["user", "assistant"]
    text: str
    status: str
    # 会话里的先后序号：排查工具（server.turn_dump）对齐行用。
    seq: int


@dataclass(frozen=True)
class StoredRound:
    """一轮问答。answer 是 None 表示这一轮只有提问（被按停止的那种）。"""

    turn_id: UUID
    question: str
    answer: str | None
    status: str


def begin_round(session_id: UUID, turn_id: UUID, question: str) -> bool:
    """记下这一轮开始。返回提问和回答的占位行是否写进数据库。

    提问先写进去，回答的位置先占着（状态是 streaming）：我们的进程要是
    中途死了，这一轮就留在 streaming 状态，读线程看得出来，
    还能按编号去上游把答案找回来。

    返回值要一路传下去：这里没写成，结束时就更正不到任何行（见
    finish_round），摘要行得让人看得出这一轮根本没进表。
    """

    def action(session: Session) -> None:
        _delete_turn_rows(session, session_id, turn_id)
        base = _next_seq(session, session_id)
        session.add(
            ChatMessage(
                session_id=session_id,
                turn_id=turn_id,
                role=ROLE_USER,
                text=question,
                status=STREAMING,
                seq=base,
            )
        )
        session.add(
            ChatMessage(
                session_id=session_id,
                turn_id=turn_id,
                role=ROLE_ASSISTANT,
                text="",
                status=STREAMING,
                seq=base + 1,
            )
        )

    return _write("begin_round", session_id, action)


def finish_round(session_id: UUID, turn_id: UUID, text: str, status: str) -> bool:
    """这一轮结束：写上最后的状态和文字。返回是否写进数据库（摘要行用）。

    事务提交成功不等于这一轮写进去了：开始时写库失败过（begin_round 返回
    假，提问和回答的占位行没建成），结束时更正匹配不到任何行——事务照样
    成功提交，一行都没动。这里把「一行都没匹配到」也判为没写成，否则摘要
    行会显示 db_written=true，而表里根本没有这一轮。
    """
    matched = 0

    def action(session: Session) -> None:
        nonlocal matched
        rows = _turn_rows(session, session_id, turn_id)
        matched = len(rows)
        for row in rows:
            row.status = status
            if row.role == ROLE_ASSISTANT:
                row.text = text

    written = _write("finish_round", session_id, action)
    if written and matched == 0:
        logger.warning(
            "这一轮在表里找不到，开始时可能就没写进去 %s %s", session_id, turn_id
        )
        return False
    return written


def delete_round(session_id: UUID, turn_id: UUID) -> None:
    """删掉一轮的记录。重发的时候用：上一轮的记录要跟着上游一起删掉。"""

    def action(session: Session) -> None:
        _delete_turn_rows(session, session_id, turn_id)

    _write("delete_round", session_id, action)


def delete_session_messages(session_id: UUID) -> None:
    """删掉一场会话的全部记录。删会话的时候用。"""

    def action(session: Session) -> None:
        session.execute(delete(ChatMessage).where(ChatMessage.session_id == session_id))

    _write("delete_session_messages", session_id, action)


def fail_stuck_rounds() -> int:
    """启动核对：把表里所有 status=streaming 的行一次标成 failed。

    单进程前提（docs/CHAT_STREAM_PROTOCOL.md「单进程前提」一节）：进程重启时
    不可能有「还在写」的轮次——那些行必是已中止却仍标着「在写」的轮次（写它的进程已经随旧进程
    死了）。读时保底修正（history.merge_current_turn）同样会把它们降级展示，
    这里把数据库一次清干净。返回受影响的行数；写进数据库失败只记警告。
    """
    try:
        with db_session() as session:
            result = cast(
                CursorResult,
                session.execute(
                    update(ChatMessage)
                    .where(ChatMessage.status == STREAMING)
                    .values(status=FAILED)
                ),
            )
            return int(result.rowcount or 0)
    except SQLAlchemyError:
        logger.warning("启动核对失败，卡住的 streaming 行保持原样", exc_info=True)
        return 0


def read_messages(session_id: UUID) -> list[StoredMessage]:
    """一场会话的记录，按先后顺序。数据库错误如实上抛。

    这里是 HTTP 读路径（GET messages；history.backfill_session 复制完也走
    这里），SQLAlchemyError 由路由捕获后回 503。不能忽略异常返回空列表：
    那样路由回 200 加空历史，把数据库故障伪装成「没有消息」，页面分不清
    是数据库出错还是这场会话真是空的。
    对比下面的 _write：轮次进行中的写进数据库失败是故意忽略的（归档降级，上游
    还有一份保底）。读写两个方向语义不同，别强行对齐。
    """
    with db_session() as session:
        rows = session.scalars(
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.seq)
        ).all()
        # 在会话还开着的时候把内容取出来：会话一关，这些行就读不到了。
        return [
            StoredMessage(
                id=str(row.id),
                turn_id=str(row.turn_id),
                role=ROLE_USER if row.role == ROLE_USER else ROLE_ASSISTANT,
                text=row.text,
                status=row.status,
                seq=row.seq,
            )
            for row in rows
        ]


def read_question(session_id: UUID, turn_id: UUID) -> str | None:
    """读出这一轮用户提问的文本。查不到或读数据库失败返回 None。

    删轮之前用：重发时旧轮可能只在上游留下一条悬空提问记录，
    请求体里带的可能是新文字（编辑重发），只有表里的原文才能和它对上。
    要在 delete_round 删行之前调用，行删了就查不到了。

    忽略数据库错误是有意的：这里是聊天重发路径，不是 HTTP 读端点，
    读不到原文只是退化成「找不到悬空记录」，不该让重发整个失败。
    如实上抛的读路径见 read_messages。
    """
    try:
        with db_session() as session:
            return session.scalar(
                select(ChatMessage.text).where(
                    ChatMessage.session_id == session_id,
                    ChatMessage.turn_id == turn_id,
                    ChatMessage.role == ROLE_USER,
                )
            )
    except SQLAlchemyError:
        logger.warning("会话记录读不出来 %s %s", session_id, turn_id, exc_info=True)
        return None


def has_turn(session_id: UUID, turn_id: UUID) -> bool:
    """这场会话的表里有没有这一轮（点赞点踩端点用）。

    读数据库失败按没有处理：宁可回 404，也不把一个查不到的轮次放去上游。
    这里的忽略是有意的（失败方向保守）；如实上抛的读路径见 read_messages。
    """
    try:
        with db_session() as session:
            found = session.scalar(
                select(ChatMessage.id)
                .where(
                    ChatMessage.session_id == session_id,
                    ChatMessage.turn_id == turn_id,
                )
                .limit(1)
            )
            return found is not None
    except SQLAlchemyError:
        logger.warning("会话记录读不出来 %s %s", session_id, turn_id, exc_info=True)
        return False


def backfill(session_id: UUID, rounds: list[StoredRound]) -> bool:
    """把上游那一份复制一份过来。返回是否复制进数据库。

    旧会话还没有我们自己的记录，第一次读到的时候复制一份，复制完以我们这份为准。
    返回值要一路传下去：复制失败时调用方不能把「表里还是空的」当成「这场会话
    没有消息」照常回空历史，那会把一次数据库故障伪装成空会话。
    """

    def action(session: Session) -> None:
        if _has_rows(session, session_id):
            # 这场会话已经有记录了（可能正好有一轮在写）：不复制。
            return
        seq = _next_seq(session, session_id)
        for item in rounds:
            session.add(
                ChatMessage(
                    session_id=session_id,
                    turn_id=item.turn_id,
                    role=ROLE_USER,
                    text=item.question,
                    status=item.status,
                    seq=seq,
                )
            )
            seq += 1
            if item.answer is not None:
                session.add(
                    ChatMessage(
                        session_id=session_id,
                        turn_id=item.turn_id,
                        role=ROLE_ASSISTANT,
                        text=item.answer,
                        status=item.status,
                        seq=seq,
                    )
                )
                seq += 1

    return _write("backfill", session_id, action)


def rounds_from_records(records: list[ChatRecord]) -> list[StoredRound]:
    """上游的记录整理成一轮一轮的问答。

    上游那一份：回答的编号是我们给的（responseChatItemId），提问的编号是它自己的。
    提问跟回答按先后顺序配对。
    """
    rounds: list[StoredRound] = []
    question = ""
    has_question = False
    for record in records:
        if record.role == "user":
            question = record.text
            has_question = True
            continue
        rounds.append(
            StoredRound(
                turn_id=_turn_id_of(record.id),
                question=question if has_question else "",
                answer=record.text,
                status=COMPLETED,
            )
        )
        question = ""
        has_question = False

    if has_question:
        # 只有提问没有回答：那一轮被按了停止，上游只记下了提问。
        rounds.append(
            StoredRound(
                turn_id=uuid4(),
                question=question,
                answer=None,
                status=ABORTED,
            )
        )
    return rounds


def _turn_id_of(record_id: str) -> UUID:
    """上游那条回答记录的编号就是我们的轮次编号。不是编号的另给一个。"""
    try:
        return UUID(record_id)
    except ValueError:
        return uuid4()


def _write(
    operation: str,
    session_id: UUID,
    action: Callable[[Session], None],
) -> bool:
    """写进数据库失败不能让整个聊天功能中断：这份记录只是我们自己留的一份，上游还有。

    返回是否写成，需要知道结果的调用方（日志摘要行）用。
    """
    try:
        with db_session() as session:
            action(session)
        return True
    except SQLAlchemyError:
        logger.warning("会话记录写不进去 %s %s", operation, session_id, exc_info=True)
        return False


def _has_rows(session: Session, session_id: UUID) -> bool:
    found = session.scalar(
        select(ChatMessage.id).where(ChatMessage.session_id == session_id).limit(1)
    )
    return found is not None


def _next_seq(session: Session, session_id: UUID) -> int:
    current: int | None = session.scalar(
        select(func.max(ChatMessage.seq)).where(ChatMessage.session_id == session_id)
    )
    return 0 if current is None else int(current) + 1


def _turn_rows(session: Session, session_id: UUID, turn_id: UUID) -> list[ChatMessage]:
    return list(
        session.scalars(
            select(ChatMessage).where(
                ChatMessage.session_id == session_id,
                ChatMessage.turn_id == turn_id,
            )
        )
    )


def _delete_turn_rows(session: Session, session_id: UUID, turn_id: UUID) -> None:
    session.execute(
        delete(ChatMessage).where(
            ChatMessage.session_id == session_id,
            ChatMessage.turn_id == turn_id,
        )
    )
