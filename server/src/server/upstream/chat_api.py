"""对话的两个上游接口：events（流式回答）和 stop_chat（叫停这一轮）。

方法是 ChatApiMixin 上的，由 client.py 的 FastGPT 类组合使用；
连接属性（_client、_base_url、_app_id）由 FastGPT 类提供。
"""

import json
import logging
from collections.abc import AsyncIterator
from uuid import UUID

import httpx2

from server.upstream.parsing import (
    STREAM_DONE,
    FastGPTError,
    ProgressEvent,
    StreamDone,
    _piece,
    _progress_event,
    _read_body,
)
from server.url import join_url

# 日志器名沿用拆分前的 "server.fastgpt"：日志格式里带 %(name)s，
# 换名字会改变日志文件的文字。
logger = logging.getLogger("server.fastgpt")


# 这两类事件的载荷带学生数据和对话历史预览：任何级别（包括 debug）
# 都不整行写进日志，只记事件名和字节数；也绝不 yield 给调用方。
_SENSITIVE_EVENTS = frozenset({"flowNodeResponse", "updateVariables"})
_FLOW_NODE_STATUS = "flowNodeStatus"


def _json(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


class ChatApiMixin:
    # 连接属性的赋值在 client.py 的 FastGPT.__init__，这里只声明类型。
    _client: httpx2.AsyncClient
    _base_url: str
    _app_id: str

    async def events(
        self,
        chat_id: UUID,
        message: str,
        turn_id: str,
    ) -> AsyncIterator[str | StreamDone | ProgressEvent]:
        payload = {
            "appId": self._app_id,
            "chatId": str(chat_id),
            "stream": True,
            # detail:true 让上游把工作流节点事件也发过来：中继层只挑
            # flowNodeStatus 转给页面当进度，其余命名事件不产出内容
            # （见 docs/CHAT_STREAM_PROTOCOL.md「上游整块返回答案」一节）。
            "detail": True,
            # 我们的编号交给 FastGPT 存着：这一轮的回答在历史里就带着这个编号，
            # 页面刷新以后能认出哪一条是当前这一轮，不用靠文字去猜。
            "responseChatItemId": turn_id,
            "messages": [{"role": "user", "content": message}],
        }
        # INFO 只留元数据；完整请求体降到 DEBUG（debug 开关打开才写）。
        # 密钥在请求头里，绝不进日志。
        logger.info(
            "FastGPT 请求 chat_id=%s turn_id=%s message_len=%d",
            chat_id,
            turn_id,
            len(message),
        )
        logger.debug("FastGPT 请求全文 %s", _json(payload))
        try:
            async with self._client.stream(
                "POST",
                join_url(self._base_url, "v2/chat/completions"),
                json=payload,
            ) as response:
                logger.info(
                    "FastGPT 响应状态 %s %s",
                    response.status_code,
                    response.headers.get("content-type", ""),
                )
                if response.status_code != 200:
                    error_body = (await response.aread()).decode(
                        "utf-8", errors="replace"
                    )
                    # 截断到 500 字符：错误正文可能整页 HTML，日志装不下。
                    logger.error("FastGPT 错误正文 %s", error_body[:500])
                    raise FastGPTError(
                        "events",
                        upstream_status=response.status_code,
                        snippet=error_body,
                    )

                current_event = ""
                async for line in response.aiter_lines():
                    stripped = line.strip()
                    if stripped == "":
                        # 一个事件帧结束：事件名不跨帧（SSE 的规矩）。
                        current_event = ""
                        continue
                    if current_event in _SENSITIVE_EVENTS:
                        # 载荷带学生数据和对话历史预览：整行不进日志，
                        # 只记事件名和大小。
                        logger.debug(
                            "FastGPT 上游 %s %d 字节",
                            current_event,
                            len(line.encode("utf-8")),
                        )
                    else:
                        # 上游原文一行一条，量大而且含用户内容：只在 DEBUG 写。
                        logger.debug("FastGPT 上游 %s", line)
                    if stripped.startswith("event:"):
                        current_event = stripped.removeprefix("event:").strip()
                        continue
                    if not stripped.startswith("data:"):
                        continue
                    if current_event == _FLOW_NODE_STATUS:
                        progress = _progress_event(stripped)
                        if progress is not None:
                            yield progress
                        continue
                    piece = _piece(stripped)
                    if piece is None:
                        continue
                    yield piece
                    if piece is STREAM_DONE:
                        return
        except httpx2.HTTPError as exc:
            # 连不上、读超时这些都算上游的问题，记一行就够，不输出整页栈。
            logger.error("FastGPT 连不上 %s：%s", chat_id, exc)
            raise FastGPTError("events") from None

    async def stop_chat(self, chat_id: UUID) -> bool:
        """让上游停下这一轮。

        v2 的停止是一个运行态标记（Redis 里的
        `agent_runtime_stopping:{appId}:{chatId}`），工作流每 100 毫秒看一眼，
        到下一个节点边界就收手。v1 只能靠断连接，那招在 v2 上不管用
        （v2 不看连接状态）。

        这个接口自己会等工作流收尾，最多等五秒 —— 所以调用方不要等它的返回。
        """
        try:
            response = await self._client.post(
                join_url(self._base_url, "v2/chat/stop"),
                json={
                    "appId": self._app_id,
                    "chatId": str(chat_id),
                },
            )
        except httpx2.HTTPError as exc:
            logger.error("FastGPT 停止请求发不出去 %s：%s", chat_id, exc)
            return False
        if response.status_code != 200:
            logger.error("FastGPT 停止返回 %s", response.status_code)
            return False
        body = _read_body(response, "stop_chat")
        if isinstance(body, dict):
            data = body.get("data")
            if isinstance(data, dict) and data.get("success") is True:
                return True
        return False
