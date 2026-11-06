import json

from server.fastgpt import ProgressEvent
from server.turn_status import DoneReason, DoneStatus
from server.types import TurnDoneEvent

# SSE 的公共响应头：no-store 不让任何一层缓存这条流；X-Accel-Buffering: no
# 叫 nginx 这类反向代理别攒响应正文——攒住的话帧要等缓冲满才发得出去，
# 静默期里页面连心跳都收不到。
SSE_HEADERS = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
# 收尾帧：和上游 FastGPT 的 [DONE] 一字不差，格式永不动。
# 结局帧（event: done）在它之前发出；失败/被停的路径没有这一帧。
DONE_FRAME = "data: [DONE]\n\n"


def progress_chunk(event: ProgressEvent) -> str:
    """跟前端钉死的进度帧：event: progress + {"name","status"}。

    name/status 原样转发，不做映射（2026-11-05 维护者决定：节点名原样
    显示）。前端解析器只认 data: 行，event: 行是给命名事件消费方的。
    """
    payload = json.dumps(
        {"name": event.name, "status": event.status},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"event: progress\ndata: {payload}\n\n"


def done_chunk(
    turn_id: str, outcome: DoneStatus, reason: DoneReason | None, bytes_sent: int
) -> str:
    """跟前端钉死的结局帧：event: done + TurnDoneEvent JSON。

    与进度帧同款风格：命名事件、紧凑分隔符、ensure_ascii=False。
    老前端的解析器把未知命名事件的 data 整帧忽略，加这一帧不破坏
    旧行为（2026-11-05 维护者决定：流里引入命名事件）。
    """
    event = TurnDoneEvent(
        turn_id=turn_id,
        status=outcome,
        reason=reason,
        bytes_sent=bytes_sent,
    )
    return f"event: done\ndata: {event.model_dump_json()}\n\n"


def chunk(content: str) -> str:
    payload = json.dumps(
        {"choices": [{"delta": {"content": content}}]},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"data: {payload}\n\n"
