"""上游 FastGPT 客户端的持有者：启动时建立，请求路径按需取用。

FastGPT 类本体（连接、超时、鉴权头）和建立函数 open_fastgpt 也在这里。
接口方法在 chat_api、history_api、feedback_api 三个模块里，组合进
FastGPT 类；解析和数据类型在 parsing。
"""

import logging

import httpx2
from fastapi import HTTPException, status

from server.errors import SERVER_ERROR
from server.settings import load_settings
from server.types import Settings, empty_fastgpt_fields
from server.upstream.chat_api import ChatApiMixin
from server.upstream.feedback_api import FeedbackApiMixin
from server.upstream.history_api import HistoryApiMixin

logger = logging.getLogger("server.upstream")


class FastGPT(ChatApiMixin, HistoryApiMixin, FeedbackApiMixin):
    def __init__(self, client: httpx2.AsyncClient, base_url: str, app_id: str) -> None:
        self._client = client
        self._base_url = base_url
        self._app_id = app_id

    async def aclose(self) -> None:
        await self._client.aclose()


def open_fastgpt(settings: Settings) -> FastGPT | None:
    if empty_fastgpt_fields(settings):
        return None

    # 连接超时 10 秒。读超时管着「等上游第一个字节」和「两块字之间」：
    # 上游实测 0.3 到 5.2 秒，30 秒够用，又不会在上游不吭声时一直挂着。
    # 这个数可以在 .env 里调（FASTGPT_READ_TIMEOUT_SECONDS），默认 30 秒。
    client = httpx2.AsyncClient(
        timeout=httpx2.Timeout(10.0, read=settings.fastgpt_read_timeout_seconds),
        headers={
            "Authorization": f"Bearer {settings.fastgpt_api_key.get_secret_value()}",
        },
    )
    return FastGPT(client, settings.fastgpt_base_url, settings.fastgpt_app_id)


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
