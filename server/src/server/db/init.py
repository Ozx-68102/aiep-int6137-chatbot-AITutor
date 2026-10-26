from uuid import uuid4

from argon2 import PasswordHasher
from sqlalchemy import Engine, inspect, select, text
from sqlalchemy.orm import Session

from server.db import Account, Base, LanguageSetting, db_session, get_engine

_INITIAL_USERNAME = "admin"
_INITIAL_PASSWORD = "admin"
_INITIAL_LOCALE = "zh-CN"


def init_db() -> None:
    engine = get_engine()
    Base.metadata.create_all(engine)
    _ensure_pinned_column(engine)
    _ensure_pinned_at_column(engine)
    _ensure_login_token_expiry(engine)
    with db_session() as session:
        _ensure_admin(session)


def _ensure_pinned_column(engine: Engine) -> None:
    columns = {column["name"] for column in inspect(engine).get_columns("session")}
    if "pinned" in columns:
        return
    with engine.begin() as connection:
        connection.execute(text(
            "ALTER TABLE session ADD COLUMN pinned boolean NOT NULL DEFAULT false"
        ))


def _ensure_pinned_at_column(engine: Engine) -> None:
    columns = {column["name"] for column in inspect(engine).get_columns("session")}
    if "pinned_at" in columns:
        return
    with engine.begin() as connection:
        connection.execute(text(
            "ALTER TABLE session ADD COLUMN pinned_at timestamp with time zone"
        ))


def _ensure_login_token_expiry(engine: Engine) -> None:
    columns = {column["name"] for column in inspect(engine).get_columns("login_token")}
    if "expires_at" in columns:
        return
    with engine.begin() as connection:
        connection.execute(text(
            "ALTER TABLE login_token ADD COLUMN expires_at timestamp with time zone"
        ))
        connection.execute(text(
            "UPDATE login_token SET expires_at = created_at + interval '7 days' "
            "WHERE expires_at IS NULL"
        ))
        connection.execute(text(
            "ALTER TABLE login_token ALTER COLUMN expires_at SET NOT NULL"
        ))


def _ensure_admin(session: Session) -> None:
    statement = select(Account).where(Account.username == _INITIAL_USERNAME)
    existing = session.scalar(statement)
    if existing is not None:
        return

    session.add(
        Account(
            id=uuid4(),
            username=_INITIAL_USERNAME,
            password_hash=PasswordHasher().hash(_INITIAL_PASSWORD),
            language_setting=LanguageSetting(locale=_INITIAL_LOCALE),
        ),
    )


if __name__ == "__main__":
    init_db()
