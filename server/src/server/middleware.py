"""登录 cookie 中间件：每个请求校验并续期，必要时在响应里补发新 cookie。"""

import asyncio
from uuid import UUID

from fastapi import Request, Response
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from server.security import (
    COOKIE_NAME,
    REQUEST_ACCOUNT,
    renew_cookie_token,
    set_cookie,
)

_STATUS_PATH = "/api/status"


class RefreshLoginCookie:
    def __init__(self, asgi_app: ASGIApp) -> None:
        self._asgi_app = asgi_app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._asgi_app(scope, receive, send)
            return

        cookie = Request(scope).cookies.get(COOKIE_NAME)
        # 状态检查是心跳，不该把登录有效期往后推。校验加续期是一条 SQL
        # （renew_login_token）；同步的 psycopg 放进线程里跑，
        # async 中间件不堵事件循环。
        account_id: UUID | None = None
        if scope.get("path") != _STATUS_PATH and cookie is not None:
            account_id = await asyncio.to_thread(renew_cookie_token, cookie)
        # 先重置再写：上下文是拷贝来的，别把上一个请求的缓存带进来。
        if account_id is not None and cookie is not None:
            REQUEST_ACCOUNT.set((cookie, account_id))
        else:
            REQUEST_ACCOUNT.set(None)
        refresh = account_id is not None

        async def send_with_refresh(message: Message) -> None:
            starting = message["type"] == "http.response.start"
            if starting and refresh and cookie is not None:
                headers = MutableHeaders(raw=message["headers"])
                already_set = any(
                    value.startswith(f"{COOKIE_NAME}=")
                    for value in headers.getlist("set-cookie")
                )
                if not already_set:
                    fresh = Response()
                    set_cookie(fresh, COOKIE_NAME, cookie)
                    headers.append("set-cookie", fresh.headers["set-cookie"])
            await send(message)

        await self._asgi_app(scope, receive, send_with_refresh)
