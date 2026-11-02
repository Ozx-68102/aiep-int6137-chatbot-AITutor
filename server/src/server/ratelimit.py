"""登录、改密码的失败计数：Redis 计数，窗口内满次数就锁定。

计数是加固手段，不是业务数据：Redis 不通就放行并记一条警告
（照 reply_store 的降级写法），不能因为 Redis 挂了让人改不了密码。
"""

import logging

from redis import Redis
from redis.backoff import NoBackoff
from redis.exceptions import RedisError
from redis.retry import Retry

from server.settings import load_settings

logger = logging.getLogger("server.ratelimit")

WINDOW_SECONDS = 15 * 60
MAX_FAILURES = 5

_client: Redis | None = None


def register_failure(scope: str, identifier: str) -> None:
    """记一次失败。第一次失败起算 WINDOW_SECONDS 的窗口，后续的不续期。"""
    key = _key(scope, identifier)
    try:
        client = _redis()
        count = client.incr(key)
        if count == 1:
            client.expire(key, WINDOW_SECONDS)
    except RedisError:
        logger.warning(
            "Redis 写不进限流计数 %s，放行这一次失败", key, exc_info=True
        )


def is_locked(scope: str, identifier: str) -> bool:
    """窗口里的失败次数是不是已经满 MAX_FAILURES。Redis 不通按没锁处理。"""
    key = _key(scope, identifier)
    try:
        count = _redis().get(key)
    except RedisError:
        logger.warning("Redis 读不到限流计数 %s，按没锁处理", key, exc_info=True)
        return False
    return count is not None and int(count) >= MAX_FAILURES


def clear_failures(scope: str, identifier: str) -> None:
    """改密成功以后把计数清掉：之前的失败不该继续跟着这个账号。"""
    key = _key(scope, identifier)
    try:
        _redis().delete(key)
    except RedisError:
        logger.warning("Redis 清不掉限流计数 %s", key, exc_info=True)


def _key(scope: str, identifier: str) -> str:
    return f"h2botapp-ratelimit:{scope}:{identifier}"


def _redis() -> Redis:
    global _client
    if _client is not None:
        return _client

    settings = load_settings()
    _client = Redis(
        host=settings.redis_host,
        port=settings.redis_port,
        username=settings.redis_user,
        password=settings.redis_password.get_secret_value(),
        decode_responses=True,
        # Redis 不通时要马上知道：限流是可选的加固，
        # 不能让一次改密请求在它上面等好几秒。
        socket_connect_timeout=2.0,
        socket_timeout=2.0,
        retry=Retry(NoBackoff(), 0),
    )
    return _client  # type: ignore
