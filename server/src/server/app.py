import asyncio
import contextvars
import hashlib
import json
import logging
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import (
    Cookie,
    FastAPI,
    File,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from server import avatar as avatar_image
from server import chat_log
from server.db import Account, ChatMessage, ChatSession, LoginToken, db_session
from server.fastgpt import (
    ChatRecord,
    FastGPT,
    FastGPTError,
    ProgressEvent,
    open_fastgpt,
)
from server.log import set_turn_context
from server.passwords import (
    check_password_policy,
    generate_password,
    hash_password,
    min_length_for_role,
    needs_rehash,
    verify_password,
)
from server.ratelimit import clear_failures, is_locked, register_failure
from server.reply_store import (
    PartialReply,
    append_chunk,
    begin_reply,
    current_turn_id,
    discard_reply,
    mark_aborted,
    mark_failed,
    mark_finished,
    read_partial,
    request_stop,
    round_in_flight,
    stop_requested,
    store_available,
)
from server.settings import load_settings
from server.turn_status import ABORTED, COMPLETED, FAILED, STREAMING
from server.types import (
    AbortRequest,
    AdminAccountItem,
    AdminAccountsResponse,
    AdminLoginResponse,
    AdminPasswordResetRequest,
    AdminPasswordResetResponse,
    ChatRequest,
    FeedbackUpdate,
    HistoryMessageResponse,
    HistoryResponse,
    LoginRequest,
    LoginResponse,
    PartialReplyResponse,
    PasswordChange,
    ProfileResponse,
    ProfileUpdate,
    SessionCreate,
    SessionItem,
    SessionPin,
    SessionRename,
    StatusResponse,
    TurnDoneEvent,
    empty_fastgpt_fields,
)

logger = logging.getLogger("server.app")


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    _app.state.fastgpt = open_fastgpt(load_settings())
    # 启动对账：表里卡在 streaming 的行一次标成 failed。单进程前提
    # （docs/CHAT_STREAM_KNOWN_ISSUES.md 第 12 条）：进程重启时不可能有
    # 「还在写」的轮次，那些行必是死轮。读时兜底（_merge_current_turn）
    # 同样会降级展示，这里把库一次清干净。
    stuck = await asyncio.to_thread(chat_log.fail_stuck_rounds)
    if stuck:
        logger.info("启动对账：%d 行卡住的 streaming 已标为 failed", stuck)
    # 过期令牌的清扫从请求路径挪到这里：启动先跑一次，之后每
    # _SWEEP_INTERVAL_SECONDS 一次。单进程假设，不需要分布式锁
    # （见 docs/CHAT_STREAM_KNOWN_ISSUES.md 第 12 条）。
    sweep = asyncio.create_task(_sweep_expired_tokens_loop())
    try:
        yield
    finally:
        sweep.cancel()
        with suppress(asyncio.CancelledError):
            await sweep
        fastgpt = _app.state.fastgpt
        if isinstance(fastgpt, FastGPT):
            await fastgpt.aclose()


_UNAUTHORIZED = "用户名或密码不正确"
_LOGIN_REQUIRED = "未登录"
# 会话类 401 的 reason 词表（docs/ACCOUNT_MANAGEMENT.md「会话状态通道」的最小
# HTTP 版）：令牌不认识/已过期/被吊销一律 expired（无法也无需细分）；disabled
# （账号被停用）等 account.disabled 列建好再接上（见同文档「数据库要加的」）。
# 登录端点自己的 401（密码不对）不带 reason——那不是会话过期，前端走表单错误路径。
_REASON_EXPIRED = "expired"
_REASON_DISABLED = "disabled"
_COOKIE_NAME = "login"
_COOKIE_MAX_AGE = 7 * 24 * 60 * 60
# 控制台那一边独立的 cookie（docs/ACCOUNT_MANAGEMENT.md 顺序第 2 步）。
# 两边的登录互不通用：聊天页拿不到 admin_login，控制台也不认 login。
_ADMIN_COOKIE_NAME = "admin_login"
_ROLE_CHAT = "chat"
_ROLE_ADMIN = "admin"
_ROLE_DENIED_CHAT = "这个账号不能登录聊天页"
_ROLE_DENIED_ADMIN = "这个账号不能登录控制台"
_STATUS_PATH = "/api/status"
_SERVER_ERROR = "服务器错误"
_NO_LANGUAGE = "账号没有语言设置"
_NO_AVATAR = "没有头像"
# 默认头像在前端的静态资源里：/avatar-default.svg。后端不复制一份，
# 两份一样的图迟早会走偏。
_DEFAULT_AVATAR_URL = "/avatar-default.svg"
_ROUND_BUSY = "这一场会话还有一轮在写，等它答完再发"
# /partial 只回答「还在写吗」：其余一切情况的 404 都是这句话。
_PARTIAL_NOT_STREAMING = "这一轮已经不在写了"
_UPSTREAM_ERROR = "暂时问不到上游，请稍后重试"
# 点赞点踩（第四期）：轮次找不到、上游没收到，各一句。detail 一律字符串。
_FEEDBACK_TURN_MISSING = "找不到这一轮，没法记反馈"
_FEEDBACK_UPSTREAM_ERROR = "反馈没送到，稍后再试"
_OLD_PASSWORD_WRONG = "旧密码不正确"
_NEW_PASSWORD_MISMATCH = "两次输入的新密码不一致"
# 控制台重置密码时报的「没有这个人」。
_ADMIN_ACCOUNT_NOT_FOUND = "找不到这个账号"
_RATE_LIMITED = "尝试次数太多，请 15 分钟后再试"
# 限流计数分两个维度，各自锁各自的：账号和来源 IP。scope 会拼进 Redis 的键名
# （h2botapp-chat:ratelimit:{scope}:{identifier}，见 ratelimit.py）。改密和登录
# 共用这两个 scope：登录的账号维度拿归一化用户名当标识，改密拿账号 id，
# 两边的账号计数碰不到一起；IP 维度两边合用一个计数。
_RATELIMIT_ACCOUNT_SCOPE = "password"
_RATELIMIT_IP_SCOPE = "password:ip"
_running: dict[UUID, set[asyncio.Task[None]]] = {}
_stop_tasks: set[asyncio.Task[None]] = set()
# 每一轮落定以后写库的任务。单独放着：写库不能被那一轮的取消带跑。
_settle_tasks: set[asyncio.Task[None]] = set()
# 失败时叫停的那几下：要等它们落地（停止标记晚到的话，
# 新开的那一轮会被自己人写的标记掐掉）。
_pending_stops: dict[UUID, set[asyncio.Task[None]]] = {}
_STOP_WAIT_SECONDS = 7.0
_records_cache: dict[UUID, tuple[float, list[ChatRecord]]] = {}
_RECORDS_CACHE_SECONDS = 5.0
_RECORDS_PAGE_SIZE = 100
_SWEEP_INTERVAL_SECONDS = 600.0
_HEARTBEAT_SECONDS = 15.0
# SSE 的公共响应头：no-store 不让任何一层缓存这条流；X-Accel-Buffering: no
# 叫 nginx 这类反向代理别攒响应正文——攒住的话帧要等缓冲满才发得出去，
# 静默期里页面连心跳都收不到。
_SSE_HEADERS = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
# 收尾帧：和上游 FastGPT 的 [DONE] 一字不差，格式永不动。
# 结局帧（event: done）在它之前发出；失败/被停的路径没有这一帧。
_DONE_FRAME = "data: [DONE]\n\n"
# 中间件为本次请求验好的账号 id（连同 cookie 原文用于比对）。端点侧的
# _account_from_cookie 直接拿它，省掉一轮令牌查库和续期：每个带 cookie
# 的请求从两轮减到一轮。asyncio.to_thread 和端点线程池都会拷贝上下文，
# 同步、异步端点都读得到；每个请求在中间件入口重置，绝不串上一个请求。
_REQUEST_ACCOUNT: contextvars.ContextVar[tuple[str, UUID] | None] = (
    contextvars.ContextVar("request_account", default=None)
)


class _SessionUnauthorized(HTTPException):
    """会话类 401：响应体在 detail 之外多带一个 reason 字段。

    加字段是向后兼容的：老前端只读 detail，不受影响。reason 的词表见
    _REASON_* 常量的注释；现在只会发出 expired（disabled 等停用列建好）。
    """

    def __init__(self, reason: str = _REASON_EXPIRED) -> None:
        super().__init__(status.HTTP_401_UNAUTHORIZED, _LOGIN_REQUIRED)
        self.reason = reason


class _Relay:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[str | None] = asyncio.Queue()
        self.failed = False
        self.sent = False
        # 这一轮已经写出来的文字。落库的时候要写它。
        self.text = ""
        # 这一轮最后的状态：写完了、被停了、还是失败了。
        self.status = COMPLETED
        # 摘要行用的最小计时：开始时刻、首个内容帧时刻（monotonic 秒）。
        self.started_at = time.monotonic()
        self.first_content_at: float | None = None
        # 有没有给上游发过停止：用户按停止（停止端点会先叫停上游），
        # 或者失败以后由我们叫停。
        self.stop_sent = False
        # 账号 id：对话端点鉴权之后填上，摘要行拿得到就带。
        self.account_id: str | None = None
        # 这一轮转发过的进度帧数（flowNodeStatus）：摘要行末尾那个字段。
        self.progress = 0
        # 轮次编号：done 帧带着它，页面按编号认这一轮。
        self.turn_id: str = ""
        # done 帧告知页面的结局（即时判断，库才是最终事实）。结局落定
        # 才有值；_sse 只在有值时发 done 帧。
        self.done_status: Literal["completed", "aborted", "failed"] | None = None
        # done 帧的 reason 词汇：stop（用户按停）、upstream（上游失败）、
        # internal（我们这边出错）；正常写完为 None。
        self.done_reason: Literal["stop", "upstream", "internal"] | None = None


app = FastAPI(lifespan=_lifespan)


class _RefreshLoginCookie:
    def __init__(self, asgi_app: ASGIApp) -> None:
        self._asgi_app = asgi_app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._asgi_app(scope, receive, send)
            return

        cookie = Request(scope).cookies.get(_COOKIE_NAME)
        # 状态检查是心跳，不该把登录有效期往后推。校验加续期是一条 SQL
        # （_renew_login_token）；同步的 psycopg 放进线程里跑，
        # async 中间件不堵事件循环。
        account_id: UUID | None = None
        if scope.get("path") != _STATUS_PATH and cookie is not None:
            account_id = await asyncio.to_thread(_renew_cookie_token, cookie)
        # 先重置再写：上下文是拷贝来的，别把上一个请求的缓存带进来。
        if account_id is not None and cookie is not None:
            _REQUEST_ACCOUNT.set((cookie, account_id))
        else:
            _REQUEST_ACCOUNT.set(None)
        refresh = account_id is not None

        async def send_with_refresh(message: Message) -> None:
            starting = message["type"] == "http.response.start"
            if starting and refresh and cookie is not None:
                headers = MutableHeaders(raw=message["headers"])
                already_set = any(
                    value.startswith(f"{_COOKIE_NAME}=")
                    for value in headers.getlist("set-cookie")
                )
                if not already_set:
                    fresh = Response()
                    _set_cookie(fresh, _COOKIE_NAME, cookie)
                    headers.append("set-cookie", fresh.headers["set-cookie"])
            await send(message)

        await self._asgi_app(scope, receive, send_with_refresh)


app.add_middleware(_RefreshLoginCookie)


@app.exception_handler(RequestValidationError)
async def _validation_error(request: Request, exc: RequestValidationError) -> Response:
    """422 也回一句中文。

    页面只认 {"detail": "字符串"}：Pydantic 默认的 422 正文是数组，
    前端读不出字符串，会显示成「无法连接到服务器」。
    """
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={"detail": _validation_message(exc)},
    )


