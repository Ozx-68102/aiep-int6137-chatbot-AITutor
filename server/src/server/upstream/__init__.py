"""server.upstream 的公开面：上游客户端相关的名字都从这里导入。

原 server.upstream 模块的导出（set_client、require_client、optional_client、
shutdown）一个不少；原 server.fastgpt 的公开名字（FastGPT、FastGPTError、
ChatRecord 等）也从这里导出，导入方只换路径、不换名字。
"""

from server.upstream.client import (
    FastGPT,
    open_fastgpt,
    optional_client,
    require_client,
    set_client,
    shutdown,
)
from server.upstream.parsing import (
    STREAM_DONE,
    ChatRecord,
    ChatRecordPage,
    FastGPTError,
    ProgressEvent,
    StreamDone,
)

__all__ = [
    "STREAM_DONE",
    "ChatRecord",
    "ChatRecordPage",
    "FastGPT",
    "FastGPTError",
    "ProgressEvent",
    "StreamDone",
    "open_fastgpt",
    "optional_client",
    "require_client",
    "set_client",
    "shutdown",
]
