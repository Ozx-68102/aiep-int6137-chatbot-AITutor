import asyncio
from uuid import UUID

running: dict[UUID, set[asyncio.Task[None]]] = {}
# 每一轮结束以后写进数据库的任务。单独放着：写进数据库不能被那一轮的取消带跑。
settle_tasks: set[asyncio.Task[None]] = set()


def forget(chat_id: UUID, task: asyncio.Task[None]) -> None:
    tasks = running.get(chat_id)
    if tasks is None:
        return
    tasks.discard(task)
    if not tasks:
        del running[chat_id]
