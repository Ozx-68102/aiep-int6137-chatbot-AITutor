"""历史的三个上游接口：records（分页读历史）、delete_item（删单条记录）、
delete_history（删整场会话）。

方法是 HistoryApiMixin 上的，由 client.py 的 FastGPT 类组合使用；
连接属性（_client、_base_url、_app_id）由 FastGPT 类提供。
"""

import logging
from uuid import UUID

import httpx2

from server.upstream.parsing import (
    ChatRecordPage,
    FastGPTError,
    _read_body,
    _record_page,
)
from server.url import join_url

# 日志器名沿用拆分前的 "server.fastgpt"：日志格式里带 %(name)s，
# 换名字会改变日志文件的文字。
logger = logging.getLogger("server.fastgpt")


class HistoryApiMixin:
    # 连接属性的赋值在 client.py 的 FastGPT.__init__，这里只声明类型。
    _client: httpx2.AsyncClient
    _base_url: str
    _app_id: str

    async def records(
        self,
        chat_id: UUID,
        offset: int,
        page_size: int,
    ) -> ChatRecordPage:
        try:
            response = await self._client.post(
                join_url(self._base_url, "core/chat/record/getPaginationRecords"),
                json={
                    "appId": self._app_id,
                    "chatId": str(chat_id),
                    "offset": offset,
                    "pageSize": page_size,
                },
            )
        except httpx2.HTTPError as exc:
            logger.error("FastGPT 连不上 %s：%s", chat_id, exc)
            raise FastGPTError("records") from None
        if response.status_code != 200:
            logger.error("FastGPT 返回 %s", response.status_code)
            raise FastGPTError(
                "records",
                upstream_status=response.status_code,
                snippet=response.text,
            )

        return _record_page(_read_body(response, "records"), "records")

    async def delete_item(self, chat_id: UUID, content_id: str) -> bool:
        """删掉这场会话里的某一条记录（软删除）。

        记录有两种编号：回答那一条的编号是我们给的（responseChatItemId），
        提问那一条是 FastGPT 自己给的。重发一轮的时候两条都要删，
        否则历史里会多出一遍问答。
        """
        try:
            response = await self._client.post(
                join_url(self._base_url, "core/chat/item/delete"),
                json={
                    "appId": self._app_id,
                    "chatId": str(chat_id),
                    "contentId": content_id,
                },
            )
        except httpx2.HTTPError as exc:
            logger.error("FastGPT 连不上 %s：%s", chat_id, exc)
            return False
        if response.status_code != 200:
            logger.error("FastGPT 删除记录返回 %s", response.status_code)
            return False
        try:
            body = _read_body(response, "delete_item")
        except FastGPTError:
            return False
        return isinstance(body, dict)

    async def delete_history(self, chat_id: UUID) -> None:
        try:
            response = await self._client.delete(
                join_url(self._base_url, "core/chat/history/delHistory"),
                params={"appId": self._app_id, "chatId": str(chat_id)},
            )
        except httpx2.HTTPError as exc:
            logger.error("FastGPT 连不上 %s：%s", chat_id, exc)
            raise FastGPTError("delete_history") from None
        if response.status_code == 404:
            # 已经删过：当成功。上游这个接口对已删的会话是幂等的，
            # 「本地没有行也照样来删上游」才不会有副作用。
            return
        if response.status_code != 200:
            logger.error("FastGPT 返回 %s", response.status_code)
            raise FastGPTError(
                "delete_history",
                upstream_status=response.status_code,
                snippet=response.text,
            )
        _read_body(response, "delete_history")
