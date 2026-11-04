"""Alembic 环境：复用应用自己的配置和模型。

数据库 URL 不另配一份，也不复制任何密钥逻辑：直接用
server.db.session.get_engine() 建出来的引擎（它从根目录 .env 读配置，
见 server/src/server/settings.py）。target_metadata 指向
server.db.models 的 Base.metadata，表结构以模型为准。
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import Engine

from server.db import Base
from server.db.session import get_engine

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """离线模式：只生成 SQL 脚本，不连数据库。"""
    context.configure(
        url=get_engine().url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """在线模式：用和应用同一个来源的引擎跑迁移。"""
    connectable: Engine = get_engine()

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
