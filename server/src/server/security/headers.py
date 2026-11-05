"""应用侧安全响应头。

CSP、HSTS 这类与加密、部署形态绑定的头留给 nginx 统一发（部署日批次），
避免两层各发一份、互相覆盖打架；这里只发应用层能确定的三条：

- X-Content-Type-Options: nosniff —— 别让浏览器猜 MIME 类型；
- X-Frame-Options: DENY —— 任何站点都不能把本应用嵌进 iframe；
- Referrer-Policy: same-origin —— 跨源跳转不带 Referer。
"""

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "same-origin"),
)


class SecurityHeaders:
    """纯 ASGI 中间件：给所有响应附加安全头（端点已设的不覆盖）。"""

    def __init__(self, asgi_app: ASGIApp) -> None:
        self._asgi_app = asgi_app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._asgi_app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(raw=message["headers"])
                for name, value in _HEADERS:
                    if name not in headers:
                        headers.append(name, value)
            await send(message)

        await self._asgi_app(scope, receive, send_with_headers)
