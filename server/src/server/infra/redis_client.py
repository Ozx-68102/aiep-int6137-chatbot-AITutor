"""共用的 Redis 客户端单例。

ratelimit 和 reply_store 原来各自养了一份参数完全相同的 _redis() 工厂，
收拢成这一份。两条老规矩原样保留：

- 键空间一律挂在 h2botapp-chat: 前缀底下：应用连的 Redis 用户的 ACL 只放行
  这一个前缀，别的前缀会被拒，而且按「Redis 不通就放行」的降级写法，
  这种错不会浮出来——功能直接静默失效。
- Redis 不通时要马上知道：限流和半截文字都是可选的加固，
  不能让一次请求在它上面等好几秒。

客户端是 redis.asyncio（维护者拍板异步化）：命令一律返回协程，调用点
await，Redis 再慢也不阻塞事件循环。短超时和「不重试」原样带到异步这边：
socket_connect_timeout / socket_timeout 都是 2 秒，Retry(NoBackoff(), 0)。
异常仍然出自 redis.exceptions 模块：redis.asyncio 复用同一套异常类
（RedisError 照旧是基类），调用方 except RedisError 的降级写法不变。
"""

from redis.asyncio import Redis
from redis.backoff import NoBackoff
from redis.retry import Retry

from server.settings import load_settings

_client: Redis | None = None


def get_redis() -> Redis:
    """进程级单例：第一次调用时按设置建客户端，之后复用。

    构造这一步不拨号（redis.asyncio 的连接池是懒连接），所以本函数保持
    同步、什么上下文都能调；拿到的客户端发命令必须 await。
    """
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
        # 等好几秒，可选的加固不能把正事卡住。异步客户端带同样的短超时，
        # 慢 Redis 卡的只是 await 它的那一个协程，不再是整个事件循环。
        socket_connect_timeout=2.0,
        socket_timeout=2.0,
        retry=Retry(NoBackoff(), 0),
    )
    _client = client
    return client
