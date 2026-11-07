import asyncio
import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Cookie, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import delete
from sqlalchemy.orm import Session

from server import pushbus
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
from server.turnstile import ACTION_ADMIN_LOGIN, ACTION_LOGIN, ensure_human
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
async def login(
    body: LoginRequest, request: Request, response: Response
) -> LoginResponse:
    # 人机验证在最前：没过 Turnstile 的尝试不碰锁定状态、数据库和 argon2，
    # 也不计入失败计数（门槛本体见 server/turnstile.py 的模块说明）。
    await ensure_human(body.turnstile_response, ACTION_LOGIN, request)
    # 先查锁定再进验证：锁定期间连密码哈希都不碰（argon2 是 CPU 活）。
    await raise_if_login_locked(body.username, request)
    # 端点从同步 def 改成 async def：限流计数要 await 异步 Redis 客户端。
    # 原来「整个端点跑线程池」的用意不变——数据库和 argon2 仍是同步的
    # CPU/IO 活，打包丢进线程里跑（_login_account_row），不堵事件循环。
    try:
        result, token = await asyncio.to_thread(
            _login_account_row, body.username, body.password
        )
    except HTTPException as exc:
        await register_login_failure(exc, body.username, request)
        raise

    # 登录成功清账号维度的计数；IP 维度的让它自然过期：同一个 IP 上还有别的
    # 账号在正常登录，它们的计数不该跟着被清掉（跟修改密码端点同款语义）。
    await clear_failures(RATELIMIT_ACCOUNT_SCOPE, login_account_key(body.username))
    set_cookie(response, COOKIE_NAME, token)
    return result


@router.post("/api/admin/login")
async def admin_login(
    body: LoginRequest, request: Request, response: Response
) -> AdminLoginResponse:
    """控制台那一边：只认 role 是 admin 的账号，发 admin_login cookie。

    跟 /api/login 同一条规矩：先验密码再看 role，密码不对一律回
    「用户名或密码不正确」；限流也是同一套。控制台界面是后面那批活，
    接口先立起来。
    """
    # 人机验证在最前，与 /api/login 同一道门槛：不过就不碰锁定和数据库。
    await ensure_human(body.turnstile_response, ACTION_ADMIN_LOGIN, request)
    await raise_if_login_locked(body.username, request)
    try:
        username, token = await asyncio.to_thread(
            _admin_login_row, body.username, body.password
        )
    except HTTPException as exc:
        await register_login_failure(exc, body.username, request)
        raise

    await clear_failures(RATELIMIT_ACCOUNT_SCOPE, login_account_key(body.username))
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
async def change_password(
    body: PasswordChange,
    request: Request,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
    admin_cookie: Annotated[str | None, Cookie(alias=ADMIN_COOKIE_NAME)] = None,
) -> Response:
    """改密码：验旧密码、写新哈希，把这个账号的登录全部强制下线。

    argon2 是 CPU 活：端点改成 async def 之后，验证、哈希与数据库读写
    仍全部丢进线程里跑（_password_snapshot / verify_password /
    _apply_password_change），不堵事件循环；限流计数走异步 Redis，
    直接 await。请求体里有密码，日志只记账号 id。
    管理员改自己的密码也走这里：聊天页和控制台共用这一个端点。
    """
    client = request.client
    client_ip = client.host if client else "unknown"

    # 第一步（线程）：从两边 cookie 里认出账号，带出 id、用户名、role 和旧哈希。
    account_id, username, role, password_hash = await asyncio.to_thread(
        _password_snapshot, login_cookie, admin_cookie
    )

    # 锁定期间不做验证：不然锁形同虚设，攻击者还能拿这个接口继续试旧密码。
    if await is_locked(RATELIMIT_ACCOUNT_SCOPE, account_id) or await is_locked(
        RATELIMIT_IP_SCOPE, client_ip
    ):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, RATE_LIMITED)

    # 验旧密码（argon2，CPU 活）同样丢线程。错了就两个维度各记一次失败。
    verified = await asyncio.to_thread(
        verify_password, password_hash, body.old_password
    )
    if not verified:
        await register_failure(RATELIMIT_ACCOUNT_SCOPE, account_id)
        await register_failure(RATELIMIT_IP_SCOPE, client_ip)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _OLD_PASSWORD_WRONG)

    if body.new_password != body.new_password_confirm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _NEW_PASSWORD_MISMATCH)

    policy_error = check_password_policy(
        body.new_password,
        username,
        min_length=min_length_for_role(role),
    )
    if policy_error is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, policy_error)

    # 写哈希和吊销令牌在同一个事务里（_apply_password_change）：不留
    # 「密码改了、旧令牌还活着」的缝。所有设备都强制下线，含当前这一台，重新登录。
    revoked_id = await asyncio.to_thread(
        _apply_password_change, login_cookie, admin_cookie, body.new_password
    )
    # 事务提交后给这个账号的所有页面推一帧「登录态没了」，reason 是
    # password_changed。刚修改完密码的这个页面自己也会收到——有意为之：
    # 服务器不区分「谁触发的」，推给该账号的全部连接；怎么表现（触发页
    # 明知自己改了密码，可以表现得更轻）由前端自己决定。放在 to_thread
    # 返回之后：事务已提交，且回到事件循环线程（publish 任何线程调都
    # 安全，见 pushbus.py）。
    pushbus.publish(revoked_id, {"reason": pushbus.REASON_PASSWORD_CHANGED})

    # 只清账号维度的计数；IP 维度的让它自然过期：同一个 IP 上还有别的账号在
    # 正常修改密码，它们的计数不该跟着被清掉。
    await clear_failures(RATELIMIT_ACCOUNT_SCOPE, account_id)
    logger.info("密码已修改 %s", account_id)
    result = Response(status_code=status.HTTP_204_NO_CONTENT)
    # 令牌已经全吊销：两个 cookie 都清掉，不管这次是从哪一边来的。
    clear_cookie(result, COOKIE_NAME)
    clear_cookie(result, ADMIN_COOKIE_NAME)
    return result


