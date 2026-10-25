from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import URL, Engine, create_engine
from sqlalchemy.orm import Session

from server.settings import Settings

_engine: Engine | None = None


def get_engine(settings: Settings | None = None) -> Engine:
    global _engine
    if _engine is not None:
        return _engine

    # noinspection PyArgumentList
    settings = Settings() if settings is None else settings
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
    )

    return _engine  # type: ignore


@contextmanager
def db_session(settings: Settings | None = None) -> Iterator[Session]:
    with Session(get_engine(settings)) as session:
        yield session
        session.commit()
