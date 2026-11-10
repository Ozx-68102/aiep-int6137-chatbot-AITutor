"""把上游的历史搬进我们自己的 message 表。

我们有了这张表以后，新写的一轮当场就写进数据库了；表建之前那些老会话的记录
还在 FastGPT 那边。这条命令把它们一次搬过来：

    uv run python -m server.db.backfill

搬完就不用再搬了。已经有记录的那场会话会跳过（不覆盖我们自己的）。
"""

import asyncio
from uuid import UUID

from sqlalchemy import select

from server import chat_log
from server.db import ChatSession, db_session
from server.settings import load_settings
from server.upstream import FastGPT, FastGPTError, open_fastgpt

_PAGE_SIZE = 100


async def main() -> None:
    fastgpt = open_fastgpt(load_settings())
    if fastgpt is None:
        print("FastGPT 配置为空，搬不了")
        return

    try:
        with db_session() as session:
            targets = [item.id for item in session.scalars(select(ChatSession)).all()]

        for session_id in targets:
            # read_messages 的数据库错误如实上抛：搬库命令读不了库就该
            # 报错停下，不能当成「没有记录」继续往下搬。
            existing = chat_log.read_messages(session_id)
            if existing:
                print(f"{session_id}: 已经有 {len(existing)} 条，跳过")
                continue
            records = await _records(session_id, fastgpt)
            if records is None:
                # 失败原因 _records 已经打印过了。
                continue
            if not chat_log.backfill(session_id, chat_log.rounds_from_records(records)):
                print(f"{session_id}: 写库失败，这一场没搬成")
                continue
            print(f"{session_id}: 搬了 {len(records)} 条")
    finally:
        await fastgpt.aclose()


async def _records(session_id: UUID, fastgpt: FastGPT) -> list | None:
    records = []
    offset = 0
    while True:
        try:
            page = await fastgpt.records(session_id, offset, _PAGE_SIZE)
        except FastGPTError as exc:
            # 上游失败如实报出来（异常自带 step、状态码、响应开头）。
            print(f"{session_id}: 读不到上游的记录：{exc}")
            return None
        records.extend(page.records)
        offset += _PAGE_SIZE
        if offset >= page.total:
            return records


if __name__ == "__main__":
    asyncio.run(main())
