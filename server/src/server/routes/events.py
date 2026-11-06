"""会话状态通道：GET /api/events，服务器主动推「你的登录态没了」。

协议按 docs/ACCOUNT_MANAGEMENT.md「会话状态通道」一节的设计（
docs/improvement-research/backend-api.md N5 引用同一份设计稿）：
SSE 命名事件 state，传的是状态不是一次性事件——连上就先推一次当前
状态，断线期间错过推送的客户端重连时天然补齐。总线住在
server/pushbus.py：进程内存实现，依赖单 worker 硬性规定。
"""

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Cookie
from fastapi.responses import StreamingResponse

from server import pushbus
from server.db import db_session
from server.security import COOKIE_NAME, account_from_cookie
from server.streaming.framing import SSE_HEADERS

router = APIRouter()

# 心跳照聊天流同款规矩（streaming/sse.py 的 HEARTBEAT_SECONDS）：15 秒
# 没有动静就发一帧 SSE 注释帧 ": ping"，防中间代理切断空闲连接。数值在
# 本模块自持、不从 streaming 域 import：那边是聊天中继的模块，一条
# 只发心跳的通道不该跟它跨域耦合。
_HEARTBEAT_SECONDS = 15.0

# 每个 reason 配的一句话。前端可以只用 reason 配自己的文案，message 是
# 服务器给的建议文案（设计稿的示例帧就带着 message）。
_MESSAGES: dict[str, str] = {
    pushbus.REASON_EXPIRED: "会话已过期，请重新登录",
    pushbus.REASON_PASSWORD_CHANGED: "密码已修改，所有设备已退出登录，请重新登录",
    pushbus.REASON_ADMIN_RESET: "管理员重置了你的密码，请重新登录",
}
_FALLBACK_MESSAGE = "登录状态已失效，请重新登录"


def _state_frame(payload: dict) -> str:
    """跟前端钉死的命名事件帧：event: state + JSON 载荷。

    与聊天流的进度/结局帧同款风格（streaming/framing.py）：命名事件、
    紧凑分隔符、ensure_ascii=False。
    """
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: state\ndata: {data}\n\n"


@router.get("/api/events")
async def account_events(
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> StreamingResponse:
    """SSE 长连接：这个账号的登录态变化由服务器推到这里。

    鉴权与其它账号级端点一致（复用 account_from_cookie）：没带 cookie
    是 401（不带 reason）；带了 cookie 但令牌不认识/已过期/被吊销是
    401 + reason=expired（会话类 401 语义，errors.py）；role 不是
    chat 是 403。

    前端契约（前端实现另线跟进，契约以此为准）：

    - 建立连接：页面进入「已登录」态后 ``new EventSource("/api/events")``，
      同源请求自动带 cookie，不用也不能另设请求头。
    - 连上后的第一帧必是 ``event: state`` + ``data: {"valid":true,
      "account":用户名}``，收到即建立连接成功。
    - 要动作的是 ``event: state`` + ``data: {"valid":false,"reason":…,
      "message":…}``：收到就进入「留在原页面的过期状态」——与收到带 reason 的
      401 时同一套行为（会话、消息、草稿原地保留，输入区禁用、挂常驻
      警示条，见 docs/CHAT_PAGE_BEHAVIOR.md）。reason
      词表：expired（令牌过期被清扫）/ password_changed（本账号改了
      密码）/ admin_reset（控制台重置了密码）；message 是建议文案，
      不认识的 reason 也按失效处理（拿 message 或自己的保底文案）。
    - 推完 valid:false 服务器会主动结束这条流（一次登录态只坏一回）。
      EventSource 随后自动重连——cookie 已死，重连会收到 401，
      EventSource 对 401 不再重试、彻底关闭，这是预期行为，前端不用
      管它，也不要手动无限重连；重新登录成功后新建一个 EventSource。
    - 断网/服务器重启：EventSource 自动重连，重连成功先收到
      {"valid":true}，天然完成状态补齐，前端不需要额外补状态。
    - 心跳：15 秒无动静有一帧 SSE 注释帧 ``: ping``，EventSource
      自动忽略。
    """
    # 鉴权丢线程：同步的 psycopg 不堵事件循环（与其它账号级端点一致）。
    account_id, username = await asyncio.to_thread(_account_snapshot, login_cookie)
    # 订阅放在生成器里、不放这里：生成器的 finally 才保证退订配对；
    # 客户端在响应体开流之前就断开时，生成器压根不会启动，也就不留
    # 悬空的订阅。
    return StreamingResponse(
        _event_stream(account_id, username),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


def _account_snapshot(login_cookie: str | None) -> tuple[UUID, str]:
    """鉴权的线程那半：cookie 换账号，把 id 和用户名带出来。

    值在会话里就取好：db_session 退出时提交，ORM 对象随后过期，
    出去再读属性会报错。
    """
    with db_session() as session:
        account = account_from_cookie(session, login_cookie)
        return account.id, account.username


async def _event_stream(account_id: UUID, username: str) -> AsyncIterator[str]:
    """流本体：先发当前状态，再转发推送；哨兵或断开就收尾。

    鉴权已经过了，登录态必然有效，所以连上的第一帧固定 valid:true
    （设计稿：连上先发一次状态最要紧——重连补状态就靠它）。
    """
    queue, unsubscribe = pushbus.subscribe(account_id)
    try:
        yield _state_frame({"valid": True, "account": username})
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), _HEARTBEAT_SECONDS)
            except TimeoutError:
                # 心跳注释帧。wait_for 超时会把 queue.get 原样取消重挂，
                # Queue 的唤醒不直接交接条目，超时不会吞掉已入队的帧
                # （与 streaming/sse.py 同理）。
                yield ": ping\n\n"
                continue
            if item is None:
                # 总线关闭哨兵（服务关停，pushbus.shutdown）：正常收尾，
                # 流结束交给 EventSource 自动重连。
                break
            reason = item.get("reason")
            message = _MESSAGES.get(reason, _FALLBACK_MESSAGE)
            yield _state_frame({"valid": False, "reason": reason, "message": message})
            # 一次登录态只坏一回：推完「失效」就结束流（契约见端点
            # docstring），不给已经死掉的登录态挂着一条活连接。
            break
    finally:
        # 客户端断开（CancelledError）、哨兵、正常结束，条条路都要退订：
        # 没有这个 finally，队列会越攒越多（设计稿点名）。
        unsubscribe()
