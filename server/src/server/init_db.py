from uuid import uuid4

from argon2 import PasswordHasher
from sqlalchemy import select
from sqlalchemy.orm import Session

from server.database import db_session, get_engine
from server.models import Account, Base, LanguageSetting

_INITIAL_USERNAME = "admin"
_INITIAL_PASSWORD = "admin"
_INITIAL_LOCALE = "zh-CN"


def init_db() -> None:
    Base.metadata.create_all(get_engine())
    with db_session() as session:
        _ensure_admin(session)


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
