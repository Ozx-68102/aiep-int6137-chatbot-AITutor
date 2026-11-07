"""解析上游的响应：SSE 流的数据行和 JSON 壳的校验，都是模块级纯函数。

解析产出的公开类型（FastGPTError、ProgressEvent、ChatRecord 等）也定义在
这里：这个模块不依赖包内其他模块，是 upstream 包的最底层。
"""

import json
import logging
from dataclasses import dataclass
from typing import Literal

import httpx2

# 日志器名沿用拆分前的 "server.fastgpt"：日志格式里带 %(name)s，
# 换名字会改变日志文件的文字。
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


@dataclass(frozen=True)
class ChatRecord:
    id: str
    role: Literal["user", "assistant"]
    text: str


@dataclass(frozen=True)
class ChatRecordPage:
    total: int
    records: list[ChatRecord]


def _snippet(text: str | None) -> str | None:
    """响应正文取开头一小段：压掉换行，异常消息保持一行。"""
    if text is None:
        return None
    clipped = " ".join(text.split())[:_SNIPPET_LIMIT]
    return clipped or None


def _describe(step: str, upstream_status: int | None, snippet: str | None) -> str:
    """拼 str()：一句能直接写进日志的人话。"""
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
    日志里不写载荷内容。
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
