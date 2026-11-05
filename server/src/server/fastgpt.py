import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

import httpx2

from server.types import Settings, empty_fastgpt_fields
from server.url import join_url

logger = logging.getLogger("server.fastgpt")


# snippet 截断到这个长度：错误正文可能整页 HTML，日志装不下。
_SNIPPET_LIMIT = 200


class FastGPTError(Exception):
    """上游调用失败。带上信息，让接到它的那行日志自己就能说清出了什么事。

    - step：哪一步失败，取 FastGPT 类里的方法名（"events"、"records"、
      "feedback"、"delete_item"、"delete_history"）。
    - upstream_status：上游回的 HTTP 状态码；连不上、请求没发出去时是 None。
    - snippet：上游错误正文的开头一小段（截到 200 字符）。只放错误正文：
      请求头里带着 API key，绝不进异常文本；records 的成功正文带学生数据，
      所以解析类的失败只带 step、不带 snippet（细节在 raise 之前的
      logger.error 行里）。
    """

    def __init__(
        self,
        step: str,
        *,
        upstream_status: int | None = None,
        snippet: str | None = None,
    ) -> None:
        self.step = step
        self.upstream_status = upstream_status
        self.snippet = _snippet(snippet)
        super().__init__(_describe(step, upstream_status, self.snippet))


class StreamDone:
    pass


STREAM_DONE = StreamDone()


@dataclass(frozen=True)
class ProgressEvent:
    """detail:true 时的工作流节点状态（flowNodeStatus 事件）。

    载荷只有 name 和 status 两个字符串字段，原样转发给页面当进度帧。
    节点输出明细（flowNodeResponse）和工作流变量（updateVariables）
    带学生数据，不当成这个类型解析，也一个字不外发（依据见
    docs/CHAT_STREAM_PROTOCOL.md「上游整块返回答案」一节）。
    """

    name: str
    status: str


# 这两类事件的载荷带学生数据和对话历史预览：任何级别（包括 debug）
# 都不整行落日志，只记事件名和字节数；也绝不 yield 给调用方。
_SENSITIVE_EVENTS = frozenset({"flowNodeResponse", "updateVariables"})
_FLOW_NODE_STATUS = "flowNodeStatus"


@dataclass(frozen=True)
class ChatRecord:
    id: str
    role: Literal["user", "assistant"]
    text: str


@dataclass(frozen=True)
class ChatRecordPage:
    total: int
    records: list[ChatRecord]


class FastGPT:
    def __init__(self, client: httpx2.AsyncClient, base_url: str, app_id: str) -> None:
        self._client = client
        self._base_url = base_url
        self._app_id = app_id

    async def aclose(self) -> None:
        await self._client.aclose()

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
            # 连不上、读超时这些都算上游的问题，记一行就够，不打整页栈。
            logger.error("FastGPT 连不上 %s：%s", chat_id, exc)
            raise FastGPTError("events") from None

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
        body = _read_body(response)
        if isinstance(body, dict):
            data = body.get("data")
            if isinstance(data, dict) and data.get("success") is True:
                return True
        return False

    async def update_feedback(
        self,
        chat_id: UUID,
        data_id: str,
        feedback: Literal["good", "bad"] | None,
    ) -> None:
        """给一条回答设置或清掉好差评（消息操作第四期）。

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

    async def delete_item(self, chat_id: UUID, content_id: str) -> bool:
        """删掉这场会话里的某一条记录（软删）。

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


