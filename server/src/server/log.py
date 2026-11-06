import contextvars
import logging
import traceback
from datetime import datetime
from pathlib import Path

from uvicorn.logging import DefaultFormatter

_FORMAT = "%(asctime)s %(levelname)s %(name)s [turn %(turn_id)s] %(message)s"
_STREAM_FORMAT = "%(levelprefix)s %(message)s"
_LOG_PATH = Path(__file__).resolve().parents[3] / "logs" / "server.log"
_MAX_BYTES = 5 * 1024 * 1024
# 归档堆积的警告阈值：数量或总大小任一超标就提醒（维护者要调阈值改这里）。
# 归档只增不删是定下的决定，这里只报警，不动文件。
_ARCHIVE_WARN_COUNT = 20
_ARCHIVE_WARN_BYTES = 500 * 1024 * 1024
_FILE_HANDLER: logging.FileHandler | None = None

# 当前在处理哪一轮：对话和停止端点的入口处设置。asyncio 建后台任务时会
# 拷贝上下文，收尾任务的日志行自动带上；请求上下文之外的行输出 "-"。
_TURN_ID: contextvars.ContextVar[str] = contextvars.ContextVar("turn_id", default="")


def set_turn_context(turn_id: str) -> None:
    """标记这个请求上下文里接下来的日志属于哪一轮。"""
    _TURN_ID.set(turn_id)


class _TurnFilter(logging.Filter):
    """把上下文里的轮次编号注进每条日志，供 _FORMAT 的 %(turn_id)s 用。"""

    def filter(self, record: logging.LogRecord) -> bool:
        record.turn_id = _TURN_ID.get() or "-"
        return True


class _SizeLogFile(logging.FileHandler):
    def __init__(self, path: Path, max_bytes: int) -> None:
        self._max_bytes = max_bytes
        super().__init__(path, encoding="utf-8")

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if self._should_rotate(record):
                self._rotate()
            super().emit(record)
        except Exception as error:
            if logging.raiseExceptions:
                traceback.print_exception(error)

    def _should_rotate(self, record: logging.LogRecord) -> bool:
        stream = self.stream
        if stream is None:
            stream = self._open()
            self.stream = stream
        message = f"{self.format(record)}\n".encode()
        stream.seek(0, 2)
        return stream.tell() + len(message) >= self._max_bytes

    def _rotate(self) -> None:
        if self.stream is not None:
            self.stream.close()
            self.stream = None

        source = Path(self.baseFilename)
        if source.exists():
            source.rename(_archive_path(source))
        self.stream = self._open()
        _warn_if_archives_pile_up(source.parent)


def configure_logging() -> None:
    logging.getLogger("server").setLevel(logging.INFO)
    # root 的级别放开，httpx2 这类第三方日志也能写进文件。
    root = logging.getLogger()
    if root.level > logging.INFO:
        root.setLevel(logging.INFO)

    handler = _file_handler()
    _attach(logging.getLogger(), handler)
    _attach(logging.getLogger("uvicorn"), handler)
    _attach(logging.getLogger("uvicorn.access"), handler)
    # 终端用 uvicorn 的排版和颜色，自己的日志混进去也不会打乱格式。
    _attach(logging.getLogger(), _stream_handler())
    logging.getLogger("server.log").info("日志写入 %s", _LOG_PATH)


def _file_handler() -> logging.FileHandler:
    global _FILE_HANDLER
    if _FILE_HANDLER is not None:
        return _FILE_HANDLER

    _LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    handler = _SizeLogFile(_LOG_PATH, _MAX_BYTES)
    handler.setFormatter(logging.Formatter(_FORMAT))
    handler.addFilter(_TurnFilter())
    _FILE_HANDLER = handler
    return handler


def _stream_handler() -> logging.StreamHandler:
    handler = logging.StreamHandler()
    handler.setFormatter(DefaultFormatter(fmt=_STREAM_FORMAT))
    handler.addFilter(_TurnFilter())
    return handler


def _attach(logger: logging.Logger, handler: logging.Handler) -> None:
    if handler in logger.handlers:
        return
    logger.addHandler(handler)


def _warn_if_archives_pile_up(log_dir: Path) -> None:
    """轮转完成后数一下归档，堆太多了提醒人工处理。

    只在轮转时跑，频率很低；归档目录文件不多，listdir 加 stat 的开销
    可以接受，不算昂贵遍历。
    """
    # 归档命名是 server-<时间戳>.log（见 _archive_path），当前日志
    # server.log 不匹配这个模式，不会数进去。
    archives = list(log_dir.glob("server-*.log"))
    total_bytes = sum(item.stat().st_size for item in archives)
    if len(archives) > _ARCHIVE_WARN_COUNT or total_bytes > _ARCHIVE_WARN_BYTES:
        logging.getLogger("server.log").warning(
            "日志归档已堆积：%d 个、共 %.1f MB；无自动清理策略，请人工处理",
            len(archives),
            total_bytes / (1024 * 1024),
        )


def _archive_path(source: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    candidate = source.with_name(f"server-{stamp}.log")
    index = 2
    while candidate.exists():
        candidate = source.with_name(f"server-{stamp}-{index}.log")
        index += 1
    return candidate
