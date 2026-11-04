"""给 login_token.expires_at 建索引。

过期令牌的清扫（DELETE ... WHERE expires_at <= now()）原来挂在每个带
cookie 的请求路径上、走全表扫；现在挪进了后台周期任务（app.py 的
_sweep_expired_tokens_loop）。这条 DELETE 和令牌校验里
expires_at > now() 的条件都吃这个索引（依据见
docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md「令牌表与定时清扫」一节）。

Revision ID: 0001
Revises:
Create Date: 2026-11-05
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_login_token_expires_at "
        "ON login_token (expires_at)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_login_token_expires_at")
