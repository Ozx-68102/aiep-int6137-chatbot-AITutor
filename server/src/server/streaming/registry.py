import asyncio
from uuid import UUID

running: dict[UUID, set[asyncio.Task[None]]] = {}
# 每一轮落定以后写库的任务。单独放着：写库不能被那一轮的取消带跑。
settle_tasks: set[asyncio.Task[None]] = set()


def forget(chat_id: UUID, task: asyncio.Task[None]) -> None:
    tasks = running.get(chat_id)
    if tasks is None:
        return
    tasks.discard(task)
    if not tasks:
        del running[chat_id]
