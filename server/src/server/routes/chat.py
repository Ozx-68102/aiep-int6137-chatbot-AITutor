"""对话路由：/api/chat 端点与重发清理。

从 app.py 抽出：流式中继本体住在 server.streaming，本模块只做请求编排
（鉴权、重复请求、409、开轮前被停、任务登记与 SSE 响应）。
"""

import asyncio
import logging
import time
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Cookie, HTTPException, Response, status
from fastapi.responses import StreamingResponse

from server import chat_log
from server.fastgpt import ChatRecord, FastGPT, FastGPTError
from server.history import records_cache, session_records
from server.log import set_turn_context
from server.reply_store import (
    claim_round,
    current_turn_id,
    discard_reply,
    mark_aborted,
    round_in_flight,
    stop_requested,
)
from server.security import COOKIE_NAME, authorize_session
from server.streaming.framing import SSE_HEADERS, done_chunk
from server.streaming.registry import forget, running
from server.streaming.relay import Relay
from server.streaming.sse import empty_sse, sse_stream
from server.streaming.turn import log_turn_summary, record_stopped_round, relay_turn
from server.turn_status import ABORTED
from server.types import ChatRequest
from server.upstream import require_client

logger = logging.getLogger("server.routes.chat")

router = APIRouter()

_ROUND_BUSY = "这一场会话还有一轮在写，等它答完再发"


async def _clear_failed_turn(
    chat_id: UUID,
    turn_id: UUID,
    question: str,
    fastgpt: FastGPT,
) -> None:
    """删掉上一轮留下的记录。

    重发的是同一句提问，上游会再记一遍。不删的话，历史里就有两遍问答。
    回答那一条的编号是我们给的（responseChatItemId），提问那一条要从记录里找。
    我们自己那一份也要一起删：不然页面上会看见两遍。
    """
    # 删行之前先把这一轮的提问原文读出来：请求体里带的可能是新文字
    # （编辑重发），只有表里的原文才能和上游的悬空提问记录对上。
    stored_question = await asyncio.to_thread(chat_log.read_question, chat_id, turn_id)

    await asyncio.to_thread(chat_log.delete_round, chat_id, turn_id)

    try:
        records = await session_records(chat_id, fastgpt, cached=False)
    except FastGPTError:
        logger.warning("读不到上游记录，重发的这一轮删不掉旧的 %s", chat_id)
        return

    # 文本比对优先用表里的原文；表里查不到（老数据、写库失败过）再退回
    # 请求体的文字。
    match_text = question if stored_question is None else stored_question
    content_ids = _failed_turn_content_ids(records, str(turn_id), match_text)
    for content_id in content_ids:
        if not await fastgpt.delete_item(chat_id, content_id):
            logger.warning("删不掉上游记录 %s", content_id)
    if content_ids:
        records_cache.pop(chat_id, None)


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


