import asyncio
import logging
from uuid import UUID

from server import upstream

logger = logging.getLogger("server.streaming.stopping")


stop_tasks: set[asyncio.Task[None]] = set()
# 失败时叫停的那几下：要等它们完成（停止标记晚到的话，
# 新开的那一轮会被自己人写的标记中止）。
pending_stops: dict[UUID, set[asyncio.Task[None]]] = {}
STOP_WAIT_SECONDS = 7.0


def ask_upstream_to_stop(session_id: UUID, wait: bool = False) -> None:
    """给上游发停止请求，不等它返回。

    wait 为真时把它记在会话上：开新一轮之前要等它完成
    （停止标记晚到的话，新开的那一轮会被自己人写的标记中止）。
    按停止那条路不用等：那时候上游还好好着，标记很快就写进去了。
    """
    task = asyncio.create_task(_stop_upstream(session_id))
    stop_tasks.add(task)
    task.add_done_callback(stop_tasks.discard)
    if wait:
        pending_stops.setdefault(session_id, set()).add(task)
        task.add_done_callback(lambda done: _forget_pending_stop(session_id, done))


def _forget_pending_stop(session_id: UUID, task: asyncio.Task[None]) -> None:
    tasks = pending_stops.get(session_id)
    if tasks is None:
        return
    tasks.discard(task)
    if not tasks:
        del pending_stops[session_id]


async def wait_for_stop(session_id: UUID) -> None:
    """等叫停上游的那几下完成。

    停止是一个运行态标记：标记写进去，上游才会在下一个节点边界收手。
    标记晚到的话，新开的那一轮会被自己人写的停止标记中止。
    """
    tasks = pending_stops.get(session_id)
    if not tasks:
        return
    await asyncio.wait(list(tasks), timeout=STOP_WAIT_SECONDS)


async def _stop_upstream(session_id: UUID) -> None:
    fastgpt = upstream.optional_client()
    if fastgpt is None:
        logger.warning("上游客户端没建起来 %s，这一轮停不了上游", session_id)
        return
    try:
        stopped = await fastgpt.stop_chat(session_id)
    except Exception as exc:
        logger.error("上游停止失败 %s：%s", session_id, exc, exc_info=True)
        return
    logger.info(
        "上游停止 %s：%s", session_id, "上游收到了" if stopped else "上游没回成功"
    )
