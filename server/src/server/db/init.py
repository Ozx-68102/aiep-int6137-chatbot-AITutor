from uuid import uuid4

from argon2 import PasswordHasher
from sqlalchemy import Engine, inspect, select, text
from sqlalchemy.orm import Session

from server.db import Account, Base, LanguageSetting, db_session, get_engine

_INITIAL_USERNAME = "test01"
_INITIAL_PASSWORD = "test01"
_INITIAL_LOCALE = "zh-CN"


def init_db() -> None:
    engine = get_engine()
    Base.metadata.create_all(engine)
    _ensure_pinned_column(engine)
    _ensure_pinned_at_column(engine)
    _ensure_login_token_expiry(engine)
    _ensure_avatar_column(engine)
    _ensure_role_column(engine)
    with db_session() as session:
        _ensure_initial_account(session)


def _ensure_avatar_column(engine: Engine) -> None:
    columns = {column["name"] for column in inspect(engine).get_columns("account")}
    if "avatar" in columns:
        return
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE account ADD COLUMN avatar bytea"))


def _ensure_role_column(engine: Engine) -> None:
    """给 account 补 role 列。

    已有行的 role 一律填 chat：这张表里现在只有聊天账号，控制台的管理员
    账号是后面那批活的事（docs/ACCOUNT_MANAGEMENT.md 的顺序第 4 步）。
    约束单独加：ADD COLUMN 带 CHECK 在 PostgreSQL 里会把整张表扫一遍验，
    拆成两步则新列有默认值、约束只对新写的行生效。
    """
    columns = {column["name"] for column in inspect(engine).get_columns("account")}
    if "role" in columns:
        return
    with engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE account ADD COLUMN role varchar(16) "
                "NOT NULL DEFAULT 'chat'"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE account ADD CONSTRAINT account_role_check "
                "CHECK (role IN ('chat', 'admin'))"
            )
        )


def _ensure_pinned_column(engine: Engine) -> None:
    columns = {column["name"] for column in inspect(engine).get_columns("session")}
    if "pinned" in columns:
        return
    with engine.begin() as connection:
        connection.execute(
            text("ALTER TABLE session ADD COLUMN pinned boolean NOT NULL DEFAULT false")
        )


def _ensure_pinned_at_column(engine: Engine) -> None:
    columns = {column["name"] for column in inspect(engine).get_columns("session")}
    if "pinned_at" in columns:
        return
    with engine.begin() as connection:
        connection.execute(
            text("ALTER TABLE session ADD COLUMN pinned_at timestamp with time zone")
        )


def _ensure_login_token_expiry(engine: Engine) -> None:
    columns = {column["name"] for column in inspect(engine).get_columns("login_token")}
    if "expires_at" in columns:
        return
    with engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE login_token ADD COLUMN expires_at timestamp with time zone"
            )
        )
        connection.execute(
            text(
                "UPDATE login_token SET expires_at = created_at + interval '7 days' "
                "WHERE expires_at IS NULL"
            )
        )
        connection.execute(
            text("ALTER TABLE login_token ALTER COLUMN expires_at SET NOT NULL")
        )


def _ensure_initial_account(session: Session) -> None:
    """建初始的聊天账号（test01/test01）。

    这个账号原来叫 admin，现在 admin 留给控制台的管理员，聊天侧的
    初始账号改叫 test01。这里只认用户名：查得到 test01 就直接返回，
    所以老库改过名之后再跑 init，不会重复建号，也不动已有的密码。
    """
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