@app.exception_handler(Exception)
async def _unhandled_error(request: Request, exc: Exception) -> Response:
    if isinstance(exc, HTTPException):
        return await http_exception_handler(request, exc)

    # 这里只记一行。栈由 uvicorn 打一遍就够，打两遍会把日志撑爆。
    logger.error("请求失败 %s %s：%s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": _SERVER_ERROR},
    )


@app.exception_handler(_SessionUnauthorized)
async def _session_unauthorized_response(
    request: Request, exc: _SessionUnauthorized
) -> Response:
    """会话类 401 的响应体：{"detail": 中文句子, "reason": 词表词}。

    detail 保持字符串，加 reason 字段向后兼容。这个处理器比
    HTTPException 的更具体，按 MRO 优先分派到这里。
    """
    return JSONResponse(
        status_code=status.HTTP_401_UNAUTHORIZED,
        content={"detail": exc.detail, "reason": exc.reason},
    )


def _validation_message(exc: RequestValidationError) -> str:
    """把校验错误拼成一句话，字段名在前，认得的类型用中文。"""
    parts: list[str] = []
    for error in exc.errors():
        field = _field_name(error["loc"])
        text = _validation_text(error)
        parts.append(f"{field}：{text}" if field else text)
    return "；".join(parts) or "请求参数不合法"


def _field_name(loc: tuple[int | str, ...]) -> str:
    """字段名：位置标记（body、path……）后面的部分。

    剩下的都是序号（比如 JSON 解析失败的 loc）时不算字段名，
    提示里不显示。
    """
    names = [str(item) for item in loc]
    if names and names[0] in {"body", "path", "query", "cookie", "header"}:
        names = names[1:]
    if names and all(name.isdigit() for name in names):
        return ""
    return ".".join(names)


def _validation_text(error: dict[str, object]) -> str:
    # 校验器自己抛的 ValueError 消息就是中文，去掉前缀直接用。
    message = str(error["msg"]).removeprefix("Value error, ")
    kind = error.get("type")
    if kind == "missing":
        return "缺少这个字段"
    if kind == "json_invalid":
        return "请求的正文不是合法的 JSON"
    if kind in {"model_type", "model_attributes_type"}:
        return "请求的正文不是一个对象"
    if kind in {
        "uuid_parsing",
        "uuid_validation",
        "uuid_type",
        "string_type",
        "int_type",
        "bool_type",
    }:
        return "格式不对"
    limits = error.get("ctx")
    if kind == "string_too_short" and isinstance(limits, dict):
        return f"长度不能少于 {limits.get('min_length', '?')}"
    if kind == "string_too_long" and isinstance(limits, dict):
        return f"长度不能超过 {limits.get('max_length', '?')}"
    return message


@app.post("/api/login")
def login(body: LoginRequest, request: Request, response: Response) -> LoginResponse:
    # 先查锁定再进验证：锁定期间连密码哈希都不碰（argon2 是 CPU 活）。
    _raise_if_login_locked(body.username, request)
    with db_session() as session:
        try:
            result, token = _login_account(session, body.username, body.password)
        except HTTPException as exc:
            _register_login_failure(exc, body.username, request)
            raise

    # 登录成功清账号维度的计数；IP 维度的让它自然过期：同一个 IP 上还有别的
    # 账号在正常登录，它们的计数不该跟着被清掉（跟改密端点同款语义）。
    clear_failures(_RATELIMIT_ACCOUNT_SCOPE, _login_account_key(body.username))
    _set_cookie(response, _COOKIE_NAME, token)
    return result


@app.post("/api/admin/login")
def admin_login(
    body: LoginRequest, request: Request, response: Response
) -> AdminLoginResponse:
    """控制台那一边：只认 role 是 admin 的账号，发 admin_login cookie。

    跟 /api/login 同一条规矩：先验密码再看 role，密码不对一律回
    「用户名或密码不正确」；限流也是同一套。控制台界面是后面那批活，
    接口先立起来。
    """
    _raise_if_login_locked(body.username, request)
    with db_session() as session:
        try:
            account = _verified_account(session, body.username, body.password)
            _require_role(account, _ROLE_ADMIN)
            token = _new_token(session, account)
            username = account.username
        except HTTPException as exc:
            _register_login_failure(exc, body.username, request)
            raise

    clear_failures(_RATELIMIT_ACCOUNT_SCOPE, _login_account_key(body.username))
    _set_cookie(response, _ADMIN_COOKIE_NAME, token)
    return AdminLoginResponse(username=username)


