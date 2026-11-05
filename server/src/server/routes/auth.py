import logging
from typing import Annotated

from fastapi import APIRouter, Cookie, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import delete
from sqlalchemy.orm import Session

from server.db import LoginToken, db_session
from server.errors import LOGIN_REQUIRED, NO_LANGUAGE, REASON_EXPIRED
from server.passwords import (
    check_password_policy,
    hash_password,
    min_length_for_role,
    verify_password,
)
from server.ratelimit import clear_failures, is_locked, register_failure
from server.routes.sessions import session_items
from server.security import (
    ADMIN_COOKIE_NAME,
    COOKIE_NAME,
    RATE_LIMITED,
    RATELIMIT_ACCOUNT_SCOPE,
    RATELIMIT_IP_SCOPE,
    ROLE_ADMIN,
    ROLE_CHAT,
    clear_cookie,
    login_account_key,
    new_token,
    password_account,
    raise_if_login_locked,
    register_login_failure,
    require_role,
    revoke_login_token,
    set_cookie,
    verified_account,
)
from server.types import (
    AdminLoginResponse,
    LoginRequest,
    LoginResponse,
    PasswordChange,
)

router = APIRouter()
logger = logging.getLogger("server.routes.auth")

_OLD_PASSWORD_WRONG = "旧密码不正确"
_NEW_PASSWORD_MISMATCH = "两次输入的新密码不一致"


@router.post("/api/login")
def login(body: LoginRequest, request: Request, response: Response) -> LoginResponse:
    # 先查锁定再进验证：锁定期间连密码哈希都不碰（argon2 是 CPU 活）。
    raise_if_login_locked(body.username, request)
    with db_session() as session:
        try:
            result, token = _login_account(session, body.username, body.password)
        except HTTPException as exc:
            register_login_failure(exc, body.username, request)
            raise

    # 登录成功清账号维度的计数；IP 维度的让它自然过期：同一个 IP 上还有别的
    # 账号在正常登录，它们的计数不该跟着被清掉（跟改密端点同款语义）。
    clear_failures(RATELIMIT_ACCOUNT_SCOPE, login_account_key(body.username))
    set_cookie(response, COOKIE_NAME, token)
    return result


@router.post("/api/admin/login")
def admin_login(
    body: LoginRequest, request: Request, response: Response
) -> AdminLoginResponse:
    """控制台那一边：只认 role 是 admin 的账号，发 admin_login cookie。

    跟 /api/login 同一条规矩：先验密码再看 role，密码不对一律回
    「用户名或密码不正确」；限流也是同一套。控制台界面是后面那批活，
    接口先立起来。
    """
    raise_if_login_locked(body.username, request)
    with db_session() as session:
        try:
            account = verified_account(session, body.username, body.password)
            require_role(account, ROLE_ADMIN)
            token = new_token(session, account)
            username = account.username
        except HTTPException as exc:
            register_login_failure(exc, body.username, request)
            raise

    clear_failures(RATELIMIT_ACCOUNT_SCOPE, login_account_key(body.username))
    set_cookie(response, ADMIN_COOKIE_NAME, token)
    return AdminLoginResponse(username=username)


def _logout_response(cookie_name: str, cookie_value: str | None) -> Response:
    """退出的共用本体：吊销令牌；吊不掉按会话过期回 401，吊掉了回 204。"""
    with db_session() as session:
        if not revoke_login_token(session, cookie_value):
            content: dict[str, str] = {"detail": LOGIN_REQUIRED}
            if cookie_value:
                # 令牌已死时的退出也是会话过期语义：带 reason；匿名请求维持现状。
                content["reason"] = REASON_EXPIRED
            result = JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED, content=content
            )
            clear_cookie(result, cookie_name)
            return result

    result = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_cookie(result, cookie_name)
    return result


@router.post("/api/admin/logout", status_code=status.HTTP_204_NO_CONTENT)
def admin_logout(
    admin_cookie: Annotated[str | None, Cookie(alias=ADMIN_COOKIE_NAME)] = None,
) -> Response:
    """控制台退出：镜像 /api/logout，只是 cookie 换成 admin_login。"""
    return _logout_response(ADMIN_COOKIE_NAME, admin_cookie)


@router.post("/api/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> Response:
    return _logout_response(COOKIE_NAME, login_cookie)


@router.post("/api/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    body: PasswordChange,
    request: Request,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
    admin_cookie: Annotated[str | None, Cookie(alias=ADMIN_COOKIE_NAME)] = None,
) -> Response:
    """改密码：验旧密码、写新哈希，把这个账号的登录全踢下线。

    argon2 是 CPU 活：端点用同步的，跑在线程池里，不堵事件循环
    （/api/login 同一个道理）。请求体里有密码，日志只记账号 id。
    管理员改自己的密码也走这里：聊天页和控制台共用这一个端点。
    """
    client = request.client
    client_ip = client.host if client else "unknown"

    with db_session() as session:
        account = password_account(session, login_cookie, admin_cookie)
        account_id = str(account.id)
        # 锁定期间不做验证：不然锁形同虚设，攻击者还能拿这个接口继续试旧密码。
        locked = is_locked(RATELIMIT_ACCOUNT_SCOPE, account_id) or is_locked(
            RATELIMIT_IP_SCOPE, client_ip
        )
        if locked:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, RATE_LIMITED)

        if not verify_password(account.password_hash, body.old_password):
            register_failure(RATELIMIT_ACCOUNT_SCOPE, account_id)
            register_failure(RATELIMIT_IP_SCOPE, client_ip)
            raise HTTPException(status.HTTP_400_BAD_REQUEST, _OLD_PASSWORD_WRONG)

        if body.new_password != body.new_password_confirm:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, _NEW_PASSWORD_MISMATCH)

        policy_error = check_password_policy(
            body.new_password,
            account.username,
            min_length=min_length_for_role(account.role),
        )
        if policy_error is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, policy_error)

        # 写哈希和吊销令牌在同一个事务里：不留「密码改了、旧令牌还活着」的缝。
        # 所有设备都踢，含当前这一台，重新登录。
        account.password_hash = hash_password(body.new_password)
        session.execute(delete(LoginToken).where(LoginToken.account_id == account.id))

    # 只清账号维度的计数；IP 维度的让它自然过期：同一个 IP 上还有别的账号在
    # 正常改密，它们的计数不该跟着被清掉。
    clear_failures(RATELIMIT_ACCOUNT_SCOPE, account_id)
    logger.info("密码已修改 %s", account_id)
    result = Response(status_code=status.HTTP_204_NO_CONTENT)
    # 令牌已经全吊销：两个 cookie 都清掉，不管这次是从哪一边来的。
    clear_cookie(result, COOKIE_NAME)
    clear_cookie(result, ADMIN_COOKIE_NAME)
    return result


def _login_account(
    session: Session,
    username: str,
    password: str,
) -> tuple[LoginResponse, str]:
    account = verified_account(session, username, password)
    require_role(account, ROLE_CHAT)

    language = account.language_setting
    if language is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, NO_LANGUAGE)

    token = new_token(session, account)
    result = LoginResponse(
        locale=language.locale,
        sessions=session_items(account),
    )
    return result, token
