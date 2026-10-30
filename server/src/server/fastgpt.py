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


class FastGPTError(Exception):
    pass


class StreamDone:
    pass


STREAM_DONE = StreamDone()


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
    ) -> AsyncIterator[str | StreamDone]:
        payload = {
            "appId": self._app_id,
            "chatId": str(chat_id),
            "stream": True,
            "detail": False,
            "messages": [{"role": "user", "content": message}],
        }
        # 排查流式输出用，确认后再收窄。密钥在请求头里，不写进这行。
        logger.info("FastGPT 请求 %s", _json(payload))
        async with self._client.stream(
            "POST",
            join_url(self._base_url, "v1/chat/completions"),
            json=payload,
        ) as response:
            logger.info(
                "FastGPT 响应状态 %s %s",
                response.status_code,
                response.headers.get("content-type", ""),
            )
            if response.status_code != 200:
                error_body = (await response.aread()).decode("utf-8", errors="replace")
                logger.error("FastGPT 错误正文 %s", error_body)
                raise FastGPTError

            async for line in response.aiter_lines():
                if line.strip() != "":
                    logger.info("FastGPT 上游 %s", line)
                piece = _piece(line)
                if piece is None:
                    continue
                yield piece
                if piece is STREAM_DONE:
                    return

    async def records(
        self,
        chat_id: UUID,
        offset: int,
        page_size: int,
    ) -> ChatRecordPage:
        response = await self._client.post(
            join_url(self._base_url, "core/chat/record/getPaginationRecords"),
            json={
                "appId": self._app_id,
                "chatId": str(chat_id),
                "offset": offset,
                "pageSize": page_size,
            },
        )
        if response.status_code != 200:
            logger.error("FastGPT 返回 %s", response.status_code)
            raise FastGPTError

        return _record_page(_read_body(response))

    async def delete_history(self, chat_id: UUID) -> None:
        response = await self._client.delete(
            join_url(self._base_url, "core/chat/history/delHistory"),
            params={"appId": self._app_id, "chatId": str(chat_id)},
        )
        if response.status_code == 404:
            return
        if response.status_code != 200:
            logger.error("FastGPT 返回 %s", response.status_code)
            raise FastGPTError
        _read_body(response)


def open_fastgpt(settings: Settings) -> FastGPT | None:
    if empty_fastgpt_fields(settings):
        return None

    # 连接超时 10 秒。读超时 30 秒，同时管着「等上游第一个字节」和「两块字之间」：
    # 上游实测 0.3 到 5.2 秒，30 秒够用，又不会在上游不吭声时一直挂着。
    client = httpx2.AsyncClient(
        timeout=httpx2.Timeout(10.0, read=30.0),
        headers={
            "Authorization": f"Bearer {settings.fastgpt_api_key.get_secret_value()}",
        },
    )
    return FastGPT(client, settings.fastgpt_base_url, settings.fastgpt_app_id)


def _json(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


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


def _read_body(response: httpx2.Response) -> dict[str, object]:
    try:
        payload = response.json()
    except json.JSONDecodeError:
        logger.error("FastGPT 返回了无法解析的正文")
        raise FastGPTError from None
    return _ok_body(payload)


def _ok_body(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise FastGPTError

    code = payload.get("code")
    if isinstance(code, bool) or not isinstance(code, int):
        logger.error("FastGPT 返回 code 无效")
        raise FastGPTError
    if code != 200:
        logger.error("FastGPT 返回 code %s", code)
        raise FastGPTError
    return payload


def _record_page(payload: dict[str, object]) -> ChatRecordPage:
    data = payload.get("data")
    if not isinstance(data, dict):
        raise FastGPTError

    total = data.get("total")
    if isinstance(total, bool) or not isinstance(total, int):
        raise FastGPTError

    raw_list = data.get("list")
    if not isinstance(raw_list, list):
        raise FastGPTError

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
