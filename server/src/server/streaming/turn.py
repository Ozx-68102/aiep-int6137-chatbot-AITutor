import asyncio
import logging
import time
from uuid import UUID

from server import chat_log, history, reply_store
from server.fastgpt import FastGPT, FastGPTError, ProgressEvent
from server.streaming import framing, registry, stopping
from server.streaming.relay import Relay
from server.turn_status import ABORTED, COMPLETED, FAILED, TurnStatus

logger = logging.getLogger("server.streaming.turn")


async def relay_turn(
    chat_id: UUID,
    message: str,
    turn_id: str,
    relay: Relay,
    fastgpt: FastGPT,
) -> None:
    # 这一轮先记进我们自己的表：我们的进程要是中途死了，
    # 表里留着这一轮的提问，页面上不会少一轮。
    await asyncio.to_thread(chat_log.begin_round, chat_id, UUID(turn_id), message)
    try:
        async for event in fastgpt.events(chat_id, message, turn_id):
            if isinstance(event, ProgressEvent):
                # 进度帧：只转发给页面，不算回答正文——不 append_chunk、
                # 不进 relay.text/bytes_sent，也不动「发过内容没有」的
                # 失败语义（relay.sent）。心跳和它不冲突：静默期里有
                # 进度帧入队，sse_stream 那边的 wait_for 自然等不满 15 秒。
                relay.progress += 1
                outgoing = framing.progress_chunk(event)
                logger.debug("发给页面进度帧 %s", outgoing.removesuffix("\n\n"))
                await relay.queue.put(outgoing)
                continue
            if isinstance(event, str):
                if relay.first_content_at is None:
                    relay.first_content_at = time.monotonic()
                reply_store.append_chunk(chat_id, event)
                relay.text += event
                outgoing = framing.chunk(event)
                logger.debug("发给页面 %s", outgoing.removesuffix("\n\n"))
                await relay.queue.put(outgoing)
                relay.sent = True
                continue

            reply_store.mark_finished(chat_id)
            # 结局落定：done 帧说 completed。done 帧是即时判断，库是
            # 最终事实（见 sse_stream 的 docstring）。
            relay.done_status = COMPLETED
            logger.debug("发给页面 %s", framing.DONE_FRAME)
            await relay.queue.put(framing.DONE_FRAME)
            relay.sent = True
            break
        else:
            # 上游没发 [DONE] 就把流走完：算上游失败，done 帧照实说。
            relay.failed = True
            relay.done_status = FAILED
            relay.done_reason = "upstream"
    except asyncio.CancelledError:
        # 用户按了停止。状态在这里写：任务被掐掉时它确实还在写，
        # 页面轮询 /partial 时就能看到 aborted。
        logger.info("这一轮被停止 %s", chat_id)
        relay.status = ABORTED
        relay.done_status = ABORTED
        relay.done_reason = "stop"
        # 停止端点在掐这个任务之前已经叫停了上游，摘要行照实记。
        relay.stop_sent = True
        reply_store.mark_aborted(chat_id)
        raise
    except FastGPTError:
        relay.failed = True
        relay.done_status = FAILED
        relay.done_reason = "upstream"
    except Exception as exc:
        logger.error("FastGPT 读取失败 %s", chat_id, exc_info=exc)
        relay.failed = True
        relay.done_status = FAILED
        relay.done_reason = "internal"
    finally:
        try:
            if relay.failed:
                if relay.sent:
                    reply_store.mark_failed(chat_id)
                else:
                    reply_store.discard_reply(chat_id)
        finally:
            # 不能 await：任务被取消时再 await 会把取消吞掉。
            relay.queue.put_nowait(None)
        # 失败以后也要叫上游收手。v2 不看连接断没断，不叫停的话
        # 上游会把这一轮写完：token 白花，那条记录还会晚到我们的历史里。
        # 放在结束流以后叫：页面不用等这一下。
        # 这一下要等它落地：那时候上游可能正卡着，请求过去得慢一些。
        if relay.failed:
            relay.stop_sent = True
            stopping.ask_upstream_to_stop(chat_id, wait=True)
        # 这一轮落定以后写进我们自己的表。
        settle_round(chat_id, turn_id, relay, fastgpt)


def record_stopped_round(session_id: UUID, turn_id: UUID, question: str) -> bool:
    """这一轮在开始之前就被按了停止：提问记下来，状态是 aborted。

    返回写库成没成，摘要行用。
    """
    chat_log.begin_round(session_id, turn_id, question)
    return chat_log.finish_round(session_id, turn_id, "", ABORTED)


