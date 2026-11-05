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
def read_status() -> StatusResponse:
    """页面用它做常驻提示。只报状态，不带任何内容，也不需要登录。"""
    return StatusResponse(
        database="ok" if _database_available() else "unavailable",
        reply_store="ok" if store_available() else "unavailable",
    )


def _database_available() -> bool:
    try:
        with db_session() as session:
            session.execute(select(1))
        return True
    except SQLAlchemyError:
        logger.warning("数据库不可用", exc_info=True)
        return False
