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
    """控制台重置某个账号的密码：生成一个新密码，把它的登录全踢下线。

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
        # 写哈希和吊销令牌在同一个事务里：不留「密码换了、旧令牌还活着」的缝。
        account.password_hash = hash_password(password)
        session.execute(delete(LoginToken).where(LoginToken.account_id == account.id))
        account_id = str(account.id)

    logger.info("控制台重置了密码 %s", account_id)
    return AdminPasswordResetResponse(username=body.username, password=password)
