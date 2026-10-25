from uuid import uuid4

from argon2 import PasswordHasher
from psycopg import Connection

from server.database import database_connection

_LOCALES = "'zh-CN', 'zh-TW', 'en'"
_INITIAL_USERNAME = "admin"
_INITIAL_PASSWORD = "admin"
_INITIAL_LOCALE = "zh-CN"


def init_db() -> None:
    with database_connection() as connection:
        _create_tables(connection)
        _ensure_admin(connection)


def _create_tables(connection: Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS account (
            id uuid PRIMARY KEY,
            username varchar(64) NOT NULL UNIQUE,
            password_hash varchar(255) NOT NULL
        )
        """,
    )
    connection.execute(
        f"""
        CREATE TABLE IF NOT EXISTS language_setting (
            account_id uuid PRIMARY KEY REFERENCES account (id),
            locale varchar(5) NOT NULL,
            CONSTRAINT language_setting_locale_check
                CHECK (locale IN ({_LOCALES}))
        )
        """,
    )
    connection.execute(
        f"""
        CREATE TABLE IF NOT EXISTS session (
            id uuid PRIMARY KEY,
            account_id uuid NOT NULL REFERENCES account (id),
            title varchar(500),
            title_locale varchar(5),
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT session_title_locale_check
                CHECK (title_locale IS NULL OR title_locale IN ({_LOCALES}))
        )
        """,
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS session_account_id_created_at_idx
            ON session (account_id, created_at)
        """,
    )


def _ensure_admin(connection: Connection) -> None:
    existing = connection.execute(
        "SELECT id FROM account WHERE username = %s",
        (_INITIAL_USERNAME,),
    ).fetchone()
    if existing is not None:
        return

    account_id = uuid4()
    password_hash = PasswordHasher().hash(_INITIAL_PASSWORD)
    connection.execute(
        """
        INSERT INTO account (id, username, password_hash)
        VALUES (%s, %s, %s)
        """,
        (account_id, _INITIAL_USERNAME, password_hash),
    )
    connection.execute(
        """
        INSERT INTO language_setting (account_id, locale)
        VALUES (%s, %s)
        """,
        (account_id, _INITIAL_LOCALE),
    )


if __name__ == "__main__":
    init_db()
