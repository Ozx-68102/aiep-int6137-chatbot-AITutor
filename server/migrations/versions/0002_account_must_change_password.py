"""给 account 加 must_change_password 列。

预设账号（test01、控制台 admin）和控制台「重置密码」生成的密码都是
系统给的，拿到手的人必须改掉才能继续用：标记由中间件在聊天侧强制
（middleware.py 的 RefreshLoginCookie），修改密码成功才清掉。存量行一律
填 false——老账号的密码是自己设过的，不该被追溯锁住。

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-06
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # IF NOT EXISTS：create_all 引导出来的新数据库已经有这一列，两条路谁先跑
    # 都不冲突（规矩见 server/AGENTS.md 的「迁移」一节）。
    op.execute(
        "ALTER TABLE account ADD COLUMN IF NOT EXISTS must_change_password "
        "boolean NOT NULL DEFAULT false"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE account DROP COLUMN IF EXISTS must_change_password")
