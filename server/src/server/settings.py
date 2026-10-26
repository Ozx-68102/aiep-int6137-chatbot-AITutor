import logging

from pydantic import ValidationError

from server.log import configure_logging
from server.types import Settings, empty_fastgpt_fields

logger = logging.getLogger("server.settings")


def _validation_message(exc: ValidationError) -> str:
    parts: list[str] = []
    for error in exc.errors():
        loc = error["loc"]
        message = str(error["msg"]).removeprefix("Value error, ")
        if loc:
            parts.append(f"{str(loc[0]).upper()}: {message}")
        else:
            parts.append(message)

    return "；".join(parts)


_cached: Settings | None = None


def load_settings() -> Settings:
    global _cached
    if _cached is not None:
        return _cached

    configure_logging()
    try:
        # noinspection PyArgumentList
        settings = Settings()
    except ValidationError as exc:
        message = _validation_message(exc)
        logger.error("配置无效，进程无法启动：%s", message)
        raise RuntimeError(f"配置无效，进程无法启动：{message}") from None

    missing = empty_fastgpt_fields(settings)
    if settings.debug == 1 and missing:
        names = "、".join(missing)
        logger.warning(
            "调试模式已开启，以下 FastGPT 配置为空：%s。"
            "用到这些配置的请求会失败，进程继续运行。",
            names,
        )

    _cached = settings
    return settings
