"""一站排查一轮聊天的状态：Redis 的半截回复和数据库 message 表并排读出来。

只读工具：不写任何数据，不改任何状态。一轮卡在「还在写」、页面上出现
说不清的失败、或者怀疑两边存的不是一个样子时，先跑一遍它，看看两边
各存了什么、对不对得上。

用法（在 server/ 目录里执行）：

    uv run python -m server.turn_dump <session_id> [turn_id]

- session_id 就是会话 id（对话请求里的 chat_id）。
- turn_id 可选：给了就把 message 表里属于那一轮的行用 >> 标出来。

本机 PostgreSQL 和 Redis 都要在运行。输出带用户提问和回答的首尾各 40 字，
别贴进公开渠道。
"""

import sys
from uuid import UUID

from redis.exceptions import RedisError

from server import chat_log
from server.reply_store import read_partial

_PREVIEW_CHARS = 40
_USAGE = "用法：uv run python -m server.turn_dump <session_id> [turn_id]"


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3):
        print(_USAGE)
        return 2
    try:
        session_id = UUID(argv[1])
    except ValueError:
        print(f"session_id 不是合法的 UUID：{argv[1]}")
        return 2
    turn_id: UUID | None = None
    if len(argv) == 3:
        try:
            turn_id = UUID(argv[2])
        except ValueError:
            print(f"turn_id 不是合法的 UUID：{argv[2]}")
            return 2

    _dump_reply_store(session_id)
    _dump_messages(session_id, turn_id)
    return 0


def _dump_reply_store(session_id: UUID) -> None:
    """Redis 里的半截回复：正在写（或刚落定）那一轮的现场。"""
    print(f"== Redis 半截回复（会话 {session_id}）==")
    try:
        partial = read_partial(session_id)
    except RedisError as error:
        print(f"Redis 读不到：{error}")
        print()
        return
    if partial.status is None:
        print("status: （没有：Redis 里没有这场会话的半截回复）")
    else:
        print(f"status: {partial.status}")
    print(f"turn_id: {partial.turn_id or '-'}")
    print(f"提问长度: {len(partial.question or '')}")
    text = partial.text
    print(f"回答长度: {len(text)}")
    print(f"回答预览: {_preview(text)}")
    print()


def _dump_messages(session_id: UUID, turn_id: UUID | None) -> None:
    """数据库 message 表：我们自己存的那一份正式记录。"""
    print(f"== 数据库 message 表（会话 {session_id}）==")
    rows = chat_log.read_messages(session_id)
    if not rows:
        print("（没有记录：会话不存在、读库失败，或者这张表里还没写过）")
        return
    if turn_id is not None:
        print(f"要找的轮次：{turn_id}，匹配的行用 >> 标出")
    matched = 0
    for row in rows:
        is_target = turn_id is not None and row.turn_id == str(turn_id)
        if is_target:
            matched += 1
        print(
            f"{'>>' if is_target else '  '} "
            f"seq={row.seq} role={row.role} turn_id={row.turn_id} "
            f"status={row.status} chars={len(row.text)}"
        )
    if turn_id is not None and matched == 0:
        print(">> 注意：这一轮在 message 表里没有行（写库失败过，或被重试删掉了）")


def _preview(text: str) -> str:
    """首尾各 40 字；本来就短的整个打出来。"""
    if text == "":
        return "（空）"
    if len(text) <= _PREVIEW_CHARS * 2:
        return text
    return f"{text[:_PREVIEW_CHARS]}…{text[-_PREVIEW_CHARS:]}"


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
