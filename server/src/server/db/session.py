from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import URL, Engine, create_engine
from sqlalchemy.orm import Session

from server.settings import load_settings
from server.types import Settings

_engine: Engine | None = None


def get_engine(settings: Settings | None = None) -> Engine:
    global _engine
    if _engine is not None:
        return _engine

    settings = load_settings() if settings is None else settings
    _engine = create_engine(
        URL.create(
            drivername="postgresql+psycopg",
            username=settings.database_user,
            password=settings.database_password.get_secret_value(),
            host=settings.database_host,
            port=settings.database_port,
            database=settings.database_name,
        ),
        connect_args={"connect_timeout": 5},
        # 默认的连接池不做存活检查：数据库重启后，池里的旧连接要等第一批请求
        # 碰到才报错。pool_pre_ping 在取连接前先探一下，坏连接自动重建。
        pool_pre_ping=True,
        # 显式写出池子大小（常驻 5 条，高峰可临时超借 10 条），好按负载调。
        pool_size=5,
        max_overflow=10,
    )

    return _engine  # type: ignore


@contextmanager
def db_session(settings: Settings | None = None) -> Iterator[Session]:
    with Session(get_engine(settings)) as session:
        yield session
        session.commit()
