import logging
from typing import Annotated

from fastapi import APIRouter, Cookie, HTTPException, status
from sqlalchemy import delete, select

from server import pushbus
from server.db import Account, LoginToken, db_session
from server.passwords import generate_password, hash_password
from server.security import ADMIN_COOKIE_NAME, admin_from_cookie
from server.types import (
    AdminAccountItem,
    AdminAccountsResponse,
    AdminPasswordResetRequest,
    AdminPasswordResetResponse,
)

router = APIRouter()
logger = logging.getLogger("server.routes.admin")

# 控制台重置密码时报的「没有这个人」。
_ADMIN_ACCOUNT_NOT_FOUND = "找不到这个账号"

# 服务器端不对控制台（/api/admin/*）强制执行 must_change_password。
# 维护者已决定（2026-11-06）：这是永久决定，控制台这边不做强制改密；
# 控制台以后就算加上自助修改密码的入口，也只图方便，不与强制联动。
# 决定的背景：控制台没有「改自己密码」的入口时，强制会把管理员锁死
# 在控制台外。标记照样打：重置出来的密码拿到聊天侧会被中间件拦成 403。


@router.get("/api/admin/accounts")
def admin_list_accounts(
    admin_cookie: Annotated[str | None, Cookie(alias=ADMIN_COOKIE_NAME)] = None,
) -> AdminAccountsResponse:
    """控制台的账号列表：全部账号，按用户名排序。"""
    with db_session() as session:
        admin_from_cookie(session, admin_cookie)
        rows = session.scalars(select(Account).order_by(Account.username))
        return AdminAccountsResponse(
            accounts=[
                AdminAccountItem(username=row.username, role=row.role) for row in rows
            ],
        )


@router.post("/api/admin/accounts/reset-password")
def admin_reset_password(
    body: AdminPasswordResetRequest,
    admin_cookie: Annotated[str | None, Cookie(alias=ADMIN_COOKIE_NAME)] = None,
) -> AdminPasswordResetResponse:
    """控制台重置某个账号的密码：生成新密码、强制下线全部登录、打上
    「必须修改密码」标记——本人改掉之前，聊天侧的接口都进不去。

    对任何账号都能重置，包括管理员自己。新密码只在这一次响应里回显，
    日志只记账号 id。
    """
    with db_session() as session:
        admin_from_cookie(session, admin_cookie)
        account = session.scalar(
            select(Account).where(Account.username == body.username),
        )
        if not isinstance(account, Account):
            raise HTTPException(status.HTTP_404_NOT_FOUND, _ADMIN_ACCOUNT_NOT_FOUND)
        password = generate_password(10)
        # 写哈希、打「必须修改密码」标记和吊销令牌在同一个事务里：不留
        # 「密码换了、旧令牌还活着」的缝，标记也不会落后半步。
        account.password_hash = hash_password(password)
        account.must_change_password = True
        session.execute(delete(LoginToken).where(LoginToken.account_id == account.id))
        # 值在会话里就取好：db_session 退出时提交，ORM 对象随后过期。
        account_id = account.id

    # 推送放在事务块外面（db_session 退出时才提交）：提交了才告诉目标
    # 账号的页面「你被重置了」（reason=admin_reset）。本端点是 sync
    # def、跑在线程池里，而 asyncio.Queue 不是线程安全的——所以
    # pushbus.publish 是线程安全入口：内部用 call_soon_threadsafe 把
    # 入队动作丢回事件循环线程执行，发布者不直接碰 Queue，也不阻塞。
    pushbus.publish(account_id, {"reason": pushbus.REASON_ADMIN_RESET})

    logger.info("控制台重置了密码 %s", account_id)
    return AdminPasswordResetResponse(username=body.username, password=password)
