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
from typing import Literal
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from server.db import ChatMessage, db_session

logger = logging.getLogger("server.chat_log")

STREAMING = "streaming"
COMPLETED = "completed"
FAILED = "failed"
ABORTED = "aborted"

ROLE_USER = "user"
ROLE_ASSISTANT = "assistant"


@dataclass(frozen=True)
class StoredMessage:
    id: str
    turn_id: str
    role: Literal["user", "assistant"]
    text: str
    status: str


@dataclass(frozen=True)
class StoredRound:
    """一轮问答。answer 是 None 表示这一轮只有提问（被按停止的那种）。"""

    turn_id: UUID
    question: str
    answer: str | None
    status: str


def begin_round(session_id: UUID, turn_id: UUID, question: str) -> None:
    """记下这一轮开始。

    提问先写进去，回答的位置先占着（状态是 streaming）：我们的进程要是
    中途死了，这一轮就留在 streaming 状态，读线程看得出来，
    还能按编号去上游把答案找回来。
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

    _write("begin_round", session_id, action)


def finish_round(session_id: UUID, turn_id: UUID, text: str, status: str) -> None:
    """这一轮落定：写上最后的状态和文字。"""

    def action(session: Session) -> None:
        for row in _turn_rows(session, session_id, turn_id):
            row.status = status
            if row.role == ROLE_ASSISTANT:
                row.text = text

    _write("finish_round", session_id, action)


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


def read_messages(session_id: UUID) -> list[StoredMessage]:
    """一场会话的记录，按先后顺序。读不出来就当没有，让上游那份顶上。"""
    try:
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
                )
                for row in rows
            ]
    except SQLAlchemyError:
        logger.warning("会话记录读不出来 %s", session_id, exc_info=True)
        return []


def backfill(session_id: UUID, rounds: list[StoredRound]) -> None:
    """把上游那一份抄一份过来。

    老会话还没有我们自己的记录，第一次读到的时候抄一份，抄完以我们这份为准。
    """

    def action(session: Session) -> None:
        if _has_rows(session, session_id):
            # 这场会话已经有记录了（可能正好有一轮在写）：不抄。
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

    _write("backfill", session_id, action)


def _write(
    operation: str,
    session_id: UUID,
    action: Callable[[Session], None],
) -> None:
    """写库失败不能把聊天整个弄挂：这份记录只是我们自己留的一份，上游还有。"""
    try:
        with db_session() as session:
            action(session)
    except SQLAlchemyError:
        logger.warning("会话记录写不进去 %s %s", operation, session_id, exc_info=True)


def _has_rows(session: Session, session_id: UUID) -> bool:
    found = session.scalar(
        select(ChatMessage.id).where(ChatMessage.session_id == session_id).limit(1)
    )
    return found is not None


def _next_seq(session: Session, session_id: UUID) -> int:
    current = session.scalar(
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
