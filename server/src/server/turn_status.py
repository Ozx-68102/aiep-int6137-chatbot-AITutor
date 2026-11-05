"""一轮的状态词表：唯一的所有者。

数据库 message.status、Redis 的 :status 键、turn_summary 的 outcome 和
done_status、流里 done 帧的 status，说的都是这四个词，一律从这里读。
早先 reply_store（写完用 finished）和 chat_log（写完用 completed）各有一套，
app.py 里两套并排 import（原 docs/CHAT_STREAM_KNOWN_ISSUES.md 第 2 条，
该文档已退役，现状见 docs/CHAT_STREAM_PROTOCOL.md「状态词表」一节）。

Redis 的线上值是唯一例外：「写完了」历来写的是 "finished"，滚动部署时
新旧进程会交错读写，线上值保持不变——reply_store 在自己的边界上做一次
映射（线上值 <-> 本模块词表），"finished" 这个词不出 reply_store。
"""

from typing import Literal

STREAMING: Literal["streaming"] = "streaming"
COMPLETED: Literal["completed"] = "completed"
FAILED: Literal["failed"] = "failed"
ABORTED: Literal["aborted"] = "aborted"

# 类型别名：函数签名和模型字段用它们标注，状态词不再退化成裸 str。
# DoneStatus 不含 streaming：done 帧只在轮次落定时发。
TurnStatus = Literal["streaming", "completed", "failed", "aborted"]
DoneStatus = Literal["completed", "failed", "aborted"]
DoneReason = Literal["stop", "upstream", "internal"]
