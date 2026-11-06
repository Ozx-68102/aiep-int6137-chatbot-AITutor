"""账号鉴权：cookie 换账号、角色检查与登录限流辅助。"""

from uuid import UUID

from fastapi import HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from server.db import Account, ChatSession, db_session
from server.errors import LOGIN_REQUIRED, SessionUnauthorized
from server.passwords import hash_password, needs_rehash, verify_password
from server.ratelimit import is_locked, register_failure
from server.security.context import REQUEST_ACCOUNT
from server.security.tokens import renew_login_token

UNAUTHORIZED = "用户名或密码不正确"
ROLE_CHAT = "chat"
ROLE_ADMIN = "admin"
ROLE_DENIED_CHAT = "这个账号不能登录聊天页"
ROLE_DENIED_ADMIN = "这个账号不能登录控制台"
RATE_LIMITED = "尝试次数太多，请 15 分钟后再试"
# 限流计数分两个维度，各自锁各自的：账号和来源 IP。scope 会拼进 Redis 的键名
# （h2botapp-chat:ratelimit:{scope}:{identifier}，见 ratelimit.py）。修改密码和登录
# 共用这两个 scope：登录的账号维度拿归一化用户名当标识，修改密码拿账号 id，
# 两边的账号计数碰不到一起；IP 维度两边合用一个计数。
RATELIMIT_ACCOUNT_SCOPE = "password"
RATELIMIT_IP_SCOPE = "password:ip"


def require_session(
    session: Session,
    account: Account,
    session_id: UUID,
) -> ChatSession:
    found = session.scalar(
        select(ChatSession).where(
            ChatSession.id == session_id,
            ChatSession.account_id == account.id,
        ),
    )
    if not isinstance(found, ChatSession):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "会话不存在")
    return found


def authorize_session(session_id: UUID, login_cookie: str | None) -> str:
    """确认这场会话是这个账号的，顺手把账号 id 带出来。

    数据库是同步的，接口是异步的：这一步要放到线程里跑，
    别把事件循环卡住（卡住的时候，正在流式输出的那一轮也发不出去）。
    账号 id 只有日志摘要行用；不需要它的调用方忽略返回值就行。
    """
    with db_session() as session:
        account = account_from_cookie(session, login_cookie)
        require_session(session, account, session_id)
        return str(account.id)


def verified_account(session: Session, username: str, password: str) -> Account:
    """密码验过的账号。顺手把落后的哈希重写一遍。

    没这个人、密码不对，都是同一句话：不给探测留线索。role 要等密码
    验对了才看（顺序见 docs/ACCOUNT_MANAGEMENT.md 的「role」一节）。
    """
    account = session.scalar(select(Account).where(Account.username == username))
    if not isinstance(account, Account):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, UNAUTHORIZED)

    if not verify_password(account.password_hash, password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, UNAUTHORIZED)

    if needs_rehash(account.password_hash):
        account.password_hash = hash_password(password)

    return account


def require_role(account: Account, role: str) -> None:
    """密码对了但账号不属于这一边：403，跟「密码不对」分开说。"""
    if account.role == role:
        return
    denied = ROLE_DENIED_CHAT if role == ROLE_CHAT else ROLE_DENIED_ADMIN
    raise HTTPException(status.HTTP_403_FORBIDDEN, denied)


def login_account_key(username: str) -> str:
    """登录限流的账号维度键：归一化的用户名。

    数据库里 admin、Admin、"admin " 是三个账号；限流键照原文用的话，
    换个写法就把计数摊到三个键上，锁定形同虚设。
    """
    return username.strip().lower()


def login_client_ip(request: Request) -> str:
    client = request.client
    return client.host if client else "unknown"


async def raise_if_login_locked(username: str, request: Request) -> None:
    """进密码验证之前先查账号和 IP 两个维度的锁定（照修改密码端点的做法）。

    限流计数走异步 Redis：本函数跟着变成 async，调用点 await。
    """
    account_key = login_account_key(username)
    client_ip = login_client_ip(request)
    locked = await is_locked(RATELIMIT_ACCOUNT_SCOPE, account_key) or await is_locked(
        RATELIMIT_IP_SCOPE, client_ip
    )
    if locked:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, RATE_LIMITED)