def _password_snapshot(
    login_cookie: str | None, admin_cookie: str | None
) -> tuple[str, str, str, str]:
    """修改密码第一步（线程里）：从两边 cookie 里认出账号，带出验证要用的信息。

    返回 (账号 id, 用户名, role, 旧密码哈希)。这一步只读不写：中间的
    锁定检查（异步 Redis）没法在同步线程里 await，所以认出账号就出来，
    真正写进数据库的事务在 _apply_password_change 里。
    """
    with db_session() as session:
        account = password_account(session, login_cookie, admin_cookie)
        return str(account.id), account.username, account.role, account.password_hash


def _apply_password_change(
    login_cookie: str | None,
    admin_cookie: str | None,
    new_password: str,
) -> UUID:
    """修改密码最后一步（线程里）：写新哈希、吊销全部令牌，同一个事务。

    重新按 cookie 认一遍账号：中途账号被删或令牌被吊销的话，
    password_account 会按会话过期语义报错，不会写到不该写的账号上。
    返回被强制下线账号的 id，调用方在事务提交后拿它推送（在事务里推，可能
    推出去了事务却没提交）。
    """
    with db_session() as session:
        account = password_account(session, login_cookie, admin_cookie)
        account.password_hash = hash_password(new_password)
        # 密码已经改成自己的了，「必须修改密码」的标记就地清掉，同一个事务。
        account.must_change_password = False
        session.execute(delete(LoginToken).where(LoginToken.account_id == account.id))
        # 值在会话里就取好：db_session 退出时提交，ORM 对象随后过期。
        return account.id


def _login_account_row(username: str, password: str) -> tuple[LoginResponse, str]:
    """登录的线程那半：开会话、验密码、发令牌（数据库 + argon2）。"""
    with db_session() as session:
        return _login_account(session, username, password)


def _admin_login_row(username: str, password: str) -> tuple[str, str]:
    """控制台登录的线程那半：开会话、验密码和 role、发令牌。"""
    with db_session() as session:
        account = verified_account(session, username, password)
        require_role(account, ROLE_ADMIN)
        token = new_token(session, account)
        return account.username, token


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
        # 账号行本来就查出来了，标记直接带上：前端靠它决定要不要先修改密码。
        must_change_password=account.must_change_password,
    )
    return result, token