@app.get("/api/admin/accounts")
def admin_list_accounts(
    admin_cookie: Annotated[str | None, Cookie(alias=_ADMIN_COOKIE_NAME)] = None,
) -> AdminAccountsResponse:
    """控制台的账号列表：全部账号，按用户名排序。"""
    with db_session() as session:
        _admin_from_cookie(session, admin_cookie)
        rows = session.scalars(select(Account).order_by(Account.username))
        return AdminAccountsResponse(
            accounts=[
                AdminAccountItem(username=row.username, role=row.role) for row in rows
            ],
        )


@app.post("/api/admin/accounts/reset-password")
def admin_reset_password(
    body: AdminPasswordResetRequest,
    admin_cookie: Annotated[str | None, Cookie(alias=_ADMIN_COOKIE_NAME)] = None,
) -> AdminPasswordResetResponse:
    """控制台重置某个账号的密码：生成一个新密码，把它的登录全踢下线。

    对任何账号都能重置，包括管理员自己。新密码只在这一次响应里回显，
    日志只记账号 id。
    """
    with db_session() as session:
        _admin_from_cookie(session, admin_cookie)
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


@app.post("/api/admin/logout", status_code=status.HTTP_204_NO_CONTENT)
def admin_logout(
    admin_cookie: Annotated[str | None, Cookie(alias=_ADMIN_COOKIE_NAME)] = None,
) -> Response:
    """控制台退出：镜像 /api/logout，只是 cookie 换成 admin_login。"""
    with db_session() as session:
        if not _revoke_login_token(session, admin_cookie):
            result = JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED,
                content={"detail": _LOGIN_REQUIRED, "reason": _REASON_EXPIRED},
            )
            _clear_cookie(result, _ADMIN_COOKIE_NAME)
            return result

    result = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_cookie(result, _ADMIN_COOKIE_NAME)
    return result


@app.post("/api/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    with db_session() as session:
        if not _revoke_login_token(session, login_cookie):
            # 令牌已死时的退出也是会话类 401：同样带上 reason。
            result = JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED,
                content={"detail": _LOGIN_REQUIRED, "reason": _REASON_EXPIRED},
            )
            _clear_cookie(result, _COOKIE_NAME)
            return result

    result = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_cookie(result, _COOKIE_NAME)
    return result


@app.get("/api/profile")
def read_profile(
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> ProfileResponse:
    with db_session() as session:
        return _profile(_account_from_cookie(session, login_cookie))


@app.patch("/api/profile")
def update_profile(
    body: ProfileUpdate,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> ProfileResponse:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        language = account.language_setting
        if language is None:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _NO_LANGUAGE)
        language.locale = body.locale
        return _profile(account)


@app.post("/api/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    body: PasswordChange,
    request: Request,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
    admin_cookie: Annotated[str | None, Cookie(alias=_ADMIN_COOKIE_NAME)] = None,
) -> Response:
    """改密码：验旧密码、写新哈希，把这个账号的登录全踢下线。

    argon2 是 CPU 活：端点用同步的，跑在线程池里，不堵事件循环
    （/api/login 同一个道理）。请求体里有密码，日志只记账号 id。
    管理员改自己的密码也走这里：聊天页和控制台共用这一个端点。
    """
    client_ip = request.client.host if request.client else "unknown"

    with db_session() as session:
        account = _password_account(session, login_cookie, admin_cookie)
        account_id = str(account.id)
        # 锁定期间不做验证：不然锁形同虚设，攻击者还能拿这个接口继续试旧密码。
        locked = is_locked(_RATELIMIT_ACCOUNT_SCOPE, account_id) or is_locked(
            _RATELIMIT_IP_SCOPE, client_ip
        )
        if locked:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, _RATE_LIMITED)

        if not verify_password(account.password_hash, body.old_password):
            register_failure(_RATELIMIT_ACCOUNT_SCOPE, account_id)
            register_failure(_RATELIMIT_IP_SCOPE, client_ip)
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
    clear_failures(_RATELIMIT_ACCOUNT_SCOPE, account_id)
    logger.info("密码已修改 %s", account_id)
    result = Response(status_code=status.HTTP_204_NO_CONTENT)
    # 令牌已经全吊销：两个 cookie 都清掉，不管这次是从哪一边来的。
    _clear_cookie(result, _COOKIE_NAME)
    _clear_cookie(result, _ADMIN_COOKIE_NAME)
    return result


