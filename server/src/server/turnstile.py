"""Turnstile 人机验证：两个登录接口在执行既有逻辑之前先过这道门槛。

浏览器把登录表单里 widget 产生的一次性令牌放在请求体的
cf-turnstile-response 字段里；这里拿它调用 Cloudflare 的 siteverify
接口，三件事全对才放行：success 为真、action 与所在接口的约定值一致、
hostname 在 TURNSTILE_HOSTNAMES 允许名单里。任何一项不对、配置缺失，
或者 siteverify 本身调不通，一律回 403（宁可挡住，不放开）。

密钥（.env 的 TURNSTILE_SECRET）只在服务端；前端只有公开的 sitekey。
验证发生在锁定检查和密码验证之前：没过人机验证的登录尝试不碰数据库、
不碰 argon2，也不计入限流的失败计数。
"""

import ipaddress
import logging

import httpx2
from fastapi import HTTPException, Request, status

from server.settings import load_settings

logger = logging.getLogger("server.turnstile")

# 与前端 widget 约定的 action 值（src/hooks/use-turnstile.ts 的调用处）。
ACTION_LOGIN = "login"
ACTION_ADMIN_LOGIN = "admin_login"

_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
_DETAIL = "人机验证未通过，请确认后重试"
# 令牌长度上限，挡住超大的正文（与 LoginRequest 的字段上限同值）。
_MAX_TOKEN_LENGTH = 2048


def _forbidden() -> HTTPException:
    return HTTPException(status.HTTP_403_FORBIDDEN, _DETAIL)


def _client_ip(request: Request) -> str:
    """传给 siteverify 的客户端 IP（remoteip 是可选字段）。

    开发环境里请求经 Vite 代理转发，拿到的是回环地址；这种非公网地址
    传给 siteverify 没有意义，宁可不传。
    """
    client = request.client
    if client is None:
        return ""
    try:
        ip = ipaddress.ip_address(client.host)
    except ValueError:
        return ""
    return client.host if ip.is_global else ""


def _expected_hostnames() -> set[str]:
    settings = load_settings()
    return {
        item.strip() for item in settings.turnstile_hostnames.split(",") if item.strip()
    }


async def ensure_human(token: str, action: str, request: Request) -> None:
    """验证不通过抛 403；通过则什么都不返回，端点的既有逻辑继续跑。"""
    settings = load_settings()
    secret = settings.turnstile_secret.get_secret_value()
    hostnames = _expected_hostnames()
    if not token or len(token) > _MAX_TOKEN_LENGTH or not secret or not hostnames:
        raise _forbidden()

    data: dict[str, str] = {"secret": secret, "response": token}
    client_ip = _client_ip(request)
    if client_ip:
        data["remoteip"] = client_ip

    try:
        async with httpx2.AsyncClient(timeout=httpx2.Timeout(10.0)) as http:
            response = await http.post(_SITEVERIFY_URL, data=data)
        response.raise_for_status()
        result = response.json()
    except (httpx2.HTTPError, ValueError):
        # siteverify 连不上或响应不是合法 JSON：记一条，按未通过处理。
        logger.warning("siteverify 调用失败 action=%s", action)
        raise _forbidden() from None

    if not isinstance(result, dict):
        raise _forbidden()

    if (
        result.get("success") is not True
        or result.get("action") != action
        or result.get("hostname") not in hostnames
    ):
        # error-codes 里没有用户信息，可以进日志；令牌和密钥都不记。
        logger.info(
            "人机验证未通过 action=%s error-codes=%s",
            action,
            result.get("error-codes"),
        )
        raise _forbidden()
