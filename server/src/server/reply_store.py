import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from uuid import UUID

# redis.asyncio 的异常和同步客户端同在 redis.exceptions 这个模块里，
# RedisError 照旧是基类，except 写法不变。
from redis.exceptions import RedisError

from server.infra.redis_client import get_redis
from server.settings import load_settings
from server.turn_status import ABORTED, COMPLETED, FAILED, STREAMING

logger = logging.getLogger("server.reply_store")

# 状态词表归 turn_status.py 独家所有。Redis 的线上值是唯一例外：
# 「写完了」历来写 "finished"，滚动部署时新旧进程交错读写也不错位。
# 映射只发生在本模块的边界上（见 turn_status.py 的 docstring）。
_REDIS_FINISHED = "finished"

_STOP_TTL_SECONDS = 60


@dataclass(frozen=True)
class PartialReply:
    status: str | None
    text: str
    turn_id: str | None
    question: str | None


@asynccontextmanager
async def _tolerate(operation: str, chat_id: UUID) -> AsyncIterator[None]:
    """半截文字是可选的，Redis 写不通就记一条警告，不能把聊天整个弄挂。"""
    try:
        yield
    except RedisError:
        logger.warning("Redis 写入失败 %s %s", operation, chat_id, exc_info=True)


# 「检查＋占用」合成一步：SET … GET（Redis 6.2 起支持，写入新值的同时
# 原子拿回旧值）。为什么不用 Lua 脚本：生产环境 Redis 用户的 ACL 不放行
# 脚本命令，evalsha/eval 都收到 NoPermissionError（2026-11-06 真实环境实测），
# 脚本失败一降级，单轮守卫就整个消失。为什么不用 SET NX：NX 只能表达
# 「键不在才抢得到」，而上一轮结束之后状态键还会活到 TTL 到期——正常
# 接着提问会永远 NX 失败；NX 失败再退回「先读后覆盖」，又回到
# check-then-act 有缝的老路。set 命令在 ACL 的放行范围内（真实环境验证）。
async def claim_round(chat_id: UUID, turn_id: str, question: str) -> bool:
    """原子抢占这一轮：没有别的轮在写时，一步完成登记。

    True = 抢到了：状态已在占用检查动作里置成 streaming，轮次键（编号＋
    提问）写好、上一轮的半截文字删掉，TTL 规矩和原来的 begin_reply
    一致。False = 这场会话已经有一轮在写，调用方按既有语义回 409；
    没抢到的一方也会把状态键写成同样的 streaming 值（TTL 顺延），
    无副作用。

    Redis 不通时按抢占成功放行——和 round_in_flight「读不到按没有在
    写」同一套降级原则：半截回复是可选加固，Redis 挂了聊天照常，
    大不了失去单轮保护。
    """
    ttl = load_settings().redis_key_ttl_seconds
    try:
        previous = await get_redis().set(
            _status_key(chat_id), STREAMING, ex=ttl, get=True
        )
    except RedisError:
        logger.warning(
            "Redis 没法原子抢占 %s 的轮次，按抢到放行",
            chat_id,
            exc_info=True,
        )
        return True
    if previous == STREAMING:
        return False
    # 占用检查通过，补齐剩下的登记。这一步写失败不回退占用检查：这一轮照常
    # 进行，只是断线后的恢复和半截文字降级（与 _tolerate 同方向）。
    try:
        pipe = get_redis().pipeline(transaction=False)
        pipe.set(_turn_key(chat_id), _turn_value(turn_id, question), ex=ttl)
        pipe.delete(_text_key(chat_id))
        await pipe.execute()
    except RedisError:
        logger.warning(
            "Redis 轮次登记写入失败 %s，这一轮照常进行",
            chat_id,
            exc_info=True,
        )
    return True


async def discard_reply(chat_id: UUID) -> None:
    """这一轮根本没开始（上游还没接上），登记的信息也一并清掉。"""
    async with _tolerate("discard_reply", chat_id):
        await get_redis().delete(
            _status_key(chat_id), _text_key(chat_id), _turn_key(chat_id)
        )


async def append_chunk(chat_id: UUID, text: str) -> None:
    if text == "":
        return

    async with _tolerate("append_chunk", chat_id):
        ttl = load_settings().redis_key_ttl_seconds
        pipe = get_redis().pipeline(transaction=False)
        pipe.set(_status_key(chat_id), STREAMING, ex=ttl)
        pipe.append(_text_key(chat_id), text)
        pipe.expire(_text_key(chat_id), ttl)
        await pipe.execute()


async def _mark(chat_id: UUID, value: str) -> None:
    """把状态词写成 value，顺手给文字和轮次键续期。"""
    ttl = load_settings().redis_key_ttl_seconds
    pipe = get_redis().pipeline(transaction=False)
    pipe.set(_status_key(chat_id), value, ex=ttl)
    pipe.expire(_text_key(chat_id), ttl)
    pipe.expire(_turn_key(chat_id), ttl)
    await pipe.execute()


async def mark_finished(chat_id: UUID) -> None:
    async with _tolerate("mark_finished", chat_id):
        await _mark(chat_id, _REDIS_FINISHED)


async def mark_failed(chat_id: UUID) -> None:
    async with _tolerate("mark_failed", chat_id):
        await _mark(chat_id, FAILED)