@app.post("/api/avatar")
def upload_avatar(
    file: Annotated[UploadFile, File()],
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> ProfileResponse:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        # 只读上限加一的字节：超了直接退回去，不把它整个读进内存。
        data = file.file.read(avatar_image.MAX_UPLOAD_BYTES + 1)
        try:
            account.avatar = avatar_image.normalize(data)
        except avatar_image.AvatarError as error:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error
        return _profile(account)


@app.get("/api/avatar")
def read_avatar(
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        data = account.avatar

    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_AVATAR)

    return Response(
        content=data,
        media_type="image/png",
        headers={
            "Cache-Control": "private, max-age=86400",
            "ETag": f'"{_avatar_version(data)}"',
        },
    )


@app.get("/api/status")
def read_status() -> StatusResponse:
    """页面用它做常驻提示。只报状态，不带任何内容，也不需要登录。"""
    return StatusResponse(
        database="ok" if _database_available() else "unavailable",
        reply_store="ok" if store_available() else "unavailable",
    )


def _database_available() -> bool:
    try:
        with db_session() as session:
            session.execute(select(1))
        return True
    except SQLAlchemyError:
        logger.warning("数据库不可用", exc_info=True)
        return False


@app.get("/api/sessions")
def list_sessions(
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> list[SessionItem]:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        return _session_items(account)


@app.post("/api/sessions")
def create_session(
    body: SessionCreate | None = None,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> SessionItem:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        created = ChatSession(account=account)
        if body is not None:
            created.title = body.title
        session.add(created)
        session.flush()
        session.refresh(created)
        return _session_item(created)


@app.patch("/api/sessions/{session_id}")
def rename_session(
    session_id: UUID,
    body: SessionRename,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> SessionItem:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        chat_session = _require_session(session, account, session_id)
        chat_session.title = body.title
        return _session_item(chat_session)


@app.patch("/api/sessions/{session_id}/pin")
def pin_session(
    session_id: UUID,
    body: SessionPin,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> SessionItem:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        chat_session = _require_session(session, account, session_id)
        chat_session.pinned = body.pinned
        chat_session.pinned_at = body.pinned_at
        return _session_item(chat_session)


@app.delete("/api/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: UUID,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    fastgpt = _fastgpt()
    await asyncio.to_thread(_authorize_session, session_id, login_cookie)

    try:
        await fastgpt.delete_history(session_id)
    except FastGPTError:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            _SERVER_ERROR,
        ) from None

    await asyncio.to_thread(_delete_session_row, session_id, login_cookie)
    discard_reply(session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/sessions/{session_id}/abort", status_code=status.HTTP_204_NO_CONTENT)
async def abort_session_reply(
    session_id: UUID,
    body: AbortRequest | None = None,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    """用户按了停止：掐掉这一轮的上游任务。已经写出来的半截文字留着。

    先把停止记下来，再取消任务：这样即使这一轮还没开始（停止请求先到），
    后到的对话请求也会看到这个编号，不再开这一轮。
    """
    await asyncio.to_thread(_authorize_session, session_id, login_cookie)

    turn_id = str(body.turn_id) if body is not None and body.turn_id is not None else ""
    if turn_id == "":
        # 页面没带编号就用当前这一轮的编号。
        turn_id = current_turn_id(session_id)
    # 停止这一侧的日志行也带上轮次编号，跟对话那一侧的日志对得上。
    set_turn_context(turn_id)
    request_stop(session_id, turn_id)

    task = _running.get(session_id)
    if not task:
        # 这一轮已经结束了，或者还没开始。不用改状态。
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # 告诉上游停下。v2 的停止是运行态标记，上游看到就收手；v1 只能靠断连接，
    # 那一招在 v2 上不管用。这个接口自己会等上游收尾（最多五秒），所以不等它。
    _ask_upstream_to_stop(session_id)

    for running in task:
        running.cancel()
    # 等这一轮真的收尾（状态改成 aborted），页面随后读到的才是最终状态，
    # 不会读到还在写的中间状态。
    await asyncio.wait(task, timeout=2.0)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/api/sessions/{session_id}/partial")
def read_session_partial(
    session_id: UUID,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> PartialReplyResponse:
    """「还在写吗」——只回答这一个问题。

    Redis 里这场会话的状态是 streaming 才回 200（半截文字、轮次编号、
    提问）；其余一切情况（写完了/失败/被停/键不存在）一律 404，页面去
    读库。结局语义不再由这个接口承担：即时结局随流的 done 帧走，永久
    结局在库的 message.status 上（docs/CHAT_STREAM_KNOWN_ISSUES.md
    第 3 条，2026-11-05 维护者拍板）。Redis 读不通照旧抛错（500）：
    那是「问不到服务器」，不是「没在写」，客户端靠状态码区分这两种。
    """
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        _require_session(session, account, session_id)

    partial = read_partial(session_id)
    if partial.status != STREAMING:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _PARTIAL_NOT_STREAMING)
    return PartialReplyResponse(
        status=STREAMING,
        text=partial.text,
        turn_id=partial.turn_id,
        question=partial.question,
    )


@app.get("/api/sessions/{session_id}/messages")
async def read_session_messages(
    session_id: UUID,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> HistoryResponse:
    """一场会话的完整线程：我们自己存的记录，加上正在写的这一轮。

    历史来自我们自己的表，不是 FastGPT：它清库、上游挂掉，页面照样看得见。
    老会话第一次读到的时候，把上游那一份抄一份过来。
    """
    await asyncio.to_thread(_authorize_session, session_id, login_cookie)

    stored = await asyncio.to_thread(chat_log.read_messages, session_id)
    if not stored:
        stored = await _backfill_session(session_id)

    messages = _merge_current_turn(stored, read_partial(session_id))
    return HistoryResponse(total=len(messages), messages=messages)


@app.post("/api/sessions/{session_id}/feedback", status_code=status.HTTP_204_NO_CONTENT)
async def update_feedback(
    session_id: UUID,
    body: FeedbackUpdate,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    """把一轮的点赞/点踩送到上游（docs/MESSAGE_ACTIONS.md 第四期）。

    反馈不存在我们库里：上游按 dataId（就是我们的轮次编号）记在那条
    回答上。没有轮次编号、或者这场会话的表里没有这一轮，都是 404——
    映射不到上游的 dataId，发过去也是打空。上游没收到是 502。
    """
    fastgpt = _fastgpt()
    await asyncio.to_thread(_authorize_session, session_id, login_cookie)
    if body.turn_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _FEEDBACK_TURN_MISSING)
    has_turn = await asyncio.to_thread(chat_log.has_turn, session_id, body.turn_id)
    if not has_turn:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _FEEDBACK_TURN_MISSING)
    try:
        await fastgpt.update_feedback(session_id, str(body.turn_id), body.feedback)
    except FastGPTError:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            _FEEDBACK_UPSTREAM_ERROR,
        ) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _backfill_session(session_id: UUID) -> list[chat_log.StoredMessage]:
    """把上游那一份抄进我们自己的表。

    我们有了这张表以后，老会话还没有记录。抄一份过来之后，
    页面的历史就从我们这份来了。
    """
    fastgpt = _fastgpt()
    try:
        records = await _session_records(session_id, fastgpt)
    except FastGPTError:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            _UPSTREAM_ERROR,
        ) from None

    await asyncio.to_thread(
        chat_log.backfill, session_id, chat_log.rounds_from_records(records)
    )
    return await asyncio.to_thread(chat_log.read_messages, session_id)


async def _session_records(
    session_id: UUID,
    fastgpt: FastGPT,
    cached: bool = True,
) -> list[ChatRecord]:
    """一场会话的全部历史。

    刷新一次页面就要读一次历史，刷新得急了会把上游打垮（实测：上游连不上了，
    每次失败在日志里留下两百多行）。这里留几秒的缓存：刷新多少次，
    上游就只被问一次。

    找记录要删的时候不能读缓存：缓存里可能是这一轮之前的那份，
    少了刚写上去的那条。
    """
    now = time.monotonic()
    if cached:
        stored = _records_cache.get(session_id)
        if stored is not None and now - stored[0] < _RECORDS_CACHE_SECONDS:
            return stored[1]

    records: list[ChatRecord] = []
    offset = 0
    while True:
        page = await fastgpt.records(session_id, offset, _RECORDS_PAGE_SIZE)
        records.extend(page.records)
        offset += _RECORDS_PAGE_SIZE
        if offset >= page.total:
            break

    _records_cache[session_id] = (now, records)
    _drop_stale_records(now)
    return records


def _drop_stale_records(now: float) -> None:
    for key in [
        key
        for key, (stamp, _) in _records_cache.items()
        if now - stamp > _RECORDS_CACHE_SECONDS * 20
    ]:
        del _records_cache[key]


def _merge_current_turn(
    stored: list[chat_log.StoredMessage],
    partial: PartialReply,
) -> list[HistoryMessageResponse]:
    """把 Redis 里当前这一轮接在历史后面。

    历史来自我们自己存的表：写完的轮次都在里面。正在写的那一轮还没落定，
    Redis 里那份更新（有半截文字），用它把表里那一条补上。
    """
    # 轮次结局（还在写/失败/被停）只挂在回答行上：提问和回答共用一个
    # 状态，两边都显示的话页面脚注会把同一条提示显示两遍。只有提问、
    # 没有回答的轮次（上游一个字没写出来就被停、从上游抄来的老会话）
    # 留在提问行。
    turns_with_answer = {
        item.turn_id for item in stored if item.role == chat_log.ROLE_ASSISTANT
    }

    def status_row(item: chat_log.StoredMessage) -> bool:
        return (
            item.role == chat_log.ROLE_ASSISTANT
            or item.turn_id not in turns_with_answer
        )

    messages: list[HistoryMessageResponse] = []
    for item in stored:
        # 读时兜底：表里 streaming 的行，Redis 的 partial 为空（turn_id 是
        # None）或对不上这一行，说明这一轮其实已经不在写了（进程死在半路、
        # 键过期）——展示层降级为 failed，不写库；启动对账
        # （chat_log.fail_stuck_rounds）会把它们一次标掉。编号对得上的行
        # 不降级：Redis 里那份状态更新，由下面的合并逻辑照实处理。
        stuck = item.status == STREAMING and partial.turn_id != item.turn_id
        row = status_row(item)
        messages.append(
            HistoryMessageResponse(
                id=item.id,
                role=item.role,
                text=item.text,
                turn_id=item.turn_id,
                waiting=item.status == STREAMING and not stuck and row,
                failed=(item.status == FAILED or stuck) and row,
                aborted=item.status == ABORTED and row,
            )
        )
    if partial.turn_id is None:
        return messages

    for index, item in enumerate(messages):
        if item.turn_id != partial.turn_id or item.role != "assistant":
            continue
        if not item.waiting:
            # 这一轮在我们自己的表里已经落定了：表里的是最终状态。
            return messages
        # 这一轮还在写：Redis 里的半截文字比表里的空位新。
        messages[index] = item.model_copy(
            update={
                "text": partial.text,
                "waiting": partial.status == STREAMING,
                "failed": partial.status == FAILED,
                "aborted": partial.status == ABORTED,
            }
        )
        return messages

    # 表里没有这一轮（写库失败，或者这一轮比这张表还早）：
    # 按老办法把 Redis 里这一轮接在后面。
    last = messages[-1] if messages else None
    if partial.question is not None and not (
        last is not None
        and last.role == "user"
        and last.text.strip() == partial.question.strip()
    ):
        messages.append(
            HistoryMessageResponse(
                id=f"{partial.turn_id}-q",
                role="user",
                text=partial.question,
                turn_id=partial.turn_id,
            )
        )

    messages.append(
        HistoryMessageResponse(
            id=partial.turn_id,
            role="assistant",
            text=partial.text,
            turn_id=partial.turn_id,
            waiting=partial.status == STREAMING,
            failed=partial.status == FAILED,
            aborted=partial.status == ABORTED,
        )
    )
    return messages


async def _clear_failed_turn(
    chat_id: UUID,
    turn_id: UUID,
    question: str,
    fastgpt: FastGPT,
) -> None:
    """删掉上一轮留下的记录。

    重发的是同一句提问，上游会再记一遍。不删的话，历史里就有两遍问答。
    回答那一条的编号是我们给的（responseChatItemId），提问那一条要从记录里找。
    我们自己那一份也要一起删：不然页面上会看见两遍。
    """
    # 删行之前先把这一轮的提问原文读出来：请求体里带的可能是新文字
    # （编辑重发），只有表里的原文才能和上游的悬空提问记录对上。
    stored_question = await asyncio.to_thread(chat_log.read_question, chat_id, turn_id)

    await asyncio.to_thread(chat_log.delete_round, chat_id, turn_id)

    try:
        records = await _session_records(chat_id, fastgpt, cached=False)
    except FastGPTError:
        logger.warning("读不到上游记录，重发的这一轮删不掉旧的 %s", chat_id)
        return

    # 文本比对优先用表里的原文；表里查不到（老数据、写库失败过）再退回
    # 请求体的文字。
    match_text = question if stored_question is None else stored_question
    content_ids = _failed_turn_content_ids(records, str(turn_id), match_text)
    for content_id in content_ids:
        if not await fastgpt.delete_item(chat_id, content_id):
            logger.warning("删不掉上游记录 %s", content_id)
    if content_ids:
        _records_cache.pop(chat_id, None)


def _failed_turn_content_ids(
    records: list[ChatRecord],
    turn_id: str,
    question: str,
) -> list[str]:
    """要删的记录：回答（我们的编号）和它前面那条提问。"""
    for index, record in enumerate(records):
        if record.role != "assistant" or record.id != turn_id:
            continue
        ids = [record.id]
        if index > 0 and records[index - 1].role == "user":
            ids.append(records[index - 1].id)
        return ids

    # 回答没写下来（上游在写之前就断了）：提问那条还在。
    # 只有它就是最后一条记录时才删：这一轮是最近的一轮，
    # 失败以后用户又问了别的，那条记录就不是我们的，不能删。
    if not records:
        return []
    last = records[-1]
    if last.role == "user" and last.text.strip() == question.strip():
        return [last.id]
    return []


@app.post("/api/chat")
async def chat(
    body: ChatRequest,
    login_cookie: Annotated[str | None, Cookie(alias=_COOKIE_NAME)] = None,
) -> Response:
    started = time.monotonic()
    turn_id = str(body.turn_id)
    # 从这里起这一轮的日志行都带着轮次编号：asyncio 建任务会拷贝上下文，
    # 中继和写库收尾那些后台任务自动继承。
    set_turn_context(turn_id)
    # INFO 只留元数据；完整请求体降到 DEBUG（debug 开关打开才写，
    # 见 settings.py）。请求体里没有登录 cookie。
    logger.info(
        "对话请求 chat_id=%s turn_id=%s retry_of=%s message_len=%d",
        body.chat_id,
        turn_id,
        body.retry_of,
        len(body.message),
    )
    logger.debug("对话请求全文 %s", body.model_dump_json(by_alias=True))
    fastgpt = _fastgpt()

    account_id = await asyncio.to_thread(_authorize_session, body.chat_id, login_cookie)

    # 同一个请求又来了（重复点击、页面重发）：这一轮已经登记过了，
    # 不能再开一轮，不然上游会生成两遍。
    if current_turn_id(body.chat_id) == turn_id:
        if round_in_flight(body.chat_id):
            raise HTTPException(status.HTTP_409_CONFLICT, _ROUND_BUSY)
        logger.info("这一轮已经登记过 %s，不再重开", body.chat_id)
        return StreamingResponse(
            _empty_sse(), media_type="text/event-stream", headers=_SSE_HEADERS
        )

    # 同一场会话同时只跑一轮。上一轮还在写的时候再发一次，
    # FastGPT 那边会多出一轮，Redis 里的半截文字也会被清掉重来，两轮的片段交错着写。
    if round_in_flight(body.chat_id):
        raise HTTPException(status.HTTP_409_CONFLICT, _ROUND_BUSY)

    if stop_requested(body.chat_id, turn_id):
        # 用户在对话请求到达之前就按了停止：这一轮不开。
        # 提问照样登记，刷新以后还能看到「问了什么、这一轮被停了」。
        begin_reply(body.chat_id, turn_id, body.message)
        mark_aborted(body.chat_id)
        written = await asyncio.to_thread(
            _record_stopped_round, body.chat_id, body.turn_id, body.message
        )
        logger.info("这一轮发出之前就被停止 %s", body.chat_id)
        _log_turn_summary(
            turn_id=turn_id,
            chat_id=body.chat_id,
            account_id=account_id,
            outcome=ABORTED,
            started_at=started,
            first_content_at=None,
            bytes_sent=0,
            stop_sent=False,
            db_written=written,
            progress_events=0,
            done_status=ABORTED,
        )
        # 结局随流明说：被停在这一轮开起来之前，done 帧照样发。
        done = _done_chunk(turn_id, ABORTED, "stop", 0)
        return StreamingResponse(
            _empty_sse(done), media_type="text/event-stream", headers=_SSE_HEADERS
        )

    # 之前叫停上游的那一下要落地：停止标记晚到的话，
    # 新开的这一轮会被自己人写的标记掐掉。
    await _wait_for_stop(body.chat_id)

    # 重发：把上一轮在上游留下的记录删掉，历史里才不会出现两遍问答。
    if body.retry_of is not None:
        await _clear_failed_turn(body.chat_id, body.retry_of, body.message, fastgpt)

    # 先登记这一轮，页面断流之后才知道请求有没有落地。
    begin_reply(body.chat_id, turn_id, body.message)
    relay = _Relay()
    relay.account_id = account_id
    relay.turn_id = turn_id
    task = asyncio.create_task(
        _relay(body.chat_id, body.message, turn_id, relay, fastgpt)
    )
    _running.setdefault(body.chat_id, set()).add(task)
    task.add_done_callback(lambda done: _forget(body.chat_id, done))
    # 先把响应头发出去，页面的等待气泡立刻就转起来。
    # 上游出问题时流会直接结束（没有 [DONE]），页面据此判断这一轮没写完。
    return StreamingResponse(
        _sse(relay), media_type="text/event-stream", headers=_SSE_HEADERS
    )


async def _relay(
    chat_id: UUID,
    message: str,
    turn_id: str,
    relay: _Relay,
    fastgpt: FastGPT,
) -> None:
    # 这一轮先记进我们自己的表：我们的进程要是中途死了，
    # 表里留着这一轮的提问，页面上不会少一轮。
    await asyncio.to_thread(chat_log.begin_round, chat_id, UUID(turn_id), message)
    try:
        async for event in fastgpt.events(chat_id, message, turn_id):
            if isinstance(event, ProgressEvent):
                # 进度帧：只转发给页面，不算回答正文——不 append_chunk、
                # 不进 relay.text/bytes_sent，也不动「发过内容没有」的
                # 失败语义（relay.sent）。心跳和它不冲突：静默期里有
                # 进度帧入队，_sse 那边的 wait_for 自然等不满 15 秒。
                relay.progress += 1
                outgoing = _progress_chunk(event)
                logger.debug("发给页面进度帧 %s", outgoing.removesuffix("\n\n"))
                await relay.queue.put(outgoing)
                continue
            if isinstance(event, str):
                if relay.first_content_at is None:
                    relay.first_content_at = time.monotonic()
                append_chunk(chat_id, event)
                relay.text += event
                outgoing = _chunk(event)
                logger.debug("发给页面 %s", outgoing.removesuffix("\n\n"))
                await relay.queue.put(outgoing)
                relay.sent = True
                continue

            mark_finished(chat_id)
            # 结局落定：done 帧说 completed。done 帧是即时判断，库是
            # 最终事实（见 _sse 的 docstring）。
            relay.done_status = COMPLETED
            logger.debug("发给页面 %s", _DONE_FRAME)
            await relay.queue.put(_DONE_FRAME)
            relay.sent = True
            break
        else:
            # 上游没发 [DONE] 就把流走完：算上游失败，done 帧照实说。
            relay.failed = True
            relay.done_status = FAILED
            relay.done_reason = "upstream"
    except asyncio.CancelledError:
        # 用户按了停止。状态在这里写：任务被掐掉时它确实还在写，
        # 页面轮询 /partial 时就能看到 aborted。
        logger.info("这一轮被停止 %s", chat_id)
        relay.status = ABORTED
        relay.done_status = ABORTED
        relay.done_reason = "stop"
        # 停止端点在掐这个任务之前已经叫停了上游，摘要行照实记。
        relay.stop_sent = True
        mark_aborted(chat_id)
        raise
    except FastGPTError:
        relay.failed = True
        relay.done_status = FAILED
        relay.done_reason = "upstream"
    except Exception as exc:
        logger.error("FastGPT 读取失败 %s", chat_id, exc_info=exc)
        relay.failed = True
        relay.done_status = FAILED
        relay.done_reason = "internal"
    finally:
        try:
            if relay.failed:
                if relay.sent:
                    mark_failed(chat_id)
                else:
                    discard_reply(chat_id)
        finally:
            # 不能 await：任务被取消时再 await 会把取消吞掉。
            relay.queue.put_nowait(None)
        # 失败以后也要叫上游收手。v2 不看连接断没断，不叫停的话
        # 上游会把这一轮写完：token 白花，那条记录还会晚到我们的历史里。
        # 放在结束流以后叫：页面不用等这一下。
        # 这一下要等它落地：那时候上游可能正卡着，请求过去得慢一些。
        if relay.failed:
            relay.stop_sent = True
            _ask_upstream_to_stop(chat_id, wait=True)
        # 这一轮落定以后写进我们自己的表。
        _settle_round(chat_id, turn_id, relay, fastgpt)


def _record_stopped_round(session_id: UUID, turn_id: UUID, question: str) -> bool:
    """这一轮在开始之前就被按了停止：提问记下来，状态是 aborted。

    返回写库成没成，摘要行用。
    """
    chat_log.begin_round(session_id, turn_id, question)
    return chat_log.finish_round(session_id, turn_id, "", ABORTED)


def _settle_round(
    chat_id: UUID,
    turn_id: str,
    relay: _Relay,
    fastgpt: FastGPT,
) -> None:
    """这一轮落定以后写进我们自己的表。

    放在单独的任务里：这一轮的任务可能正被取消（用户按了停止），
    在它里面 await 写库会写不成。
    """
    status = FAILED if relay.failed else relay.status
    task = asyncio.create_task(
        _write_round_end(chat_id, turn_id, relay, status, fastgpt)
    )
    _settle_tasks.add(task)
    task.add_done_callback(_settle_tasks.discard)


async def _write_round_end(
    chat_id: UUID,
    turn_id: str,
    relay: _Relay,
    status: str,
    fastgpt: FastGPT,
) -> None:
    """这一轮落定以后写进我们自己的表。

    分工（2026-11-05 维护者拍板）：页面的即时语义由流里的 done 帧负责
    ——done 帧是即时判断，在这个函数跑起来之前就已经发出去了，不等待
    也不回改。下面「失败后与上游对账」的逻辑保留，但降级为归档核对：
    只修库里的存档文本和状态（页面刷新以后走 /messages 看到的语义），
    不再影响任何页面即时语义。
    """
    text = relay.text
    if status == FAILED:
        # 归档核对：失败以后上游可能已经把答案写完了（我们的 [DONE]
        # 丢了）。叫停已经发出去了，等它落地，再按编号核对一次上游。
        # 核对的结果只进库，不进页面。
        await _wait_for_stop(chat_id)
        answer = await _upstream_answer(chat_id, turn_id, fastgpt)
        if answer is not None and answer.startswith(text):
            # 上游那份从我们收到的那段接着往下写：这一轮其实写完了，
            # 断的是我们的 [DONE]。存档用上游那份，库里状态改成写完了
            # （done 帧已经说过的 failed 不回改）。
            text = answer
            status = COMPLETED
    written = await asyncio.to_thread(
        chat_log.finish_round, chat_id, UUID(turn_id), text, status
    )
    # 这一轮到此落定：打一行结构化摘要。只在这里打一次——上面的对账
    # 也在这个函数里，不会在重试或对账路径上重复打。
    _log_turn_summary(
        turn_id=turn_id,
        chat_id=chat_id,
        account_id=relay.account_id,
        outcome=status,
        started_at=relay.started_at,
        first_content_at=relay.first_content_at,
        bytes_sent=len(relay.text),
        stop_sent=relay.stop_sent,
        db_written=written,
        progress_events=relay.progress,
        done_status=relay.done_status,
    )


def _log_turn_summary(
    *,
    turn_id: str,
    chat_id: UUID,
    account_id: str | None,
    outcome: str,
    started_at: float,
    first_content_at: float | None,
    bytes_sent: int,
    stop_sent: bool,
    db_written: bool,
    progress_events: int,
    done_status: str | None,
) -> None:
    """每轮一行的结构化摘要：键值对形式，方便 grep。

    outcome 用 turn_status 的状态词（completed/failed/aborted）；first_byte_ms
    是从开始到首个内容帧的毫秒数，一个内容帧都没有就是 "-"；
    progress_events 是这一轮转发给页面的进度帧数；done_status 是流里
    done 帧告知页面的结局（即时判断），和 outcome（库里的最终事实）
    可能不同：失败后与上游对账可能改成 completed，done 帧不回改。
    """
    duration_ms = int((time.monotonic() - started_at) * 1000)
    first_byte_ms = (
        "-"
        if first_content_at is None
        else str(int((first_content_at - started_at) * 1000))
    )
    logger.info(
        "turn_summary turn_id=%s chat_id=%s account_id=%s outcome=%s "
        "duration_ms=%d first_byte_ms=%s bytes_sent=%d stop_sent=%s "
        "db_written=%s progress_events=%d done_status=%s",
        turn_id,
        chat_id,
        account_id or "-",
        outcome,
        duration_ms,
        first_byte_ms,
        bytes_sent,
        "yes" if stop_sent else "no",
        "yes" if db_written else "no",
        progress_events,
        done_status or "-",
    )


async def _upstream_answer(
    chat_id: UUID,
    turn_id: str,
    fastgpt: FastGPT,
) -> str | None:
    """上游那一轮最后写出来的话。没有就是没有。"""
    try:
        records = await _session_records(chat_id, fastgpt, cached=False)
    except FastGPTError:
        logger.warning("读不到上游记录，核对不了 %s", chat_id)
        return None
    for record in records:
        if record.role == "assistant" and record.id == turn_id:
            return record.text
    return None


def _forget(chat_id: UUID, task: asyncio.Task[None]) -> None:
    tasks = _running.get(chat_id)
    if tasks is None:
        return
    tasks.discard(task)
    if not tasks:
        del _running[chat_id]


async def _sse(relay: _Relay) -> AsyncIterator[str]:
    """把队列里的帧转给页面；15 秒没有动静就发一帧心跳。

    心跳是 SSE 注释帧（": ping"）：前端解析器只认 data: 行，这一帧天然
    被忽略；作用是让中间层和页面知道流还活着。哨兵 None 的结束语义和
    取消语义都不变：wait_for 超时会把 queue.get 原样取消重挂，
    asyncio.Queue 的唤醒不直接交接条目，超时不会吞掉已入队的帧。

    收尾先发结局帧再发 [DONE]：relay 带着结局信息（done_status 落定）
    时，在 yield "data: [DONE]" 之前先 yield event: done 帧；失败/被停
    的路径没有 [DONE]，哨兵到达时补发 done 帧再结束流。

    **done 帧是即时判断，库是最终事实**（2026-11-05 维护者拍板）：
    _write_round_end 事后与上游对账，可能把 failed 改成 completed；
    done 帧不等待那次对账，也不回改。页面的即时语义以 done 帧为准，
    刷新以后的语义以库（/messages 消息上的标志）为准。
    """
    done_sent = False
    while True:
        try:
            item = await asyncio.wait_for(relay.queue.get(), _HEARTBEAT_SECONDS)
        except TimeoutError:
            yield ": ping\n\n"
            continue
        if item is None:
            # 中继落定：失败/被停的路径没有 [DONE]，结局帧在这里补发。
            if not done_sent and relay.done_status is not None:
                yield _done_chunk(
                    relay.turn_id,
                    relay.done_status,
                    relay.done_reason,
                    len(relay.text),
                )
            break
        if item == _DONE_FRAME and not done_sent and relay.done_status is not None:
            yield _done_chunk(
                relay.turn_id, relay.done_status, relay.done_reason, len(relay.text)
            )
            done_sent = True
        yield item


async def _empty_sse(done: str | None = None) -> AsyncIterator[str]:
    """没有正文可写的流：直接结束，没有 [DONE]。

    「开轮前被停」的路径带着结局帧（status=aborted, reason=stop,
    bytes_sent=0）：结局随流明说，页面不靠「流怎么断的」反推。
    重复请求的路径（这一轮已经登记/落定，页面读库对账）维持空流。
    """
    if done is not None:
        yield done


def _progress_chunk(event: ProgressEvent) -> str:
    """跟前端钉死的进度帧：event: progress + {"name","status"}。

    name/status 原样转发，不做映射（2026-11-05 维护者拍板：节点名原样
    显示）。前端解析器只认 data: 行，event: 行是给命名事件消费方的。
    """
    payload = json.dumps(
        {"name": event.name, "status": event.status},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"event: progress\ndata: {payload}\n\n"


def _done_chunk(turn_id: str, status: str, reason: str | None, bytes_sent: int) -> str:
    """跟前端钉死的结局帧：event: done + TurnDoneEvent JSON。

    与进度帧同款风格：命名事件、紧凑分隔符、ensure_ascii=False。
    老前端的解析器把未知命名事件的 data 整帧忽略，加这一帧不破坏
    旧行为（2026-11-05 维护者拍板：流里引入命名事件）。
    """
    event = TurnDoneEvent(
        turn_id=turn_id,
        status=status,
        reason=reason,
        bytes_sent=bytes_sent,
    )
    return f"event: done\ndata: {event.model_dump_json()}\n\n"


def _chunk(content: str) -> str:
    payload = json.dumps(
        {"choices": [{"delta": {"content": content}}]},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"data: {payload}\n\n"


def _fastgpt() -> FastGPT:
    missing = empty_fastgpt_fields(load_settings())
    if missing:
        logger.error("FastGPT 配置为空：%s", "、".join(missing))
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _SERVER_ERROR)

    fastgpt = app.state.fastgpt
    if not isinstance(fastgpt, FastGPT):
        logger.error("FastGPT 客户端未建立")
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _SERVER_ERROR)
    return fastgpt


def _upstream_client() -> FastGPT | None:
    """上游客户端没有就返回 None。

    停止是尽力而为：上游连不上不能让停止接口整个失败，
    我们自己的状态（Redis 里的停止标记）才是页面要看的东西。
    """
    fastgpt = app.state.fastgpt
    if not isinstance(fastgpt, FastGPT):
        return None
    return fastgpt


def _ask_upstream_to_stop(session_id: UUID, wait: bool = False) -> None:
    """给上游发停止请求，不等它返回。

    wait 为真时把它记在会话上：开新一轮之前要等它落地
    （停止标记晚到的话，新开的那一轮会被自己人写的标记掐掉）。
    按停止那条路不用等：那时候上游还好好着，标记很快就写进去了。
    """
    task = asyncio.create_task(_stop_upstream(session_id))
    _stop_tasks.add(task)
    task.add_done_callback(_stop_tasks.discard)
    if wait:
        _pending_stops.setdefault(session_id, set()).add(task)
        task.add_done_callback(lambda done: _forget_pending_stop(session_id, done))


def _forget_pending_stop(session_id: UUID, task: asyncio.Task[None]) -> None:
    tasks = _pending_stops.get(session_id)
    if tasks is None:
        return
    tasks.discard(task)
    if not tasks:
        del _pending_stops[session_id]


async def _wait_for_stop(session_id: UUID) -> None:
    """等叫停上游的那几下落定。

    停止是一个运行态标记：标记写进去，上游才会在下一个节点边界收手。
    标记晚到的话，新开的那一轮会被自己人写的停止标记掐掉。
    """
    tasks = _pending_stops.get(session_id)
    if not tasks:
        return
    await asyncio.wait(list(tasks), timeout=_STOP_WAIT_SECONDS)


async def _stop_upstream(session_id: UUID) -> None:
    fastgpt = _upstream_client()
    if fastgpt is None:
        logger.warning("上游客户端没建起来 %s，这一轮停不了上游", session_id)
        return
    try:
        stopped = await fastgpt.stop_chat(session_id)
    except Exception:
        logger.error("上游停止失败 %s", session_id, exc_info=True)
        return
    logger.info(
        "上游停止 %s：%s", session_id, "上游收到了" if stopped else "上游没回成功"
    )


def _require_session(
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


def _authorize_session(session_id: UUID, login_cookie: str | None) -> str:
    """确认这场会话是这个账号的，顺手把账号 id 带出来。

    数据库是同步的，接口是异步的：这一步要放到线程里跑，
    别把事件循环卡住（卡住的时候，正在流式输出的那一轮也发不出去）。
    账号 id 只有日志摘要行用；不需要它的调用方忽略返回值就行。
    """
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        _require_session(session, account, session_id)
        return str(account.id)


def _delete_session_row(session_id: UUID, login_cookie: str | None) -> None:
    with db_session() as session:
        account = _account_from_cookie(session, login_cookie)
        chat_session = _require_session(session, account, session_id)
        # 消息先删：它有外键指着这场会话。
        session.execute(delete(ChatMessage).where(ChatMessage.session_id == session_id))
        session.delete(chat_session)


def _verified_account(session: Session, username: str, password: str) -> Account:
    """密码验过的账号。顺手把落后的哈希重写一遍。

    没这个人、密码不对，都是同一句话：不给探测留口子。role 要等密码
    验对了才看（顺序见 docs/ACCOUNT_MANAGEMENT.md 的「role」一节）。
    """
    account = session.scalar(select(Account).where(Account.username == username))
    if not isinstance(account, Account):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    if not verify_password(account.password_hash, password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    if needs_rehash(account.password_hash):
        account.password_hash = hash_password(password)

    return account


def _require_role(account: Account, role: str) -> None:
    """密码对了但账号不属于这一边：403，跟「密码不对」分开说。"""
    if account.role == role:
        return
    denied = _ROLE_DENIED_CHAT if role == _ROLE_CHAT else _ROLE_DENIED_ADMIN
    raise HTTPException(status.HTTP_403_FORBIDDEN, denied)


def _new_token(session: Session, account: Account) -> str:
    token = secrets.token_urlsafe(32)
    session.add(
        LoginToken(
            account=account,
            token_hash=_token_hash(token),
            expires_at=_login_deadline(),
        )
    )
    return token


def _login_account(
    session: Session,
    username: str,
    password: str,
) -> tuple[LoginResponse, str]:
    account = _verified_account(session, username, password)
    _require_role(account, _ROLE_CHAT)

    language = account.language_setting
    if language is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _NO_LANGUAGE)

    token = _new_token(session, account)
    result = LoginResponse(
        locale=language.locale,
        sessions=_session_items(account),
    )
    return result, token


def _login_account_key(username: str) -> str:
    """登录限流的账号维度键：归一化的用户名。

    数据库里 admin、Admin、"admin " 是三个账号；限流键照原文用的话，
    换个写法就把计数摊到三个键上，锁定形同虚设。
    """
    return username.strip().lower()


def _login_client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _raise_if_login_locked(username: str, request: Request) -> None:
    """进密码验证之前先查账号和 IP 两个维度的锁定（照改密端点的做法）。"""
    account_key = _login_account_key(username)
    client_ip = _login_client_ip(request)
    locked = is_locked(_RATELIMIT_ACCOUNT_SCOPE, account_key) or is_locked(
        _RATELIMIT_IP_SCOPE, client_ip
    )
    if locked:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, _RATE_LIMITED)


def _register_login_failure(
    exc: HTTPException, username: str, request: Request
) -> None:
    """登录没成时两个维度都记失败。只数 401。

    没这个人和密码不对是同一句 401，计数也不分这两种：不然「试几次以后
    是不是 429」会把用户名存不存在漏出去。403（密码对了但 role 不属于
    这一边）说明密码已经验对，不记。
    """
    if exc.status_code != status.HTTP_401_UNAUTHORIZED:
        return
    register_failure(_RATELIMIT_ACCOUNT_SCOPE, _login_account_key(username))
    register_failure(_RATELIMIT_IP_SCOPE, _login_client_ip(request))


def _cached_account(session: Session, login_cookie: str | None) -> Account | None:
    """中间件已经查好的账号。没有缓存或者 cookie 对不上就是 None。"""
    cached = _REQUEST_ACCOUNT.get()
    if cached is None or login_cookie is None or cached[0] != login_cookie:
        return None
    return _account_by_id(session, cached[1])


def _account_by_id(session: Session, account_id: UUID) -> Account | None:
    account = session.get(Account, account_id)
    return account if isinstance(account, Account) else None


def _account_from_cookie(session: Session, login_cookie: str | None) -> Account:
    """聊天接口只认 chat 账号。

    判断放在这一层，所有聊天接口就都盖到了，不用每个端点自己记着查。
    中间件验过的 cookie 直接用缓存的账号 id（一次主键查询），
    不再做一轮令牌查库加续期。
    """
    account = _cached_account(session, login_cookie)
    if account is None:
        account_id = _renew_login_token(session, login_cookie)
        account = None if account_id is None else _account_by_id(session, account_id)
    if account is None:
        raise _SessionUnauthorized()
    _require_role(account, _ROLE_CHAT)
    return account


def _admin_from_cookie(session: Session, admin_cookie: str | None) -> Account:
    """控制台接口只认 admin_login cookie 里的 admin 账号。

    镜像 _account_from_cookie。token 无效或者账号不是 admin，都回
    「未登录」（401）：这个 cookie 只有控制台登录接口自己种，
    不像登录那样需要把「密码对了但角色不对」分开说。
    中间件的缓存只盖聊天侧的 login cookie，控制台这边自己查一轮。
    """
    account_id = _renew_login_token(session, admin_cookie)
    account = None if account_id is None else _account_by_id(session, account_id)
    if account is None or account.role != _ROLE_ADMIN:
        raise _SessionUnauthorized()
    return account


def _password_account(
    session: Session,
    login_cookie: str | None,
    admin_cookie: str | None,
) -> Account:
    """改密端点两边都认：聊天 cookie 里的 chat 账号，或控制台 cookie 里的 admin 账号。

    管理员改自己的密码也走 /api/password，所以不能只用 _account_from_cookie。
    两边都对不上就是没登录。
    """
    account = _cached_account(session, login_cookie)
    if account is not None and account.role == _ROLE_CHAT:
        return account
    account_id = _renew_login_token(session, login_cookie)
    account = None if account_id is None else _account_by_id(session, account_id)
    if account is not None and account.role == _ROLE_CHAT:
        return account
    account_id = _renew_login_token(session, admin_cookie)
    account = None if account_id is None else _account_by_id(session, account_id)
    if account is not None and account.role == _ROLE_ADMIN:
        return account
    raise _SessionUnauthorized()


def _renew_login_token(session: Session, login_cookie: str | None) -> UUID | None:
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
            LoginToken.token_hash == _token_hash(login_cookie),
            LoginToken.expires_at > func.now(),
        )
        .values(expires_at=_login_deadline())
        .returning(LoginToken.account_id)
        .execution_options(synchronize_session=False)
    )


def _renew_cookie_token(login_cookie: str) -> UUID | None:
    """中间件那一份：自己开会话，校验加续期，把账号 id 带回来。"""
    with db_session() as session:
        return _renew_login_token(session, login_cookie)


def _revoke_login_token(session: Session, login_cookie: str | None) -> bool:
    """退出登录：一条 DELETE ... RETURNING 删掉这个还没过期的令牌。

    查不到或者已经过期都算没登录（过期的行交给周期清扫）；
    返回删没删到行。
    """
    if login_cookie is None or login_cookie == "":
        return False
    token_id = session.scalar(
        delete(LoginToken)
        .where(
            LoginToken.token_hash == _token_hash(login_cookie),
            LoginToken.expires_at > func.now(),
        )
        .returning(LoginToken.id)
        .execution_options(synchronize_session=False)
    )
    return token_id is not None


def _login_deadline() -> datetime:
    return datetime.now(UTC) + timedelta(seconds=_COOKIE_MAX_AGE)


def _sweep_expired_tokens() -> None:
    with db_session() as session:
        session.execute(
            delete(LoginToken).where(
                LoginToken.expires_at <= datetime.now(UTC),
            ),
        )


async def _sweep_expired_tokens_loop() -> None:
    """周期清扫：启动立刻跑一次，之后每 _SWEEP_INTERVAL_SECONDS 一次。

    原来这一步挂在请求路径上（每个带令牌的请求都扫一遍全表），现在只在
    这里跑。失败只记一条、不掐循环：数据库恢复以后下一轮会补上。
    """
    while True:
        try:
            await asyncio.to_thread(_sweep_expired_tokens)
        except Exception:
            logger.warning("清扫过期令牌失败", exc_info=True)
        await asyncio.sleep(_SWEEP_INTERVAL_SECONDS)


def _profile(account: Account) -> ProfileResponse:
    language = account.language_setting
    if language is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _NO_LANGUAGE)

    locale = language.locale
    if locale != "zh-CN" and locale != "zh-TW" and locale != "en":
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, _NO_LANGUAGE)
    return ProfileResponse(
        id=account.id,
        username=account.username,
        locale=locale,
        avatar_url=_avatar_url(account),
    )


def _avatar_url(account: Account) -> str:
    data = account.avatar
    if data is None:
        return _DEFAULT_AVATAR_URL
    return f"/api/avatar?v={_avatar_version(data)}"


def _avatar_version(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def _set_cookie(response: Response, name: str, token: str) -> None:
    response.set_cookie(
        key=name,
        value=token,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        path="/",
    )


def _clear_cookie(response: Response, name: str) -> None:
    response.delete_cookie(
        key=name,
        path="/",
        httponly=True,
        samesite="lax",
    )


def _session_items(account: Account) -> list[SessionItem]:
    return [_session_item(item) for item in account.sessions]


def _session_item(item: ChatSession) -> SessionItem:
    return SessionItem(
        id=item.id,
        title=item.title,
        pinned=item.pinned,
        pinned_at=item.pinned_at,
        created_at=item.created_at,
    )


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
