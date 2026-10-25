from datetime import datetime
from uuid import UUID

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import FastAPI, HTTPException, status
from psycopg import Connection
from pydantic import BaseModel, Field

from server.database import database_connection

_ADMIN_USERNAME = "admin"
_UNAUTHORIZED = "用户名或密码不正确"


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1)


class SessionItem(BaseModel):
    id: UUID
    title: str | None
    title_locale: str | None
    created_at: datetime


class LoginResponse(BaseModel):
    locale: str
    sessions: list[SessionItem]


app = FastAPI()


@app.post("/api/login")
def login(body: LoginRequest) -> LoginResponse:
    # TODO: 现在只允许用户名 admin 登录。
    # 以后改为按 account 表里的用户名查找并核对密码，不要写死这一个账号。
    if body.username != _ADMIN_USERNAME:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    with database_connection() as connection:
        return _login_admin(connection, body.password)


def _login_admin(connection: Connection, password: str) -> LoginResponse:
    row = connection.execute(
        """
        SELECT id, password_hash
        FROM account
        WHERE username = %s
        """,
        (_ADMIN_USERNAME,),
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    account_id, password_hash = row
    hasher = PasswordHasher()
    if not _password_matches(hasher, password_hash, password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED)

    if hasher.check_needs_rehash(password_hash):
        connection.execute(
            """
            UPDATE account
            SET password_hash = %s
            WHERE id = %s
            """,
            (hasher.hash(password), account_id),
        )

    locale_row = connection.execute(
        """
        SELECT locale
        FROM language_setting
        WHERE account_id = %s
        """,
        (account_id,),
    ).fetchone()
    if locale_row is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "账号没有语言设置")

    session_rows = connection.execute(
        """
        SELECT id, title, title_locale, created_at
        FROM session
        WHERE account_id = %s
        ORDER BY created_at
        """,
        (account_id,),
    ).fetchall()
    sessions = [
        SessionItem(
            id=session_id,
            title=title,
            title_locale=title_locale,
            created_at=created_at,
        )
        for session_id, title, title_locale, created_at in session_rows
    ]
    return LoginResponse(locale=locale_row[0], sessions=sessions)


def _password_matches(hasher: PasswordHasher, stored_hash: str, password: str) -> bool:
    try:
        hasher.verify(stored_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
    return True