async def mark_aborted(chat_id: UUID) -> None:
    """用户按了停止。已经写出来的文字留着，状态改成 aborted。"""
    async with _tolerate("mark_aborted", chat_id):
        await _mark(chat_id, ABORTED)


async def store_available() -> bool:
    try:
        return bool(await get_redis().ping())
    except RedisError:
        return False


async def read_partial(chat_id: UUID) -> PartialReply:
    """读不通就照旧报错：页面要靠这个分清「服务器没这一轮」和「问不到服务器」。"""
    raw_status, raw_text, raw_turn = await get_redis().mget(
        _status_key(chat_id), _text_key(chat_id), _turn_key(chat_id)
    )
    status = _as_text(raw_status)
    if status == _REDIS_FINISHED:
        # 线上值 -> 统一词表：读出来就映射，此后进程内只认 completed。
        status = COMPLETED
    text = _as_text(raw_text)
    turn_id, question = _turn_parts(raw_turn)
    if status is None:
        return PartialReply(status=None, text="", turn_id=turn_id, question=question)

    if text is None:
        text = ""

    return PartialReply(status=status, text=text, turn_id=turn_id, question=question)


async def round_in_flight(chat_id: UUID) -> bool:
    """这场会话是不是已经有一轮在写。Redis 不通就当没有，聊天照常走。"""
    try:
        return (await read_partial(chat_id)).status == STREAMING
    except RedisError:
        logger.warning("Redis 读不到 %s 的状态，按没有在写处理", chat_id, exc_info=True)
        return False


async def request_stop(chat_id: UUID, turn_id: str) -> None:
    """用户按了停止。

    记下这一轮的编号：即使这一轮还没开始（停止请求先到），后到的对话请求看到
    编号对得上，就不再开这一轮。先到后到都不影响结果。
    """
    if turn_id == "":
        return

    async with _tolerate("request_stop", chat_id):
        await get_redis().set(_stop_key(chat_id), turn_id, ex=_STOP_TTL_SECONDS)


async def stop_requested(chat_id: UUID, turn_id: str) -> bool:
    """这一轮是不是已经被要求停下了。Redis 不通就当没有，聊天照常走。"""
    if turn_id == "":
        return False

    try:
        value = await get_redis().get(_stop_key(chat_id))
    except RedisError:
        logger.warning(
            "Redis 读不到 %s 的停止标记，按没有停处理", chat_id, exc_info=True
        )
        return False

    return value == turn_id


async def current_turn_id(chat_id: UUID) -> str:
    """当前这一轮的编号。读不到就当没有。"""
    try:
        return (await read_partial(chat_id)).turn_id or ""
    except RedisError:
        logger.warning("Redis 读不到 %s 的轮次编号，按没有处理", chat_id, exc_info=True)
        return ""


# 轮次相关键的全部后缀：状态、半截文字、轮次（带提问）、停止标记。
# 跟文件底下的 _*_key 构造函数保持一致；限流计数
# （h2botapp-chat:ratelimit:*）不以这些后缀结尾，下面的清理碰不到它。
_ROUND_KEY_SUFFIXES = (":status", ":text", ":turn", ":stop")


async def clear_leftover_round_keys() -> int:
    """清掉 h2botapp-chat: 前缀下进程上次运行残留的轮次键，返回清了几个。

    只给启动核对（lifespan）用：单进程前提下，进程刚启动时不可能真有
    一轮在写，这些键必是进程上次运行留下的残留——为什么可以无条件清，
    见 lifespan.py 调用处的注释和 docs/CHAT_STREAM_PROTOCOL.md
    「单进程前提」一节。
    用 SCAN 不用 KEYS：KEYS 会把整个 Redis 堵住。Redis 不通就如实
    抛错，调用方接住记警告、不阻止启动（Redis 是可选加固）。
    """
    client = get_redis()
    removed = 0
    for suffix in _ROUND_KEY_SUFFIXES:
        batch: list[str] = []
        async for key in client.scan_iter(match=f"h2botapp-chat:*{suffix}", count=100):
            batch.append(key)
            if len(batch) >= 100:
                removed += await client.delete(*batch)
                batch.clear()
        if batch:
            removed += await client.delete(*batch)
    return removed


def _turn_value(turn_id: str, question: str) -> str:
    return json.dumps({"id": turn_id, "question": question}, ensure_ascii=False)


def _turn_parts(raw: object) -> tuple[str | None, str | None]:
    text = _as_text(raw)
    if text is None:
        return None, None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None, None
    if not isinstance(payload, dict):
        return None, None
    turn_id = payload.get("id")
    question = payload.get("question")
    return (
        turn_id if isinstance(turn_id, str) else None,
        question if isinstance(question, str) else None,
    )


def _as_text(value: object) -> str | None:
    if isinstance(value, str):
        return value

    if isinstance(value, bytes):
        return value.decode()

    return None


def _status_key(chat_id: UUID) -> str:
    return f"h2botapp-chat:{chat_id}:status"


def _text_key(chat_id: UUID) -> str:
    return f"h2botapp-chat:{chat_id}:text"


def _turn_key(chat_id: UUID) -> str:
    return f"h2botapp-chat:{chat_id}:turn"


def _stop_key(chat_id: UUID) -> str:
    return f"h2botapp-chat:{chat_id}:stop"