def _json(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _snippet(text: str | None) -> str | None:
    """响应正文取开头一小段：压掉换行，异常消息保持一行。"""
    if text is None:
        return None
    clipped = " ".join(text.split())[:_SNIPPET_LIMIT]
    return clipped or None


def _describe(step: str, upstream_status: int | None, snippet: str | None) -> str:
    """拼 str()：一句能直接落日志的人话。"""
    parts = [f"FastGPT {step} 失败"]
    if upstream_status is not None:
        parts.append(f"上游状态 {upstream_status}")
    if snippet:
        parts.append(f"响应开头：{snippet}")
    return "，".join(parts)


def _progress_event(line: str) -> ProgressEvent | None:
    """flowNodeStatus 的 data 行 → ProgressEvent。解析不出来就跳过。

    载荷只有 {name, status} 两个字符串字段（实测见 docs/FASTGPT_API.md
    「流式行为」）。字段不是字符串就不猜，丢掉这一条；
    日志里不落载荷内容。
    """
    data = line.strip()
    if not data.startswith("data:"):
        return None

    data = data.removeprefix("data:").strip()
    try:
        payload = json.loads(data)
    except json.JSONDecodeError:
        logger.error("FastGPT 返回了无法解析的进度数据行")
        return None

    if not isinstance(payload, dict):
        return None

    name = payload.get("name")
    node_status = payload.get("status")
    if not isinstance(name, str) or not isinstance(node_status, str):
        return None

    return ProgressEvent(name=name, status=node_status)


def _piece(line: str) -> str | StreamDone | None:
    data = line.strip()
    if not data.startswith("data:"):
        return None

    data = data.removeprefix("data:").strip()
    if data == "[DONE]":
        return STREAM_DONE

    try:
        payload = json.loads(data)
    except json.JSONDecodeError:
        logger.error("FastGPT 返回了无法解析的数据行")
        return None

    return _content(payload)


def _content(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None

    choices = payload.get("choices")
    if not isinstance(choices, list):
        return None

    if not choices:
        return None

    first = choices[0]
    if not isinstance(first, dict):
        return None

    delta = first.get("delta")
    if not isinstance(delta, dict):
        return None

    content = delta.get("content")
    if not isinstance(content, str) or content == "":
        return None

    return content


def _read_body(response: httpx2.Response, step: str) -> dict[str, object]:
    """响应正文 JSON → dict。step 是调用它的方法名，原样进异常。

    解析和结构类的失败不带 snippet：走到这里 HTTP 已经是 200，正文可能
    带学生数据（records 的成功响应），不能漏进异常文本；细节看 raise
    之前的 logger.error 行。
    """
    try:
        payload = response.json()
    except json.JSONDecodeError:
        logger.error("FastGPT 返回了无法解析的正文")
        raise FastGPTError(step) from None
    return _ok_body(payload, step)


def _ok_body(payload: object, step: str) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise FastGPTError(step)

    code = payload.get("code")
    if isinstance(code, bool) or not isinstance(code, int):
        logger.error("FastGPT 返回 code 无效")
        raise FastGPTError(step)
    if code != 200:
        logger.error("FastGPT 返回 code %s", code)
        raise FastGPTError(step)
    return payload


def _record_page(payload: dict[str, object], step: str) -> ChatRecordPage:
    # 结构不对也不带 snippet：这是 code==200 的成功响应，正文带学生的
    # 对话内容，不能进异常文本。
    data = payload.get("data")
    if not isinstance(data, dict):
        raise FastGPTError(step)

    total = data.get("total")
    if isinstance(total, bool) or not isinstance(total, int):
        raise FastGPTError(step)

    raw_list = data.get("list")
    if not isinstance(raw_list, list):
        raise FastGPTError(step)

    records: list[ChatRecord] = []
    for item in raw_list:
        record = _record(item)
        if record is not None:
            records.append(record)

    return ChatRecordPage(total=total, records=records)


def _record(item: object) -> ChatRecord | None:
    if not isinstance(item, dict):
        return None

    obj = item.get("obj")
    role: Literal["user", "assistant"]
    if obj == "Human":
        role = "user"
    elif obj == "AI":
        role = "assistant"
    else:
        return None

    text = _record_text(item.get("value"))
    if text is None:
        return None

    data_id = item.get("dataId")
    if isinstance(data_id, str) and data_id != "":
        record_id = data_id
    else:
        record_id = item.get("_id")

    if not isinstance(record_id, str) or record_id == "":
        return None

    return ChatRecord(id=record_id, role=role, text=text)


def _record_text(value: object) -> str | None:
    items = value if isinstance(value, list) else [value]
    parts: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if not isinstance(text, dict):
            continue
        content = text.get("content")
        if isinstance(content, str) and content != "":
            parts.append(content)

    return "".join(parts) if parts else None
