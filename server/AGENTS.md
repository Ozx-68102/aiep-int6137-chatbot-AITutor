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

## FastGPT 的版本基线

FastGPT 是内部部署的，当前基线是 **v4.14.5**（内部可能改过，别当原版用）。

它的接口清单不要照文档站看：

- 文档站 doc.fastgpt.io 的「对话接口」页对应的是更新版本。从 4.15.0 起官方不再手工维护接口说明，
  改成分布在部署地址的 `/apidoc/devapi` 和 `/apidoc/systemopenapi`；这两个地址是 4.15.0 才引入的，
  我们这个部署上都是 404（v4.14.5 的源码里没有 apidoc 相关页面）。
- FastGPT 的接口说明分三层：代码里的 OpenAPI 定义（`packages/global/openapi/**`，每个路由带
  summary 和 description）→ 文档站的手写页（`document/content/docs/**`）→ 部署上的自动清单
  （4.15 以后才有）。「文档没有、源码有」是常态，两边都不是全集。
- 所以要确认某个接口存不存在、地址和参数是什么，直接看官方仓库 tag **v4.14.5** 的源码，
  再用一次实测确认。聊天相关的实现在 `projects/app/src/pages/api/`，
  OpenAPI 定义在 `packages/global/openapi/core/chat/`。

看源码不用克隆整个仓库，取单个文件就行：

```bash
curl -sL https://raw.githubusercontent.com/labring/FastGPT/v4.14.5/<路径>
```

## 边界
- 没有我的明确许可，不要动手实现：我回答你的问题、给你补充信息，都不算许可；只有我明确表示可以动手了，
  才动手。在那之前只做只读的事，不写文件、不改代码、不跑会改动仓库的命令
- 说话用陈述语气，少用问句：全程平等探讨，可以列出下一步能做的事，但不要在结尾用
  「要不要…」「需要吗…」这种问句逼我拍板，也不要把选项包装成二选一或多选一，更不要推销
- Python 版本锁在 3.13（`.python-version` 和 pyproject 的 `requires-python`），不要改
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
