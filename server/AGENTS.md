# 后端说明

后端是 `server/` 里的 FastAPI 服务，只听本机 3001 端口。跨项目的规矩见仓库根目录的
[AGENTS.md](../AGENTS.md)；这个文件只写后端特有的事。

## 常用指令
（在 `server/` 里执行）
- `uv sync` — 按 uv.lock 装好依赖（Python 锁 3.13）
- `uv lock --check` — 检查锁文件
- `uv run ruff check .` — 检查
- `uv run ruff format .` — 按 ruff 的规则改格式
- `uv run ruff format --check .` — 只查格式，不改文件
- `uv run server` — 起服务，等价于仓库根目录的 `pnpm run dev:backend`
- `uv run python -m server.db.init` — 只补缺的表和列，建初始账号，不改已有密码。
  不要每次起服务都跑：只在项目维护者下令时，或改了数据库结构之后跑

起服务前，本机 PostgreSQL 和 Redis 必须在运行。
想一次跑完两项检查：在仓库根目录执行 `bash scripts/check-server.sh`。

## 验收
- 改完后端代码：`uv run ruff check .` 和 `uv run ruff format --check .`

## 边界
- FastGPT 的地址、应用 id、变量名、登录方式和接口路径都不臆造，缺了就问
- 密钥只放仓库根目录 `.env`（已忽略），由 `server/src/server/settings.py` 读取。
  不写进代码，也不写进日志
- 日志在仓库根目录的 `logs/server.log`，超过 5MB 会轮转归档。里面写着用户提问和
  FastGPT 的上游原文，不要贴进提交说明、文档或 issue
- 配置模型和接口模型在 `server/src/server/types`

## 登录状态
登录凭据存在名为 `login` 的 cookie 里：cookie 里放的是令牌，数据库的 `login_token` 表存它的哈希。
有效期 7 天，每个带 cookie 的请求都会重新续 7 天。没登录的请求返回 401，响应顺带把这个 cookie 删掉，
所以漏带 cookie 的表现是「莫名其妙被登出」，不是一个好查的报错。