async def register_login_failure(
    exc: HTTPException, username: str, request: Request
) -> None:
    """登录没成时两个维度都记失败。只数 401。

    没这个人和密码不对是同一句 401，计数也不分这两种：不然「试几次以后
    是不是 429」会把用户名存不存在漏出去。403（密码对了但 role 不属于
    这一边）说明密码已经验对，不记。
    """
    if exc.status_code != status.HTTP_401_UNAUTHORIZED:
        return
    await register_failure(RATELIMIT_ACCOUNT_SCOPE, login_account_key(username))
    await register_failure(RATELIMIT_IP_SCOPE, login_client_ip(request))


def _cached_account(session: Session, login_cookie: str | None) -> Account | None:
    """中间件已经查好的账号。没有缓存或者 cookie 对不上就是 None。"""
    cached = REQUEST_ACCOUNT.get()
    if cached is None or login_cookie is None or cached[0] != login_cookie:
        return None
    return _account_by_id(session, cached[1])


def _account_by_id(session: Session, account_id: UUID) -> Account | None:
    account = session.get(Account, account_id)
    return account if isinstance(account, Account) else None


def account_from_cookie(session: Session, login_cookie: str | None) -> Account:
    """聊天接口只认 chat 账号。

    判断放在这一层，所有聊天接口就都盖到了，不用每个端点自己记着查。
    中间件验过的 cookie 直接用缓存的账号 id（一次主键查询），
    不再做一轮令牌查数据库加续期。
    """
    account = _cached_account(session, login_cookie)
    if account is None:
        renewed = renew_login_token(session, login_cookie)
        account = None if renewed is None else _account_by_id(session, renewed[0])
    if account is None:
        # 没带 cookie 的是匿名请求：401 维持现状（不带 reason）。带了 cookie
        # 但不认识（过期/被吊销/被删）才是会话过期语义，带上 expired。
        if not login_cookie:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, LOGIN_REQUIRED)
        raise SessionUnauthorized()
    require_role(account, ROLE_CHAT)
    return account


def admin_from_cookie(session: Session, admin_cookie: str | None) -> Account:
    """控制台接口只认 admin_login cookie 里的 admin 账号。

    镜像 account_from_cookie。token 无效或者账号不是 admin，都回
    「未登录」（401）：这个 cookie 只有控制台登录接口自己设置，
    不像登录那样需要把「密码对了但角色不对」分开说。
    中间件的缓存只盖聊天侧的 login cookie，控制台这边自己查一轮。
    """
    renewed = renew_login_token(session, admin_cookie)
    account = None if renewed is None else _account_by_id(session, renewed[0])
    if account is None or account.role != ROLE_ADMIN:
        # 同 account_from_cookie：匿名请求维持现状，cookie 不认识才算会话过期。
        if not admin_cookie:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, LOGIN_REQUIRED)
        raise SessionUnauthorized()
    return account


def password_account(
    session: Session,
    login_cookie: str | None,
    admin_cookie: str | None,
) -> Account:
    """修改密码端点两边都认：聊天 cookie 里的 chat 账号，或控制台 cookie 里的
    admin 账号。

    管理员改自己的密码也走 /api/password，所以不能只用 account_from_cookie。
    两边都对不上就是没登录。
    """
    account = _cached_account(session, login_cookie)
    if account is not None and account.role == ROLE_CHAT:
        return account
    renewed = renew_login_token(session, login_cookie)
    account = None if renewed is None else _account_by_id(session, renewed[0])
    if account is not None and account.role == ROLE_CHAT:
        return account
    renewed = renew_login_token(session, admin_cookie)
    account = None if renewed is None else _account_by_id(session, renewed[0])
    if account is not None and account.role == ROLE_ADMIN:
        return account
    if not login_cookie and not admin_cookie:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, LOGIN_REQUIRED)
    raise SessionUnauthorized()
