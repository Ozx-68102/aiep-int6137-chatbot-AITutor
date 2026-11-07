"""应用生命周期：建立上游客户端、启动核对、起停过期令牌清扫。"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from redis.exceptions import RedisError

from server import chat_log, pushbus, reply_store, upstream
from server.fastgpt import open_fastgpt
from server.infra.redis_client import close_redis
from server.security import sweep_expired_tokens_loop
from server.settings import load_settings
from server.streaming import registry, stopping

logger = logging.getLogger("server.lifespan")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    upstream.set_client(open_fastgpt(load_settings()))
    # 启动核对：表里卡在 streaming 的行一次标成 failed。单进程前提
    # （docs/CHAT_STREAM_PROTOCOL.md「单进程前提」一节）：进程重启时不可能有
    # 「还在写」的轮次，那些行必是卡死的轮次。读时保底修正（history.merge_current_turn）
    # 同样会降级展示，这里把数据库一次清干净。
    stuck = await asyncio.to_thread(chat_log.fail_stuck_rounds)
    if stuck:
        logger.info("启动核对：%d 行卡住的 streaming 已标为 failed", stuck)
    # 崩溃窗口清理（启动核对的 Redis 这一侧）：进程上次运行留下的状态、
    # 轮次编号、半截文字、停止标记，自然过期要 redis_key_ttl_seconds
    # （现配置 600 秒），这期间 /partial 一直答「还在写」，页面会白等
    # 一个永远不会来的回答。这里可以无条件清：服务只允许单 worker 运行
    # （server/AGENTS.md「边界」一节），单进程前提（见
    # docs/CHAT_STREAM_PROTOCOL.md「单进程前提」一节）下进程刚启动时
    # 不可能真有一轮在写，前缀下的轮次键必是进程上次运行留下的残留。数据库那侧的核对
    # （上面的 fail_stuck_rounds）管表里的行，这一步管 Redis 里的键。
    # 用 SCAN 不用 KEYS，不阻塞 Redis；Redis 是可选加固，清不成
    # （比如连不通）只记一条警告、不阻止启动，键留给自然过期。
    try:
        removed = await reply_store.clear_leftover_round_keys()
        logger.info("启动清理：清掉 Redis 里进程上次运行残留的 %d 个轮次键", removed)
    except RedisError:
        logger.warning("启动清理：Redis 不通，残留轮次键留给自然过期", exc_info=True)
    # 单轮占用检查依赖 SET … GET 这个写法（Redis 6.2 起才支持）：
    # 版本低的 Redis 会对它回语法错误，claim_round 会把它归进
    # 「Redis 不通就放行」的降级分支，单轮守卫静默失效。这里探测
    # 一次并记日志（版本不够时高声报警），探测结果不阻止启动。
    await reply_store.probe_set_get_support()
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
        # 正常收尾结束流（不投的话它们只能等客户端断开或服务强行切断）。
        pushbus.shutdown()
        await upstream.shutdown()
        # 等在进行的收尾任务完成：轮次结束后写进数据库的任务、叫停上游的
        # 任务可能还在跑，它们还要用 Redis，所以排在关 Redis 之前。
        # 最多等 5 秒；超时不卡死整个关停，记一条警告接着往下走。
        try:
            await asyncio.wait_for(
                asyncio.gather(
                    *registry.settle_tasks,
                    *stopping.stop_tasks,
                    return_exceptions=True,
                ),
                timeout=5.0,
            )
        except TimeoutError:
            logger.warning("关停收尾：等在进行的写库/叫停任务超时，不再继续等")
        # Redis 最后关：上面的写库和叫停还要用它。
        await close_redis()
