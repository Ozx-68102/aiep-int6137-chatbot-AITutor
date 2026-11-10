# 后端说明

后端是 `server/` 里的 FastAPI 服务，只听本机 3001 端口。跨项目的规矩见仓库根目录的 [AGENTS.md](../AGENTS.md)；这个文件只写后端特有的事。

## 说话和写文档

（与仓库根目录 AGENTS.md 的同一节。维护者要求两个文件都把这节放在最前面，这里原文重复。）

- 文档和对话都用人类的自然语言，不用自造词和行话。指代一个概念时，用仓库里已有的叫法，或者拿平常话直接解释，不要发明新词
- 判断标准：IT 或 AI 领域的教材里不会出现的行话、黑话、缩略语、自造词（例如「孤儿键」「上一世进程」「拍板」）一律不用。有对应的标准术语就用标准术语；没有就用平常话直接解释；不为节省字数发明缩写（2026-11-06 维护者许可下全项目清理过一遍这类词）
- 文档里的编号和日期标记（FINDINGS 按日期索引的条目、UI_WARNINGS 的第几条规则这类）是给 AI 助手定位原文用的，不是对话用语。跟我说话时不要扔个编号让我自己回去翻条目，把那条内容用自然语言讲出来；要给出处，编号附在话后面
- 说话用陈述语气，少用问句：全程平等探讨，可以列出下一步能做的事，但不要在结尾用「要不要…」「需要吗…」这种问句逼我做决定，也不要把选项包装成二选一或多选一，更不要推销

## 常用指令
（在 `server/` 里执行）
- `uv sync` — 按 uv.lock 装好依赖（Python 锁 3.13）
- `uv lock --check` — 检查锁文件
- `uv run ruff check .` — 检查
- `uv run ruff format .` — 按 ruff 的规则改格式
- `uv run ruff format --check .` — 只查格式，不改文件
- `uv run basedpyright` — 类型检查（standard 档，配置在 `pyproject.toml` 的 `[tool.basedpyright]` 节）
- 前后端一键全查在仓库根：`bash scripts/check-all.sh`（`.githooks/pre-commit` 跑的就是它）
- `uv run server` — 起服务，等价于仓库根目录的 `pnpm run dev:backend`
- `uv run python -m server.db.init` — 只补缺的表和列，建初始账号，不改已有密码。不要每次起服务都跑：只在项目维护者下令时，或改了数据库结构之后跑

起服务前，本机 PostgreSQL 和 Redis 必须在运行。想一次跑完两项检查：在仓库根目录执行 `bash scripts/check-server.sh`。

## 验收
- 改完后端代码：`uv run ruff check .`、`uv run ruff format --check .` 和 `uv run basedpyright`

## 迁移

表结构变更走 Alembic：配置在 `alembic.ini`，脚本在 `migrations/`（入口 `migrations/env.py`，版本文件在 `migrations/versions/`）。

- 跑迁移：`cd server && uv run alembic upgrade head`
- 规矩：此后表结构变更（加列、加索引、改约束）一律写成新的迁移文件，不再往 `db/init.py` 里加 `_ensure_*_column` 那种手写字段补丁；已有的补丁函数原样留着
- 版本文件的 revision id 用四位递增编号（0001、0002……），文件名 `<rev>_<slug>.py`；新迁移的 down_revision 指向当前最新的那个
- 引导仍走 `create_all`：`uv run python -m server.db.init` 继续负责新数据库的建表和初始账号。两条路要给出一致的结构——模型里声明的索引（如 `ix_login_token_expires_at`）`create_all` 会建出来，迁移那边用 `CREATE INDEX IF NOT EXISTS` 这种幂等写法，谁先跑都不冲突
- `migrations/env.py` 复用 `server.db.session.get_engine()` 拿数据库 URL：不在 `alembic.ini` 里另配，也不复制任何密钥逻辑

## FastGPT 的版本基线

FastGPT 是内部部署的，当前基线是 **v4.14.5**（内部可能改过，别当原版用）。

它的接口清单不要照文档站看：

