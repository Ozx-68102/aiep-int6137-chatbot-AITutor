from dataclasses import dataclass
from uuid import UUID

from redis import Redis

from server.settings import load_settings

_STREAMING = "streaming"
_FINISHED = "finished"
_FAILED = "failed"

_client: Redis | None = None


@dataclass(frozen=True)
class PartialReply:
    status: str | None
    text: str


def begin_reply(chat_id: UUID) -> None:
    ttl = load_settings().redis_key_ttl_seconds
    pipe = _redis().pipeline(transaction=False)
    pipe.set(_status_key(chat_id), _STREAMING, ex=ttl)
    pipe.delete(_text_key(chat_id))
    pipe.execute()


def discard_reply(chat_id: UUID) -> None:
    _redis().delete(_status_key(chat_id), _text_key(chat_id))


def append_chunk(chat_id: UUID, text: str) -> None:
    if text == "":
        return

    ttl = load_settings().redis_key_ttl_seconds
    pipe = _redis().pipeline(transaction=False)
    pipe.set(_status_key(chat_id), _STREAMING, ex=ttl)
    pipe.append(_text_key(chat_id), text)
    pipe.expire(_text_key(chat_id), ttl)
    pipe.execute()


def mark_finished(chat_id: UUID) -> None:
    ttl = load_settings().redis_key_ttl_seconds
    pipe = _redis().pipeline(transaction=False)
    pipe.set(_status_key(chat_id), _FINISHED, ex=ttl)
    pipe.expire(_text_key(chat_id), ttl)
    pipe.execute()


def mark_failed(chat_id: UUID) -> None:
    ttl = load_settings().redis_key_ttl_seconds
    pipe = _redis().pipeline(transaction=False)
    pipe.set(_status_key(chat_id), _FAILED, ex=ttl)
    pipe.expire(_text_key(chat_id), ttl)
    pipe.execute()


def read_partial(chat_id: UUID) -> PartialReply:
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
    )
    return _client  # type: ignore


def _status_key(chat_id: UUID) -> str:
    return f"h2botapp-chat:{chat_id}:status"


def _text_key(chat_id: UUID) -> str:
    return f"h2botapp-chat:{chat_id}:text"
