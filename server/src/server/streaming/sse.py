import asyncio
from collections.abc import AsyncIterator

from server.streaming import framing
from server.streaming.relay import Relay

HEARTBEAT_SECONDS = 15.0


async def sse_stream(relay: Relay) -> AsyncIterator[str]:
    """把队列里的帧转给页面；15 秒没有动静就发一帧心跳。

    心跳是 SSE 注释帧（": ping"）：前端解析器只认 data: 行，这一帧天然
    被忽略；作用是让中间层和页面知道流还活着。哨兵 None 的结束语义和
    取消语义都不变：wait_for 超时会把 queue.get 原样取消重挂，
    asyncio.Queue 的唤醒不直接交接条目，超时不会吞掉已入队的帧。

    收尾先发结局帧再发 [DONE]：relay 带着结局信息（done_status 落定）
    时，在 yield "data: [DONE]" 之前先 yield event: done 帧；失败/被停
    的路径没有 [DONE]，哨兵到达时补发 done 帧再结束流。

    **done 帧是即时判断，库是最终事实**（2026-11-05 维护者拍板）：
    _write_round_end 事后与上游对账，可能把 failed 改成 completed；
    done 帧不等待那次对账，也不回改。页面的即时语义以 done 帧为准，
    刷新以后的语义以库（/messages 消息上的标志）为准。
    """
    done_sent = False
    while True:
        try:
            item = await asyncio.wait_for(relay.queue.get(), HEARTBEAT_SECONDS)
        except TimeoutError:
            yield ": ping\n\n"
            continue
        if item is None:
            # 中继落定：失败/被停的路径没有 [DONE]，结局帧在这里补发。
            outcome = relay.done_status
            if not done_sent and outcome is not None:
                yield framing.done_chunk(
                    relay.turn_id, outcome, relay.done_reason, relay.sent_bytes()
                )
            break
        if item == framing.DONE_FRAME and not done_sent:
            outcome = relay.done_status
            if outcome is not None:
                yield framing.done_chunk(
                    relay.turn_id, outcome, relay.done_reason, relay.sent_bytes()
                )
                done_sent = True
        yield item


async def empty_sse(done: str | None = None) -> AsyncIterator[str]:
    """没有正文可写的流：直接结束，没有 [DONE]。

    「开轮前被停」的路径带着结局帧（status=aborted, reason=stop,
    bytes_sent=0）：结局随流明说，页面不靠「流怎么断的」反推。
    重复请求的路径（这一轮已经登记/落定，页面读库对账）维持空流。
    """
    if done is not None:
        yield done
