"""点赞点踩的上游接口：update_feedback。

方法是 FeedbackApiMixin 上的，由 client.py 的 FastGPT 类组合使用；
连接属性（_client、_base_url、_app_id）由 FastGPT 类提供。
"""

import logging
from typing import Literal
from uuid import UUID

import httpx2

from server.upstream.parsing import FastGPTError, _read_body
from server.url import join_url

# 日志器名沿用拆分前的 "server.fastgpt"：日志格式里带 %(name)s，
# 换名字会改变日志文件的文字。
logger = logging.getLogger("server.fastgpt")


class FeedbackApiMixin:
    # 连接属性的赋值在 client.py 的 FastGPT.__init__，这里只声明类型。
    _client: httpx2.AsyncClient
    _base_url: str
    _app_id: str

    async def update_feedback(
        self,
        chat_id: UUID,
        data_id: str,
        feedback: Literal["good", "bad"] | None,
    ) -> None:
        """给一条回答设置或清掉点赞点踩（消息操作第四期）。

        上游语义（docs/FASTGPT_API.md「点赞与点踩」）：字段出现就设、
        没出现就删——点赞只带 userGoodFeedback，点踩只带
        userBadFeedback，清掉两个都不带。dataId 是我们的轮次编号
        （responseChatItemId 跟着回答进了上游历史）。响应壳 code==200
        才算成功，其余一律抛 FastGPTError。
        """
        payload: dict[str, object] = {
            "appId": self._app_id,
            "chatId": str(chat_id),
            "dataId": data_id,
        }
        if feedback == "good":
            payload["userGoodFeedback"] = ""
        elif feedback == "bad":
            payload["userBadFeedback"] = ""
        # INFO 只记元数据；反馈载荷本身是空串，没有正文可漏。
        logger.info(
            "FastGPT 反馈 chat_id=%s data_id=%s feedback=%s",
            chat_id,
            data_id,
            feedback,
        )
        try:
            response = await self._client.post(
                join_url(self._base_url, "core/chat/feedback/updateUserFeedback"),
                json=payload,
            )
        except httpx2.HTTPError as exc:
            logger.error("FastGPT 连不上 %s：%s", chat_id, exc)
            raise FastGPTError("feedback") from None
        if response.status_code != 200:
            logger.error("FastGPT 反馈返回 %s", response.status_code)
            raise FastGPTError(
                "feedback",
                upstream_status=response.status_code,
                snippet=response.text,
            )
        _read_body(response, "feedback")
