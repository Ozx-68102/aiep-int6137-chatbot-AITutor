"""登录 cookie 中间件：每个请求校验并续期，必要时在响应里补发新 cookie。"""

import asyncio
from uuid import UUID

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from server.security import (
    COOKIE_NAME,
    REQUEST_ACCOUNT,
    renew_cookie_token,
    set_cookie,
)

_STATUS_PATH = "/api/status"

# 「必须改密」的豁免清单：被打了标记的账号只还能走这几个口子。
# /api/password 和 /api/logout 是自救的出口，没有它们用户既改不了密也退不了登录；
# /api/login 豁免是因为登录本来就要重新验密码，账号被标记时登录响应里会说
# （must_change_password），拦成 403 反而让被标记的用户连重新登录都进不来；
# /api/profile、/api/status、/api/avatar 是拦截页和页面顶栏要用的资料与心跳，
# 拦掉会把改密界面自己也弄瞎。其余 /api/ 路径一律 403。
# 非 /api 路径（页面本身、静态资源）不拦：浏览器总得能把拦截页加载出来。
_MUST_CHANGE_EXEMPT_PATHS = frozenset(
    {
        "/api/login",
        "/api/password",
        "/api/logout",
        "/api/profile",
        "/api/status",
        "/api/avatar",
    }
)

_MUST_CHANGE_DETAIL = "请先修改密码，然后才能继续使用"
_MUST_CHANGE_CODE = "must_change_password"


class RefreshLoginCookie:
    def __init__(self, asgi_app: ASGIApp) -> None:
        self._asgi_app = asgi_app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._asgi_app(scope, receive, send)
            return

        cookie = Request(scope).cookies.get(COOKIE_NAME)
        path: str = scope.get("path", "")
        # 状态检查是心跳，不该把登录有效期往后推。校验加续期是一条 SQL
        # （renew_login_token，顺带把账号的「必须改密」标记带回来）；
        # 同步的 psycopg 放进线程里跑，async 中间件不堵事件循环。
        renewed: tuple[UUID, bool] | None = None
        if path != _STATUS_PATH and cookie is not None:
            renewed = await asyncio.to_thread(renew_cookie_token, cookie)
        # 先重置再写：上下文是拷贝来的，别把上一个请求的缓存带进来。
        must_change_password = False
        if renewed is not None and cookie is not None:
            account_id, must_change_password = renewed
            REQUEST_ACCOUNT.set((cookie, account_id, must_change_password))
        else:
            REQUEST_ACCOUNT.set(None)
        refresh = renewed is not None

        # 被标记的账号打到豁免清单之外的 /api/ 路径：直接 403，不往端点走。
        # 非 /api 路径（页面、静态资源）照常放行。
        if (
            must_change_password
            and path.startswith("/api/")
            and path not in _MUST_CHANGE_EXEMPT_PATHS
        ):
            blocked = JSONResponse(
                status_code=403,
                content={"detail": _MUST_CHANGE_DETAIL, "code": _MUST_CHANGE_CODE},
            )
            await blocked(scope, receive, send)
            return

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