def settle_round(
    chat_id: UUID,
    turn_id: str,
    relay: Relay,
    fastgpt: FastGPT,
) -> None:
    """这一轮落定以后写进我们自己的表。

    放在单独的任务里：这一轮的任务可能正被取消（用户按了停止），
    在它里面 await 写库会写不成。
    """
    outcome: TurnStatus = FAILED if relay.failed else relay.status
    task = asyncio.create_task(
        _write_round_end(chat_id, turn_id, relay, outcome, fastgpt)
    )
    registry.settle_tasks.add(task)
    task.add_done_callback(registry.settle_tasks.discard)


async def _write_round_end(
    chat_id: UUID,
    turn_id: str,
    relay: Relay,
    outcome: TurnStatus,
    fastgpt: FastGPT,
) -> None:
    """这一轮落定以后写进我们自己的表。

    分工（2026-11-05 维护者拍板）：页面的即时语义由流里的 done 帧负责
    ——done 帧是即时判断，在这个函数跑起来之前就已经发出去了，不等待
    也不回改。下面「失败后与上游对账」的逻辑保留，但降级为归档核对：
    只修库里的存档文本和状态（页面刷新以后走 /messages 看到的语义），
    不再影响任何页面即时语义。
    """
    text = relay.text
    if outcome == FAILED:
        # 归档核对：失败以后上游可能已经把答案写完了（我们的 [DONE]
        # 丢了）。叫停已经发出去了，等它落地，再按编号核对一次上游。
        # 核对的结果只进库，不进页面。
        await stopping.wait_for_stop(chat_id)
        answer = await _upstream_answer(chat_id, turn_id, fastgpt)
        if answer is not None and answer.startswith(text):
            # 上游那份从我们收到的那段接着往下写：这一轮其实写完了，
            # 断的是我们的 [DONE]。存档用上游那份，库里状态改成写完了
            # （done 帧已经说过的 failed 不回改）。
            text = answer
            outcome = COMPLETED
    written = await asyncio.to_thread(
        chat_log.finish_round, chat_id, UUID(turn_id), text, outcome
    )
    # 这一轮到此落定：打一行结构化摘要。只在这里打一次——上面的对账
    # 也在这个函数里，不会在重试或对账路径上重复打。
    log_turn_summary(
        turn_id=turn_id,
        chat_id=chat_id,
        account_id=relay.account_id,
        outcome=outcome,
        started_at=relay.started_at,
        first_content_at=relay.first_content_at,
        bytes_sent=relay.sent_bytes(),
        stop_sent=relay.stop_sent,
        db_written=written,
        progress_events=relay.progress,
        done_status=relay.done_status,
    )


def log_turn_summary(
    *,
    turn_id: str,
    chat_id: UUID,
    account_id: str | None,
    outcome: str,
    started_at: float,
    first_content_at: float | None,
    bytes_sent: int,
    stop_sent: bool,
    db_written: bool,
    progress_events: int,
    done_status: str | None,
) -> None:
    """每轮一行的结构化摘要：键值对形式，方便 grep。

    outcome 用 turn_status 的状态词（completed/failed/aborted）；first_byte_ms
    是从开始到首个内容帧的毫秒数，一个内容帧都没有就是 "-"；
    progress_events 是这一轮转发给页面的进度帧数；done_status 是流里
    done 帧告知页面的结局（即时判断），和 outcome（库里的最终事实）
    可能不同：失败后与上游对账可能改成 completed，done 帧不回改。
    """
    duration_ms = int((time.monotonic() - started_at) * 1000)
    first_byte_ms = (
        "-"
        if first_content_at is None
        else str(int((first_content_at - started_at) * 1000))
    )
    logger.info(
        "turn_summary turn_id=%s chat_id=%s account_id=%s outcome=%s "
        "duration_ms=%d first_byte_ms=%s bytes_sent=%d stop_sent=%s "
        "db_written=%s progress_events=%d done_status=%s",
        turn_id,
        chat_id,
        account_id or "-",
        outcome,
        duration_ms,
        first_byte_ms,
        bytes_sent,
        "yes" if stop_sent else "no",
        "yes" if db_written else "no",
        progress_events,
        done_status or "-",
    )


async def _upstream_answer(
    chat_id: UUID,
    turn_id: str,
    fastgpt: FastGPT,
) -> str | None:
    """上游那一轮最后写出来的话。没有就是没有。"""
    try:
        records = await history.session_records(chat_id, fastgpt, cached=False)
    except FastGPTError:
        logger.warning("读不到上游记录，核对不了 %s", chat_id)
        return None
    for record in records:
        if record.role == "assistant" and record.id == turn_id:
            return record.text
    return None
