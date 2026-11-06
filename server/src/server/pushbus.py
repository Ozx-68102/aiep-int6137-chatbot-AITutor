"""进程内推送总线：账号 id → /api/events 的订阅队列集合。

为什么进程内存就够：本项目成文铁律是单 worker 运行（server/AGENTS.md
「边界」一节），停止轮次、启动对账、过期令牌清扫都按单进程假设跑——
这个总线同理：发布者（三个吊销触发点）和订阅者（SSE 长连接）必然
在同一个进程里。**多进程部署时这个总线不成立**：推送只到得了本进程
的订阅者，落在别的 worker 上的页面照样蒙在鼓里，而且不报错。要改
部署形态，先读 server/AGENTS.md「边界」一节，再把总线换成跨进程
通道（比如 Redis pub/sub）。

线程模型（这个模块最绕的地方，改之前想清楚）：

- asyncio.Queue 不是线程安全的，put_nowait 必须在事件循环线程上调；
- 但触发点有两个跑在线程池里：routes/admin.py 的控制台重置是
  sync def 端点，routes/auth.py 的改密事务和 security/tokens.py 的
  清扫写库都走 asyncio.to_thread；
- 所以 publish() 做成线程安全入口：subscribe 时记下主循环（单
  worker，事件循环只有一个），publish 用 loop.call_soon_threadsafe
  把「入队」这个动作丢回主循环线程执行。任何线程（包括主循环
  自己）调 publish 都安全，而且永不阻塞发布者。

取舍（本批拍板）：主动退出登录不推送。退出是用户自己的动作，发起
退出的页面自己知道；其它标签页仍旧靠下一次请求吃 401 发现。设计稿
（docs/ACCOUNT_MANAGEMENT.md「会话状态通道」）原打算退出也推一帧，
跨标签页互知的需求留给后续批次再议。
"""

import asyncio
import logging
from collections.abc import Callable
from contextlib import suppress
from uuid import UUID

logger = logging.getLogger("server.pushbus")

# 状态帧里的 reason 词表，与三个触发点一一对应。expired 与会话类 401
# 的 reason（errors.REASON_EXPIRED）同词：同一个意思（令牌死了），
# 前端可以把两套词表当一套处理。disabled（账号被停用）暂不在列——
# account.disabled 列还没建，后端发不出这个值（docs/ACCOUNT_MANAGEMENT.md
# 「数据库要加的」）。
REASON_EXPIRED = "expired"
REASON_PASSWORD_CHANGED = "password_changed"
REASON_ADMIN_RESET = "admin_reset"

# 订阅队列的容量上限。满了丢新帧并记 debug（N5 设计稿骨架同款取舍）：
# 这个通道传的是状态，丢一帧不致命——页面下一次请求吃 401 仍是兜底。
_QUEUE_MAXSIZE = 32

# 关闭哨兵：shutdown() 给所有队列投它，SSE 生成器收到就正常收尾。
_SHUTDOWN: None = None

# 账号 id → 订阅队列。值用不可变元组，增删时整体替换（copy-on-write）：
# publish 在 worker 线程上调也只做一次原子的 .get() 读，拿到的元组不会
# 被主循环线程改到一半，迭代它不需要锁。前提是 subscribe/unsubscribe/
# shutdown 只在事件循环线程上跑（分别由 async 端点的生成器和 lifespan
# 调用），读-改-写不会和自己交错——事件循环是单线程的。
_subscribers: dict[UUID, tuple[asyncio.Queue[dict | None], ...]] = {}

# subscribe 记下的事件循环：publish 靠它把入队动作丢回主循环线程。
_loop: asyncio.AbstractEventLoop | None = None


def subscribe(
    account_id: UUID,
) -> tuple[asyncio.Queue[dict | None], Callable[[], None]]:
    """登记一个订阅：返回（队列，退订函数）。必须在事件循环线程上调。

    退订函数幂等（重复调用无害）；调用方要负责在 finally 里调它，
    不然队列会越攒越多（设计稿点名要 try/finally）。
    """
    global _loop
    _loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
    _subscribers[account_id] = (*_subscribers.get(account_id, ()), queue)

    def unsubscribe() -> None:
        remaining = tuple(
            item for item in _subscribers.get(account_id, ()) if item is not queue
        )
        if remaining:
            _subscribers[account_id] = remaining
        else:
            _subscribers.pop(account_id, None)

    return queue, unsubscribe


def publish(account_id: UUID, event: dict) -> None:
    """给这个账号的所有订阅者发一个事件。任何线程可调，永不阻塞。

    event 是业务载荷原样（现在都是 {"reason": 词表词}），帧的信封
    （valid、message）由 routes/events.py 包。别把 None 当载荷——
    它是关闭哨兵，订阅端会把 None 当「服务关停」处理。没有订阅者
    时直接返回：没人听就什么都不做。
    """
    if not _subscribers.get(account_id):
        return
    loop = _loop
    if loop is None:  # 有订阅者必有循环，这行纯防御
        return
    try:
        loop.call_soon_threadsafe(_deliver, account_id, event)
    except RuntimeError:
        # 循环已关闭：publish 撞上了关停窗口。丢掉这一帧——服务正在
        # 下线，订阅者已经收到（或马上会收到）关闭哨兵。
        logger.debug("推送总线已停止，丢弃 %s 的事件", account_id)


def _deliver(account_id: UUID, event: dict) -> None:
    """真正的入队动作。在事件循环线程上跑（publish 丢回来的）。"""
    for queue in _subscribers.get(account_id, ()):
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            # 慢消费者：丢新帧、记 debug，不挤最旧的也不重试（取舍见
            # _QUEUE_MAXSIZE 的注释）。
            logger.debug("%s 的订阅队列已满，丢弃一帧推送", account_id)


def shutdown() -> None:
    """关停总线：给所有队列投关闭哨兵、清空登记。lifespan 收尾时调。

    订阅者收到哨兵就正常收尾：SSE 流结束，浏览器的 EventSource 会
    自动重连，彼时服务正在关停，重连也连不上，页面按断网处理。
    哨兵必须投得进去：队列满了就挤掉最旧的一帧腾位。
    """
    global _loop
    for queues in _subscribers.values():
        for queue in queues:
            _put_sentinel(queue)
    _subscribers.clear()
    _loop = None


def _put_sentinel(queue: asyncio.Queue[dict | None]) -> None:
    """队列满也要把哨兵投进去：挤掉最旧的一帧腾位。

    shutdown 和 _deliver 都只在事件循环线程上跑、中间没有 await，
    挤掉一帧之后不会再被填满；下面两个 suppress 是纯防御，理论上
    走不到。
    """
    try:
        queue.put_nowait(_SHUTDOWN)
    except asyncio.QueueFull:
        with suppress(asyncio.QueueEmpty):
            queue.get_nowait()
        with suppress(asyncio.QueueFull):
            queue.put_nowait(_SHUTDOWN)
