"""应用生命周期：建立上游客户端、启动对账、起停过期令牌清扫。"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI

from server import chat_log, upstream
from server.fastgpt import open_fastgpt
from server.security import sweep_expired_tokens_loop
from server.settings import load_settings

logger = logging.getLogger("server.lifespan")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    upstream.set_client(open_fastgpt(load_settings()))
    # 启动对账：表里卡在 streaming 的行一次标成 failed。单进程前提
    # （docs/CHAT_STREAM_PROTOCOL.md「单进程前提」一节）：进程重启时不可能有
    # 「还在写」的轮次，那些行必是死轮。读时兜底（history.merge_current_turn）
    # 同样会降级展示，这里把库一次清干净。
    stuck = await asyncio.to_thread(chat_log.fail_stuck_rounds)
    if stuck:
        logger.info("启动对账：%d 行卡住的 streaming 已标为 failed", stuck)
    # 过期令牌的清扫从请求路径挪到这里：启动先跑一次，之后每
    # SWEEP_INTERVAL_SECONDS 一次。单进程假设，不需要分布式锁
    # （见 docs/CHAT_STREAM_PROTOCOL.md「单进程前提」一节）。
    sweep = asyncio.create_task(sweep_expired_tokens_loop())
    try:
        yield
    finally:
        sweep.cancel()
        with suppress(asyncio.CancelledError):
            await sweep
        await upstream.shutdown()
