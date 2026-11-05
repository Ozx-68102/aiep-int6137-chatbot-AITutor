"""共用的 Redis 客户端单例。

ratelimit 和 reply_store 原来各自养了一份参数完全相同的 _redis() 工厂，
收拢成这一份。两条老规矩原样保留：

- 键空间一律挂在 h2botapp-chat: 前缀底下：应用连的 Redis 用户的 ACL 只放行
  这一个前缀，别的前缀会被拒，而且按「Redis 不通就放行」的降级写法，
  这种错不会浮出来——功能直接静默失效。
- Redis 不通时要马上知道：限流和半截文字都是可选的加固，
  不能让一次请求在它上面等好几秒。
"""

from redis import Redis
from redis.backoff import NoBackoff
from redis.retry import Retry

from server.settings import load_settings

_client: Redis | None = None


def get_redis() -> Redis:
    """进程级单例：第一次调用时按设置建连，之后复用。"""
    global _client
    if _client is not None:
        return _client

    settings = load_settings()
    client = Redis(
        host=settings.redis_host,
        port=settings.redis_port,
        username=settings.redis_user,
        password=settings.redis_password.get_secret_value(),
        decode_responses=True,
        # Redis 不通时要马上知道：默认的连接重试会让一次失败的写入
        # 等好几秒，可选的加固不能把正事卡住。
        socket_connect_timeout=2.0,
        socket_timeout=2.0,
        retry=Retry(NoBackoff(), 0),
    )
    _client = client
    return client
