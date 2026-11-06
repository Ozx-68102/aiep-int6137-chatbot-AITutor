"""登录、改密码的失败计数：Redis 计数，窗口内满次数就锁定。

计数是加固手段，不是业务数据：Redis 不通就放行并记一条警告
（照 reply_store 的降级写法），不能因为 Redis 挂了让人改不了密码。
Redis 客户端用 infra.redis_client 里共用的那一份。

三个函数都是 async（客户端是 redis.asyncio，命令要 await）：调用点在
async 端点里直接 await。降级方向原样：写不进放行、读不到按没锁、
清不掉只记警告，绝不因为 Redis 挂了拦住正事。
"""

import logging

# redis.asyncio 的异常和同步客户端同在 redis.exceptions 这个模块里，
# RedisError 照旧是基类，except 写法不变。
from redis.exceptions import RedisError

from server.infra.redis_client import get_redis

logger = logging.getLogger("server.ratelimit")

WINDOW_SECONDS = 15 * 60
MAX_FAILURES = 5


async def register_failure(scope: str, identifier: str) -> None:
    """记一次失败。第一次失败起算 WINDOW_SECONDS 的窗口，后续的不续期。"""
    key = _key(scope, identifier)
    try:
        client = get_redis()
        # SET NX 带着过期时间原子地建键：先 INCR 再 EXPIRE 的话，
        # 两步之间进程死了会留下一个永不过期的计数。
        if await client.set(key, 1, ex=WINDOW_SECONDS, nx=True) is None:
            await client.incr(key)
    except RedisError:
        logger.warning("Redis 写不进限流计数 %s，放行这一次失败", key, exc_info=True)


async def is_locked(scope: str, identifier: str) -> bool:
    """窗口里的失败次数是不是已经满 MAX_FAILURES。Redis 不通按没锁处理。"""
    key = _key(scope, identifier)
    try:
        count = await get_redis().get(key)
    except RedisError:
        logger.warning("Redis 读不到限流计数 %s，按没锁处理", key, exc_info=True)
        return False
    return count is not None and int(count) >= MAX_FAILURES


async def clear_failures(scope: str, identifier: str) -> None:
    """修改密码成功以后把计数清掉：之前的失败不该继续跟着这个账号。"""
    key = _key(scope, identifier)
    try:
        await get_redis().delete(key)
    except RedisError:
        logger.warning("Redis 清不掉限流计数 %s", key, exc_info=True)


def _key(scope: str, identifier: str) -> str:
    # 前缀挂在 h2botapp-chat: 底下：部署的 Redis ACL 只放行这一个前缀
    # （h2botapp-chat:*），另起前缀会被拒、限流静默失效。这个前缀指的是
    # 整个项目，不只是聊天那一个动作。
    return f"h2botapp-chat:ratelimit:{scope}:{identifier}"
