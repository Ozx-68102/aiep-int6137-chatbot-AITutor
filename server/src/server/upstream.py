"""上游 FastGPT 客户端的持有者：启动时建立，请求路径按需取用。"""

import logging

from fastapi import HTTPException, status

from server.errors import SERVER_ERROR
from server.fastgpt import FastGPT
from server.settings import load_settings
from server.types import empty_fastgpt_fields

logger = logging.getLogger("server.upstream")

_client: FastGPT | None = None


def set_client(client: FastGPT | None) -> None:
    global _client
    _client = client


def require_client() -> FastGPT:
    missing = empty_fastgpt_fields(load_settings())
    if missing:
        logger.error("FastGPT 配置为空：%s", "、".join(missing))
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, SERVER_ERROR)

    client = _client
    if not isinstance(client, FastGPT):
        logger.error("FastGPT 客户端未建立")
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, SERVER_ERROR)
    return client


def optional_client() -> FastGPT | None:
    """上游客户端没有就返回 None。

    停止是尽力而为：上游连不上不能让停止接口整个失败，
    我们自己的状态（Redis 里的停止标记）才是页面要看的东西。
    """
    client = _client
    if not isinstance(client, FastGPT):
        return None
    return client


async def shutdown() -> None:
    """关掉启动时建立的上游客户端（lifespan 收尾用）。"""
    client = _client
    if isinstance(client, FastGPT):
        await client.aclose()
    set_client(None)