@router.post("/api/chat")
async def chat(
    body: ChatRequest,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> Response:
    started = time.monotonic()
    turn_id = str(body.turn_id)
    # 从这里起这一轮的日志行都带着轮次编号：asyncio 建任务会拷贝上下文，
    # 中继和写库收尾那些后台任务自动继承。
    set_turn_context(turn_id)
    # INFO 只留元数据；完整请求体降到 DEBUG（debug 开关打开才写，
    # 见 settings.py）。请求体里没有登录 cookie。
    logger.info(
        "对话请求 chat_id=%s turn_id=%s retry_of=%s message_len=%d",
        body.chat_id,
        turn_id,
        body.retry_of,
        len(body.message),
    )
    logger.debug("对话请求全文 %s", body.model_dump_json(by_alias=True))

    account_id = await asyncio.to_thread(authorize_session, body.chat_id, login_cookie)
    # 配置检查放在鉴权之后：未登录的请求一律 401，不能靠吃没吃到 500
    # 探出上游配置坏没坏。
    fastgpt = require_client()

    # 同一个请求又来了（重复点击、页面重发）：这一轮已经登记过了，
    # 不能再开一轮，不然上游会生成两遍。
    if await current_turn_id(body.chat_id) == turn_id:
        if await round_in_flight(body.chat_id):
            raise HTTPException(status.HTTP_409_CONFLICT, _ROUND_BUSY)
        logger.info("这一轮已经登记过 %s，不再重开", body.chat_id)
        return StreamingResponse(
            empty_sse(), media_type="text/event-stream", headers=SSE_HEADERS
        )

    # 同一场会话同时只跑一轮。「查有没有一轮在写＋登记这一轮」合成
    # claim_round 一个原子动作：原来先 round_in_flight 查、后 begin_reply
    # 登记，两步之间有缝——两个不同编号的请求同时到，能都通过检查、
    # 都去登记，同一场会话开出两轮（上游多出一轮、半截文字交错写）。
    # 抢不到就是有一轮在写，照旧 409。Redis 不通时抢占降级放行
    # （见 claim_round 的注释）。
    if not await claim_round(body.chat_id, turn_id, body.message):
        raise HTTPException(status.HTTP_409_CONFLICT, _ROUND_BUSY)

    if await stop_requested(body.chat_id, turn_id):
        # 用户在对话请求到达之前就按了停止：这一轮不开。
        # 提问照样登记，刷新以后还能看到「问了什么、这一轮被停了」——
        # 登记已经由 claim_round 做好（它就是原来 begin_reply 的活），
        # 这里只把状态落成 aborted。先抢占再查停止：忙（409）仍然压过
        # 停，优先级和原来一致；被停这条路也不再自己写登记，不会把
        # 并发抢到的新轮登记覆盖掉。
        await mark_aborted(body.chat_id)
        written = await asyncio.to_thread(
            record_stopped_round, body.chat_id, body.turn_id, body.message
        )
        logger.info("这一轮发出之前就被停止 %s", body.chat_id)
        log_turn_summary(
            turn_id=turn_id,
            chat_id=body.chat_id,
            account_id=account_id,
            outcome=ABORTED,
            started_at=started,
            first_content_at=None,
            bytes_sent=0,
            stop_sent=False,
            db_written=written,
            progress_events=0,
            done_status=ABORTED,
        )
        # 结局随流明说：被停在这一轮开起来之前，done 帧照样发。
        done = done_chunk(turn_id, ABORTED, "stop", 0)
        return StreamingResponse(
            empty_sse(done), media_type="text/event-stream", headers=SSE_HEADERS
        )

    # 重发：把上一轮在上游留下的记录删掉，历史里才不会出现两遍问答。
    #
    # 顺序变化说明：等叫停落地挪进了 relay_turn（登记提问之后、调上游
    # 之前），响应头不再被压住。这一步删除因此发生在等待落地之前——
    # 安全：叫停针对的是上一轮失败的生成，删的是历史记录，删记录碰不
    # 到停止标记；必须守住的时序（新轮调上游之前叫停已落地）由
    # relay_turn 里的等待保证。代价是上一轮若还被上游写着，这一删可能
    # 扑空（悬空提问只在它是最后一条时才删），上游历史里多留一条短
    # 答案——原代码等待 7 秒超时放行时本来就是同样的并发面，删除本来
    # 就尽力而为（找不到就不删）。
    if body.retry_of is not None:
        try:
            await _clear_failed_turn(body.chat_id, body.retry_of, body.message, fastgpt)
        except BaseException:
            # 删记录半路炸了（数据库读写在线程里，可能抛）：把刚抢下
            # 的这一轮退掉，别留下「登记了在写、任务却没建」的假占用，
            # 不然这场会话要干等轮次键 TTL 到期才能再发问。
            await discard_reply(body.chat_id)
            raise

    # 这一轮在 claim_round 抢占成功时就登记完了（状态、半截文字、
    # 轮次键一步写好）：页面断流之后靠它知道请求有没有落地。
    relay = Relay()
    relay.account_id = account_id
    relay.turn_id = turn_id
    task = asyncio.create_task(
        relay_turn(body.chat_id, body.message, turn_id, relay, fastgpt)
    )
    running.setdefault(body.chat_id, set()).add(task)
    task.add_done_callback(lambda finished: forget(body.chat_id, finished))
    # 先把响应头发出去，页面的等待气泡立刻就转起来——等叫停落地在
    # relay_turn 里做，不压响应头。上游出问题时流会直接结束（没有
    # [DONE]），页面据此判断这一轮没写完。
    return StreamingResponse(
        sse_stream(relay), media_type="text/event-stream", headers=SSE_HEADERS
    )
