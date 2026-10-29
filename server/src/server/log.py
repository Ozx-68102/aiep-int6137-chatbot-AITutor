import logging
import traceback
from datetime import datetime
from pathlib import Path

from uvicorn.logging import DefaultFormatter

_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
_STREAM_FORMAT = "%(levelprefix)s %(message)s"
_LOG_PATH = Path(__file__).resolve().parents[3] / "logs" / "server.log"
_MAX_BYTES = 5 * 1024 * 1024
_FILE_HANDLER: logging.FileHandler | None = None


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
    _FILE_HANDLER = handler
    return handler


def _stream_handler() -> logging.StreamHandler:
    handler = logging.StreamHandler()
    handler.setFormatter(DefaultFormatter(fmt=_STREAM_FORMAT))
    return handler


def _attach(logger: logging.Logger, handler: logging.Handler) -> None:
    if handler in logger.handlers:
        return
    logger.addHandler(handler)


def _archive_path(source: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    candidate = source.with_name(f"server-{stamp}.log")
    index = 2
    while candidate.exists():
        candidate = source.with_name(f"server-{stamp}-{index}.log")
        index += 1
    return candidate
