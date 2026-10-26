import json
import logging
from collections.abc import AsyncIterator
from uuid import UUID

import httpx2

from server.settings import Settings, empty_fastgpt_fields

logger = logging.getLogger("server.fastgpt")


class FastGPTError(Exception):
    pass


class StreamDone:
    pass


STREAM_DONE = StreamDone()


class FastGPT:
    def __init__(self, client: httpx2.AsyncClient, base_url: str, app_id: str) -> None:
        self._client = client
        self._base_url = base_url.rstrip("/")
        self._app_id = app_id

    async def aclose(self) -> None:
        await self._client.aclose()

    async def events(
        self,
        chat_id: UUID,
        message: str,
    ) -> AsyncIterator[str | StreamDone]:
        async with self._client.stream(
            "POST",
            f"{self._base_url}/api/v1/chat/completions",
            json={
                "appId": self._app_id,
                "chatId": str(chat_id),
                "stream": True,
                "detail": False,
                "messages": [{"role": "user", "content": message}],
            },
        ) as response:
            if response.status_code != 200:
                logger.error("FastGPT 返回 %s", response.status_code)
                raise FastGPTError

            async for line in response.aiter_lines():
                piece = _piece(line)
                if piece is None:
                    continue
                yield piece
                if piece is STREAM_DONE:
                    return


def open_fastgpt(settings: Settings) -> FastGPT | None:
    if empty_fastgpt_fields(settings):
        return None

    # 两块文字之间可能停很久，不限制读等待。
    client = httpx2.AsyncClient(
        timeout=httpx2.Timeout(10.0, read=None),
        headers={
            "Authorization": f"Bearer {settings.fastgpt_api_key.get_secret_value()}",
        },
    )
    return FastGPT(client, settings.fastgpt_base_url, settings.fastgpt_app_id)


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
