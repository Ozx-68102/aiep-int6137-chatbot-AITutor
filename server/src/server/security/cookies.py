"""登录 cookie 的常量与设置/清除辅助。"""

from fastapi import Response

COOKIE_NAME = "login"
COOKIE_MAX_AGE = 7 * 24 * 60 * 60
# 控制台那一边独立的 cookie（docs/ACCOUNT_MANAGEMENT.md 顺序第 2 步）。
# 两边的登录互不通用：聊天页拿不到 admin_login，控制台也不认 login。
ADMIN_COOKIE_NAME = "admin_login"


def set_cookie(response: Response, name: str, token: str) -> None:
    response.set_cookie(
        key=name,
        value=token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        path="/",
    )


def clear_cookie(response: Response, name: str) -> None:
    response.delete_cookie(
        key=name,
        path="/",
        httponly=True,
        samesite="lax",
    )
