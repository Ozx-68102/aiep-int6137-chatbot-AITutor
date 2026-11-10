import asyncio
import logging
import time
from uuid import UUID

from server import chat_log, history, reply_store
from server.streaming import framing, registry, stopping
from server.streaming.relay import Relay
from server.turn_status import ABORTED, COMPLETED, FAILED, TurnStatus
from server.upstream import FastGPT, FastGPTError, ProgressEvent

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
        # 上一轮失败后朝上游补发的叫停，必须赶在调上游之前完成：
        # v2 的停止是运行态标记，上游每轮开始先删标记，标记晚到的话，
        # 新开的这一轮会被自己人写的标记中止。这个等待原来在
        # routes/chat.py 返回响应头之前（最长压住响应头 7 秒，页面什么
        # 都收不到，像死机），现在挪进流任务里：响应头立刻回，提问在
        # 上面已经登记过，刷新马上看得到。等待期间流上没有帧：上限
        # 7 秒小于 15 秒的心跳（sse.py），不会触发心跳，页面靠等待
        # 气泡保底；摘要行的 first_byte_ms 会把这段等待算进去。
        # 放在 try 里面：等待期间被停走下面的 CancelledError 分支，
        # Redis 状态照旧写成 aborted、done 帧照旧发。
        await stopping.wait_for_stop(chat_id)
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
                await reply_store.append_chunk(chat_id, event)
                relay.text += event
                outgoing = framing.chunk(event)
                logger.debug("发给页面 %s", outgoing.removesuffix("\n\n"))
                await relay.queue.put(outgoing)
                relay.sent = True
                continue

            await reply_store.mark_finished(chat_id)
            # 结局确定：done 帧说 completed。done 帧是即时判断，库是
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
        # 用户按了停止。状态在这里写：任务被中止时它确实还在写，
        # 页面轮询 /partial 时就能看到 aborted。
        logger.info("这一轮被停止 %s", chat_id)
        relay.status = ABORTED
        relay.done_status = ABORTED
        relay.done_reason = "stop"
        # 停止端点在中止这个任务之前已经叫停了上游，摘要行照实记。
        relay.stop_sent = True
        # 这里可以放心地 await Redis：取消已经投递过了，这次写入带着
        # 短超时，写完仍把 CancelledError 原样抛上去，停止的语义不变。
        await reply_store.mark_aborted(chat_id)
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
        # 写失败状态期间收到的取消先记在这里，收尾走完再原样抛出去。
        cleanup_cancel: asyncio.CancelledError | None = None
        try:
            if relay.failed:
                try:
                    if relay.sent:
                        await reply_store.mark_failed(chat_id)
                    else:
                        await reply_store.discard_reply(chat_id)
                except asyncio.CancelledError as exc:
                    # 写失败状态时任务又被取消了一次。不能让它穿透、
                    # 跳过后面的叫停和写库收尾：那样 Redis 里的状态键
                    # 会停在「还在写」，直到 600 秒后自然过期，这期间
                    # 新一轮请求都被 409 拒掉。先把取消记下来，收尾
                    # 照常走完，最后再抛出去（不吞取消的语义）。
                    logger.info("写失败状态时又被取消 %s，继续收尾", chat_id)
                    cleanup_cancel = exc
        finally:
            # 不能 await：任务被取消时再 await 会让取消丢失。
            relay.queue.put_nowait(None)
        # 失败以后也要叫上游收手。v2 不看连接断没断，不叫停的话
        # 上游会把这一轮写完：token 被无谓消耗，那条记录还会晚到我们的历史里。
        # 放在结束流以后叫：页面不用等这次调用。
        # 这次要等它完成：那时候上游可能正忙，请求过去得慢一些。
        if relay.failed:
            relay.stop_sent = True
            stopping.ask_upstream_to_stop(chat_id, wait=True)
        # 这一轮结束以后写进我们自己的表。
        settle_round(chat_id, turn_id, relay, fastgpt)
        if cleanup_cancel is not None:
            raise cleanup_cancel


def record_stopped_round(session_id: UUID, turn_id: UUID, question: str) -> bool:
    """这一轮在开始之前就被按了停止：提问记下来，状态是 aborted。

    返回是否写进数据库，摘要行用。
    """
    started = chat_log.begin_round(session_id, turn_id, question)
    finished = chat_log.finish_round(session_id, turn_id, "", ABORTED)
    return started and finished


def settle_round(
    chat_id: UUID,
    turn_id: str,
    relay: Relay,
    fastgpt: FastGPT,
) -> None:
    """这一轮结束以后写进我们自己的表。

    放在单独的任务里：这一轮的任务可能正被取消（用户按了停止），
    在它里面 await 写进数据库会写不成。
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
    """这一轮结束以后写进我们自己的表。

    分工（2026-11-05 维护者决定）：页面的即时语义由流里的 done 帧负责
    ——done 帧是即时判断，在这个函数跑起来之前就已经发出去了，不等待
    也不回改。下面「失败后与上游核对并修正」的逻辑保留，但降级为归档核对：
    只修数据库里的存档文本和状态（页面刷新以后走 /messages 看到的语义），
    不再影响任何页面即时语义。
    """
    text = relay.text
    if outcome == FAILED:
        # 归档核对：失败以后上游可能已经把答案写完了（我们的 [DONE]
        # 丢了）。叫停已经发出去了，等它完成，再按编号核对一次上游。
        # 核对的结果只写进数据库，不进页面。
        await stopping.wait_for_stop(chat_id)
        answer = await _upstream_answer(chat_id, turn_id, fastgpt)
        if answer is not None and answer.startswith(text):
            # 上游那份从我们收到的那段接着往下写：这一轮实际上写完了，
            # 断的是我们的 [DONE]。存档用上游那份，数据库里状态改成写完了
            # （done 帧已经说过的 failed 不回改）。
            text = answer
            outcome = COMPLETED
    written = await asyncio.to_thread(
        chat_log.finish_round, chat_id, UUID(turn_id), text, outcome
    )
    # 这一轮到此结束：输出一行结构化摘要。只在这里输出一次——上面的核对
    # 也在这个函数里，不会在重试或核对路径上重复输出。
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
    done 帧告知页面的结局（即时判断），和 outcome（数据库里的最终事实）
    可能不同：失败后与上游核对并修正可能改成 completed，done 帧不回改。
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
