import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from uuid import UUID

from redis import Redis
from redis.backoff import NoBackoff
from redis.exceptions import RedisError
from redis.retry import Retry

from server.settings import load_settings

logger = logging.getLogger("server.reply_store")

_STREAMING = "streaming"
_FINISHED = "finished"
_FAILED = "failed"
_ABORTED = "aborted"

_client: Redis | None = None


@dataclass(frozen=True)
class PartialReply:
    status: str | None
    text: str


@contextmanager
def _tolerate(operation: str, chat_id: UUID) -> Iterator[None]:
    """半截文字是可选的，Redis 写不通就记一条警告，不能把聊天整个弄挂。"""
    try:
        yield
    except RedisError:
        logger.warning("Redis 写入失败 %s %s", operation, chat_id, exc_info=True)


def begin_reply(chat_id: UUID) -> None:
    with _tolerate("begin_reply", chat_id):
        ttl = load_settings().redis_key_ttl_seconds
        pipe = _redis().pipeline(transaction=False)
        pipe.set(_status_key(chat_id), _STREAMING, ex=ttl)
        pipe.delete(_text_key(chat_id))
        pipe.execute()


def discard_reply(chat_id: UUID) -> None:
    with _tolerate("discard_reply", chat_id):
        _redis().delete(_status_key(chat_id), _text_key(chat_id))


def append_chunk(chat_id: UUID, text: str) -> None:
    if text == "":
        return

    with _tolerate("append_chunk", chat_id):
        ttl = load_settings().redis_key_ttl_seconds
        pipe = _redis().pipeline(transaction=False)
        pipe.set(_status_key(chat_id), _STREAMING, ex=ttl)
        pipe.append(_text_key(chat_id), text)
        pipe.expire(_text_key(chat_id), ttl)
        pipe.execute()


def mark_finished(chat_id: UUID) -> None:
    with _tolerate("mark_finished", chat_id):
        ttl = load_settings().redis_key_ttl_seconds
        pipe = _redis().pipeline(transaction=False)
        pipe.set(_status_key(chat_id), _FINISHED, ex=ttl)
        pipe.expire(_text_key(chat_id), ttl)
        pipe.execute()


def mark_failed(chat_id: UUID) -> None:
    with _tolerate("mark_failed", chat_id):
        ttl = load_settings().redis_key_ttl_seconds
        pipe = _redis().pipeline(transaction=False)
        pipe.set(_status_key(chat_id), _FAILED, ex=ttl)
        pipe.expire(_text_key(chat_id), ttl)
        pipe.execute()


def mark_aborted(chat_id: UUID) -> None:
    """用户按了停止。已经写出来的文字留着，状态改成 aborted。"""
    with _tolerate("mark_aborted", chat_id):
        ttl = load_settings().redis_key_ttl_seconds
        pipe = _redis().pipeline(transaction=False)
        pipe.set(_status_key(chat_id), _ABORTED, ex=ttl)
        pipe.expire(_text_key(chat_id), ttl)
        pipe.execute()


def store_available() -> bool:
    try:
        return bool(_redis().ping())
    except RedisError:
        return False


def read_partial(chat_id: UUID) -> PartialReply:
    """读不通就照旧报错：页面要靠这个分清「服务器没这一轮」和「问不到服务器」。"""
    raw_status, raw_text = _redis().mget(_status_key(chat_id), _text_key(chat_id))
    status = _as_text(raw_status)
    text = _as_text(raw_text)
    if status is None:
        return PartialReply(status=None, text="")

    if text is None:
        text = ""

    return PartialReply(status=status, text=text)


def _as_text(value: object) -> str | None:
    if isinstance(value, str):
        return value

    if isinstance(value, bytes):
        return value.decode()

    return None


def _redis() -> Redis:
    global _client
    if _client is not None:
        return _client

    settings = load_settings()
    _client = Redis(
        host=settings.redis_host,
        port=settings.redis_port,
        username=settings.redis_user,
        password=settings.redis_password.get_secret_value(),
        decode_responses=True,
        # Redis 不通时要马上知道。默认的连接重试会让一次失败的写入等好几秒，
        # 半截文字是可选的，不能让它把聊天卡住。
        socket_connect_timeout=2.0,
        socket_timeout=2.0,
        retry=Retry(NoBackoff(), 0),
    )
    return _client  # type: ignore


def _status_key(chat_id: UUID) -> str:
    return f"h2botapp-chat:{chat_id}:status"


def _text_key(chat_id: UUID) -> str:
    return f"h2botapp-chat:{chat_id}:text"