- 文档站 doc.fastgpt.io 的「对话接口」页对应的是更新版本。从 4.15.0 起官方不再手工维护接口说明，改成分布在部署地址的 `/apidoc/devapi` 和 `/apidoc/systemopenapi`；这两个地址是 4.15.0 才引入的，我们这个部署上都是 404（v4.14.5 的源码里没有 apidoc 相关页面）。
- FastGPT 的接口说明分三层：代码里的 OpenAPI 定义（`packages/global/openapi/**`，每个路由带 summary 和 description）→ 文档站的手写页（`document/content/docs/**`）→ 部署上的自动清单（4.15 以后才有）。「文档没有、源码有」是常态，两边都不是全集。
- 所以要确认某个接口存不存在、地址和参数是什么，直接看官方仓库 tag **v4.14.5** 的源码，再用一次实测确认。聊天相关的实现在 `projects/app/src/pages/api/`，OpenAPI 定义在 `packages/global/openapi/core/chat/`。

看源码不用克隆整个仓库，取单个文件就行：

```bash
curl -sL https://raw.githubusercontent.com/labring/FastGPT/v4.14.5/<路径>
```

## 我们走的接口

- 聊天走 `POST {访问地址}/v2/chat/completions`（**v2**）。v1、v2 的请求和响应几乎一样，差别在工作流怎么判停：v2 看 Redis 里的运行态标记，v1 只看客户端连接断没断。
- 停止上游要另外调 `POST {访问地址}/v2/chat/stop`，body 是 `{appId, chatId}`。**光断连接在 v2 上停不住上游**（实测：不叫停的话，上游会把整篇答案写完）。这个接口自己最多等五秒，所以调用方不要等它的返回。
- 依据和实测见 [docs/FASTGPT_API.md](../docs/FASTGPT_API.md) 的「停止机制」和「v1 与 v2 对话接口」。

## 边界
- 没有我的明确许可，不要动手实现：我回答你的问题、给你补充信息，都不算许可；只有我明确表示可以动手了，才动手。在那之前只做只读的事，不写文件、不改代码、不跑会改动仓库的命令
- 遇到大改动，不管前面许没许可，都停下来：说清楚为什么这么改、要动哪些地方、有什么风险，然后等我的明确许可再继续，不准不声不响干大事。算大改动的包括：一次动多个文件、改数据结构或接口契约、加依赖或换工具、动登录/会话/流式这类核心链路、动真实数据、起服务
- 依赖优先于手写：Python 这边同理，PyPI 上成熟的库能做的事，直接提出来让维护者 `uv add`，不要因为 agent 自己装不了依赖就宁可手写一份替代实现凑合。装不装由维护者定，该说的必须说
- Python 版本锁在 3.13（`.python-version` 和 pyproject 的 `requires-python`），不要改
- FastGPT 的地址、应用 id、变量名、登录方式和接口路径都不臆造，缺了就问
- 密钥只放仓库根目录 `.env`（已忽略），由 `server/src/server/settings.py` 读取。不写进代码，也不写进日志
- 日志在仓库根目录的 `logs/server.log`，超过 5MB 会轮转归档。里面写着用户提问和 FastGPT 的上游原文，不要贴进提交说明、文档或 issue
- 新的 Redis 键空间一律挂在 `h2botapp-chat:` 前缀底下：应用连的 Redis 用户 `h2bot_app` 的 ACL 只放行这一个前缀，别的前缀会 `NoPermissionError`，而且照「Redis 不通就放行」的降级写法这个错不会浮出来——功能直接静默失效。要另起前缀先请维护者放开 ACL。实测见 [docs/FINDINGS.md](../docs/FINDINGS.md) 2026-11-02 那条
- **只能单 worker 运行，不要加 `--workers`**：停止一轮靠「在本进程里找到那个中继任务并取消」，启动核对和过期令牌清扫也按单进程假设跑——多 worker 时停止请求大概率落到另一个进程，找不到任务、照样回成功，用户按了停止但回答继续写，而且不报错。容量瓶颈先考虑查询精简和机器规格。前提的细节见 [docs/CHAT_STREAM_PROTOCOL.md](../docs/CHAT_STREAM_PROTOCOL.md)「单进程前提」一节
- 配置模型和接口模型在 `server/src/server/types`

## 登录状态
登录凭据存在名为 `login` 的 cookie 里：cookie 里放的是令牌，数据库的 `login_token` 表存它的哈希。有效期 7 天，每个带 cookie 的请求都会重新续 7 天。没登录的请求返回 401（JSON；会话类 401 带 reason 词，见 [docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md](../docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md)）。401 不删 cookie——主动清 cookie 的只有退出、控制台退出和修改密码路径，所以漏带 cookie 的表现是碰到「留在原页面的过期状态」（页面横幅 + 重新登录），不是「莫名其妙被登出」。
