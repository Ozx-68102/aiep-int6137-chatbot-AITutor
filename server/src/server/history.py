import asyncio
import time
from uuid import UUID

from fastapi import HTTPException, status

from server import chat_log, upstream
from server.fastgpt import ChatRecord, FastGPT, FastGPTError
from server.reply_store import PartialReply
from server.turn_status import ABORTED, FAILED, STREAMING
from server.types import HistoryMessageResponse

RECORDS_CACHE_SECONDS = 5.0
RECORDS_PAGE_SIZE = 100
records_cache: dict[UUID, tuple[float, list[ChatRecord]]] = {}
_UPSTREAM_ERROR = "暂时问不到上游，请稍后重试"


async def session_records(
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
        stored = records_cache.get(session_id)
        if stored is not None and now - stored[0] < RECORDS_CACHE_SECONDS:
            return stored[1]

    records: list[ChatRecord] = []
    offset = 0
    while True:
        page = await fastgpt.records(session_id, offset, RECORDS_PAGE_SIZE)
        records.extend(page.records)
        offset += RECORDS_PAGE_SIZE
        if offset >= page.total:
            break

    records_cache[session_id] = (now, records)
    _drop_stale_records(now)
    return records


def _drop_stale_records(now: float) -> None:
    for key in [
        key
        for key, (stamp, _) in records_cache.items()
        if now - stamp > RECORDS_CACHE_SECONDS * 20
    ]:
        del records_cache[key]


async def backfill_session(session_id: UUID) -> list[chat_log.StoredMessage]:
    """把上游那一份抄进我们自己的表。

    我们有了这张表以后，老会话还没有记录。抄一份过来之后，
    页面的历史就从我们这份来了。
    """
    fastgpt = upstream.require_client()
    try:
        records = await session_records(session_id, fastgpt)
    except FastGPTError:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            _UPSTREAM_ERROR,
        ) from None

    await asyncio.to_thread(
        chat_log.backfill, session_id, chat_log.rounds_from_records(records)
    )
    return await asyncio.to_thread(chat_log.read_messages, session_id)


def merge_current_turn(
    stored: list[chat_log.StoredMessage],
    partial: PartialReply,
) -> list[HistoryMessageResponse]:
    """把 Redis 里当前这一轮接在历史后面。

    历史来自我们自己存的表：写完的轮次都在里面。正在写的那一轮还没落定，
    Redis 里那份更新（有半截文字），用它把表里那一条补上。
    """
    # 轮次结局（还在写/失败/被停）只挂在回答行上：提问和回答共用一个
    # 状态，两边都显示的话页面脚注会把同一条提示显示两遍。只有提问、
    # 没有回答的轮次（上游一个字没写出来就被停、从上游抄来的老会话）
    # 留在提问行。
    turns_with_answer = {
        item.turn_id for item in stored if item.role == chat_log.ROLE_ASSISTANT
    }

    def status_row(item: chat_log.StoredMessage) -> bool:
        return (
            item.role == chat_log.ROLE_ASSISTANT
            or item.turn_id not in turns_with_answer
        )

    messages: list[HistoryMessageResponse] = []
    for item in stored:
        # 读时兜底：表里 streaming 的行，Redis 的 partial 为空（turn_id 是
        # None）或对不上这一行，说明这一轮其实已经不在写了（进程死在半路、
        # 键过期）——展示层降级为 failed，不写库；启动对账
        # （chat_log.fail_stuck_rounds）会把它们一次标掉。编号对得上的行
        # 不降级：Redis 里那份状态更新，由下面的合并逻辑照实处理。
        stuck = item.status == STREAMING and partial.turn_id != item.turn_id
        row = status_row(item)
        messages.append(
            HistoryMessageResponse(
                id=item.id,
                role=item.role,
                text=item.text,
                turn_id=item.turn_id,
                waiting=item.status == STREAMING and not stuck and row,
                failed=(item.status == FAILED or stuck) and row,
                aborted=item.status == ABORTED and row,
            )
        )
    if partial.turn_id is None:
        return messages

    for index, item in enumerate(messages):
        if item.turn_id != partial.turn_id or item.role != "assistant":
            continue
        if not item.waiting:
            # 这一轮在我们自己的表里已经落定了：表里的是最终状态。
            return messages
        # 这一轮还在写：Redis 里的半截文字比表里的空位新。
        messages[index] = item.model_copy(
            update={
                "text": partial.text,
                "waiting": partial.status == STREAMING,
                "failed": partial.status == FAILED,
                "aborted": partial.status == ABORTED,
            }
        )
        return messages

    # 表里没有这一轮（写库失败，或者这一轮比这张表还早）：
    # 按老办法把 Redis 里这一轮接在后面。
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
            aborted=partial.status == ABORTED,
        )
    )
    return messages
