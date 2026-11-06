"""应用生命周期：建立上游客户端、启动对账、起停过期令牌清扫。"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from redis.exceptions import RedisError

from server import chat_log, pushbus, reply_store, upstream
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
    # 崩溃窗口清理（启动对账的 Redis 这一侧）：上一世进程留下的状态、
    # 轮次编号、半截文字、停止标记，自然过期要 redis_key_ttl_seconds
    # （现配置 600 秒），这期间 /partial 一直答「还在写」，页面会白等
    # 一个永远不会来的回答。这里可以无条件清：服务只允许单 worker 运行
    # （server/AGENTS.md「边界」一节），单进程前提（见
    # docs/CHAT_STREAM_PROTOCOL.md「单进程前提」一节）下进程刚启动时
    # 不可能真有一轮在写，前缀下的轮次键必是孤儿。数据库那侧的对账
    # （上面的 fail_stuck_rounds）管表里的行，这一步管 Redis 里的键。
    # 用 SCAN 不用 KEYS，不阻塞 Redis；Redis 是可选加固，清不成
    # （比如连不通）只记一条警告、不阻止启动，键留给自然过期。
    try:
        removed = await reply_store.clear_orphan_round_keys()
        logger.info("启动清理：清掉 Redis 里上一世留下的 %d 个孤儿轮次键", removed)
    except RedisError:
        logger.warning("启动清理：Redis 不通，孤儿轮次键留给自然过期", exc_info=True)
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
        # 推送总线关停：给所有 /api/events 的订阅队列投关闭哨兵，让长连接
        # 正常收尾结束流（不投的话它们只能等客户端断开或服务硬掐）。
        pushbus.shutdown()
        await upstream.shutdown()
