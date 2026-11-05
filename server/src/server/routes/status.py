import asyncio
import logging

from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from server.db import db_session
from server.reply_store import store_available
from server.types import StatusResponse

router = APIRouter()
logger = logging.getLogger("server.routes.status")


@router.get("/api/status")
async def read_status() -> StatusResponse:
    """页面用它做常驻提示。只报状态，不带任何内容，也不需要登录。

    端点改成 async def：store_available 要 await 异步 Redis 客户端，
    如实报告 Redis 可用性；数据库探针仍是同步的（psycopg），照旧
    丢进线程里跑，不堵事件循环。
    """
    database_ok = await asyncio.to_thread(_database_available)
    reply_store_ok = await store_available()
    return StatusResponse(
        database="ok" if database_ok else "unavailable",
        reply_store="ok" if reply_store_ok else "unavailable",
    )


def _database_available() -> bool:
    try:
        with db_session() as session:
            session.execute(select(1))
        return True
    except SQLAlchemyError:
        logger.warning("数据库不可用", exc_info=True)
        return False
