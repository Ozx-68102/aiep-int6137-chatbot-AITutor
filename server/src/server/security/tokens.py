"""登录令牌：签发、校验续期、吊销与周期清扫。"""

import asyncio
import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import delete, func, update
from sqlalchemy.orm import Session

from server.db import Account, LoginToken, db_session
from server.security.cookies import COOKIE_MAX_AGE

logger = logging.getLogger("server.security.tokens")

SWEEP_INTERVAL_SECONDS = 600.0


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def login_deadline() -> datetime:
    return datetime.now(UTC) + timedelta(seconds=COOKIE_MAX_AGE)


def new_token(session: Session, account: Account) -> str:
    token = secrets.token_urlsafe(32)
    session.add(
        LoginToken(
            account=account,
            token_hash=token_hash(token),
            expires_at=login_deadline(),
        )
    )
    return token


def renew_login_token(session: Session, login_cookie: str | None) -> UUID | None:
    """校验加续期合成一条 SQL：还没过期就续期，并把账号 id 带回来。

    原来是 SELECT 查到行、ORM 再写回 expires_at，一件事跑两趟；现在
    UPDATE ... WHERE expires_at > now() RETURNING account_id 一趟做完。
    令牌不存在或者已经过期都返回 None——401 的语义留在调用方，不变。
    synchronize_session=False：会话里不会挂着 LoginToken 对象，不需要同步，
    也省掉 auto 策略先做的那次 SELECT。
    """
    if login_cookie is None or login_cookie == "":
        return None
    return session.scalar(
        update(LoginToken)
        .where(
            LoginToken.token_hash == token_hash(login_cookie),
            LoginToken.expires_at > func.now(),
        )
        .values(expires_at=login_deadline())
        .returning(LoginToken.account_id)
        .execution_options(synchronize_session=False)
    )


def renew_cookie_token(login_cookie: str) -> UUID | None:
    """中间件那一份：自己开会话，校验加续期，把账号 id 带回来。"""
    with db_session() as session:
        return renew_login_token(session, login_cookie)


def revoke_login_token(session: Session, login_cookie: str | None) -> bool:
    """退出登录：一条 DELETE ... RETURNING 删掉这个还没过期的令牌。

    查不到或者已经过期都算没登录（过期的行交给周期清扫）；
    返回删没删到行。
    """
    if login_cookie is None or login_cookie == "":
        return False
    token_id = session.scalar(
        delete(LoginToken)
        .where(
            LoginToken.token_hash == token_hash(login_cookie),
            LoginToken.expires_at > func.now(),
        )
        .returning(LoginToken.id)
        .execution_options(synchronize_session=False)
    )
    return token_id is not None


def _sweep_expired_tokens() -> None:
    with db_session() as session:
        session.execute(
            delete(LoginToken).where(
                LoginToken.expires_at <= datetime.now(UTC),
            ),
        )


async def sweep_expired_tokens_loop() -> None:
    """周期清扫：启动立刻跑一次，之后每 SWEEP_INTERVAL_SECONDS 一次。

    原来这一步挂在请求路径上（每个带令牌的请求都扫一遍全表），现在只在
    这里跑。失败只记一条、不掐循环：数据库恢复以后下一轮会补上。
    """
    while True:
        try:
            await asyncio.to_thread(_sweep_expired_tokens)
        except Exception as exc:
            logger.warning("清扫过期令牌失败：%s", exc, exc_info=True)
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
