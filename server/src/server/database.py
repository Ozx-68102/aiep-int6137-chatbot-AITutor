from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg import Connection

from server.settings import Settings


def connect(settings: Settings | None = None) -> Connection:
    # noinspection PyArgumentList
    settings = Settings() if settings is None else settings

    return psycopg.connect(
        host=settings.database_host,
        port=settings.database_port,
        dbname=settings.database_name,
        user=settings.database_user,
        password=settings.database_password.get_secret_value(),
        connect_timeout=5,
    )


@contextmanager
def database_connection(settings: Settings | None = None) -> Iterator[Connection]:
    with connect(settings) as connection:
        yield connection
