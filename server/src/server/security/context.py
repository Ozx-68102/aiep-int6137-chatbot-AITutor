"""请求级上下文：中间件验好的账号随本次请求的上下文传递。"""

import contextvars
from uuid import UUID

# 中间件为本次请求验好的账号 id（连同 cookie 原文用于比对，和该账号的
# must_change_password 标记）。端点侧的 account_from_cookie 直接拿它，
# 省掉一轮令牌查库和续期：每个带 cookie 的请求从两轮减到一轮。
# asyncio.to_thread 和端点线程池都会拷贝上下文，同步、异步端点都读得到；
# 每个请求在中间件入口重置，绝不串上一个请求。
REQUEST_ACCOUNT: contextvars.ContextVar[tuple[str, UUID, bool] | None] = (
    contextvars.ContextVar("request_account", default=None)
)
