import logging
from typing import Annotated

from fastapi import APIRouter, Cookie, HTTPException, status
from sqlalchemy import delete, select

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

# 已知缺口：/api/admin/* 这一侧不强制执行 must_change_password——控制台
# 还没有「改自己密码」的入口，强制会把管理员锁死在控制台外。标记照样打：
# 重置出来的密码拿到聊天侧会被中间件拦成 403，等控制台有了改密界面再
# 补上控制台这半边。


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
    """控制台重置某个账号的密码：生成新密码、踢掉全部登录、打上
    「必须改密」标记——本人改掉之前，聊天侧的接口都进不去。

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
        # 写哈希、打「必须改密」标记和吊销令牌在同一个事务里：不留
        # 「密码换了、旧令牌还活着」的缝，标记也不会落后半步。
        account.password_hash = hash_password(password)
        account.must_change_password = True
        session.execute(delete(LoginToken).where(LoginToken.account_id == account.id))
        account_id = str(account.id)

    logger.info("控制台重置了密码 %s", account_id)
    return AdminPasswordResetResponse(username=body.username, password=password)
