"""登录令牌：签发、校验续期、吊销与周期清扫。"""

import asyncio
import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import delete, exists, func, select, update
from sqlalchemy.orm import Session

from server.db import Account, LoginToken, db_session
from server.pushbus import REASON_EXPIRED, publish
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


def renew_login_token(
    session: Session, login_cookie: str | None
) -> tuple[UUID, bool] | None:
    """校验加续期合成一条 SQL：还没过期就续期，把账号 id 和该账号的
    must_change_password 标记一起带回来。

    原来是 SELECT 查到行、ORM 再写回 expires_at，一件事跑两趟；现在
    UPDATE ... WHERE expires_at > now() RETURNING 一趟做完。WHERE 里带上
    关联 account 的条件，PostgreSQL 就把这条 UPDATE 渲染成
    UPDATE login_token SET ... FROM account WHERE ...，RETURNING 顺带
    account 上的标记列——还是一轮数据库往返，不加第二次查询。
    令牌不存在或者已经过期都返回 None——401 的语义留在调用方，不变。
    synchronize_session=False：会话里不会挂着 LoginToken 对象，不需要同步，
    也省掉 auto 策略先做的那次 SELECT。
    """
    if login_cookie is None or login_cookie == "":
        return None
    row = session.execute(
        update(LoginToken)
        .where(
            LoginToken.token_hash == token_hash(login_cookie),
            LoginToken.expires_at > func.now(),
            LoginToken.account_id == Account.id,
        )
        .values(expires_at=login_deadline())
        .returning(LoginToken.account_id, Account.must_change_password)
        .execution_options(synchronize_session=False)
    ).first()
    if row is None:
        return None
    account_id, must_change_password = row
    return account_id, must_change_password


def renew_cookie_token(login_cookie: str) -> tuple[UUID, bool] | None:
    """中间件那一份：自己开会话，校验加续期，把账号 id 和标记带回来。"""
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


def _sweep_expired_tokens() -> set[UUID]:
    """删掉过期令牌，把命中的账号 id 集合带回来。

    DELETE 加上 RETURNING account_id：仍是单条语句（仍用
    ix_login_token_expires_at 索引），循环那边才能给这些账号推
    「登录态没了」。此前清扫是静默的，页面只能等下一次请求收到 401
    才发现过期。synchronize_session=False 与 renew_login_token 同理：
    会话里不挂着 LoginToken 对象，省掉 auto 策略先做的 SELECT。
    集合天然去重：同一账号一次被扫掉多个令牌，也只推一回。
    """
    with db_session() as session:
        rows = session.execute(
            delete(LoginToken)
            .where(
                LoginToken.expires_at <= datetime.now(UTC),
            )
            .returning(LoginToken.account_id)
            .execution_options(synchronize_session=False)
        )
        return {row[0] for row in rows}


def _account_has_live_token(account_id: UUID) -> bool:
    """这个账号还有没有至少一张没过期的令牌（一条 SELECT EXISTS）。"""
    with db_session() as session:
        return bool(
            session.scalar(
                select(
                    exists(
                        select(LoginToken.id).where(
                            LoginToken.account_id == account_id,
                            LoginToken.expires_at > func.now(),
                        )
                    )
                )
            )
        )


async def sweep_expired_tokens_loop() -> None:
    """周期清扫：启动立刻跑一次，之后每 SWEEP_INTERVAL_SECONDS 一次。

    原来这一步挂在请求路径上（每个带令牌的请求都扫一遍全表），现在只在
    这里跑。失败只记一条、不中止循环：数据库恢复以后下一轮会补上。
    每轮扫完，对命中的账号逐个检查：只剩一个有效令牌都没有的账号，
    才推一帧「登录态没了」（reason=expired）——令牌是每台设备一张，
    一台设备的令牌过期，不能把同账号其它还在登录的设备踢下线
    （总线见 server/pushbus.py）。
    """
    while True:
        try:
            swept = await asyncio.to_thread(_sweep_expired_tokens)
            # 推送放在写进数据库事务提交之后（to_thread 返回即已提交），清扫
            # 失败就不会误推「过期」；这里已在事件循环线程上，publish
            # 本身任何线程调都安全。
            for account_id in swept:
                # 令牌是每台设备一张：这个账号还有没过期令牌就不推，
                # 免得把其它还在登录的设备误踢下线；一个不剩才推。
                if await asyncio.to_thread(_account_has_live_token, account_id):
                    continue
                publish(account_id, {"reason": REASON_EXPIRED})
        except Exception as exc:
            logger.warning("清扫过期令牌失败：%s", exc, exc_info=True)
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
