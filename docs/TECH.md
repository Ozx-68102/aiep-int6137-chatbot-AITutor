# TECH

该文档用于记录本项目所使用的技术栈。

## 运行时

| 工具    | 版本    | 说明                             |
|---------|---------|----------------------------------|
| nvm     | 0.40.7  | 多Node版本管理器                 |
| Node.js | 22.23.2 | nvm 的 `default`，别名 `lts/jod` |
| npm     | 12.0.2  | Node 自带包管理器                |
| pnpm    | 12.16.1 | 包管理器，安装方式见下一节       |

注意：Node 22 的维护期到 2027 年 4 月。

## 包管理

本项目建议优先使用 pnpm。安装命令如下：

```bash
npm install -g pnpm
```

仓库里有 `pnpm-lock.yaml`。装依赖和跑命令都用 pnpm，不要用 npm 或 yarn。

## 前端

- 构建：Vite 8.3.5，插件 @vitejs/plugin-react 6.1.2
- UI：React 19.3.1、react-dom 19.3.1
- 图标：lucide-react 1.61.0
- 样式：Tailwind CSS 4.3.3，插件 @tailwindcss/vite 4.3.3
- 动画：tw-animate-css 1.4.0
- 语言：TypeScript 7.0.2
- 检查：oxlint 1.89.0，插件 oxlint-tailwindcss 1.16.0、oxlint-tsgolint 7.0.2005。命令是 `pnpm lint`
- 格式化：oxfmt 0.75.0，规则写在 `.oxfmtrc.json`。`pnpm fmt` 改格式，`pnpm fmt:check` 只查不改。
  `pnpm check` 是 oxlint 加 oxfmt --check 一起跑
- 类型检查和打包：`pnpm build`，等于 `pnpm exec tsc --noEmit && vite build`。产物在 `dist/`，已被忽略
- `pnpm test` 是占位脚本，会直接失败。仓库里没有自动化测试

## 后端

命令在 `server/` 里用 `uv run`，不要直接用 `python` 或 `pip`。各库目前装上的版本：

- 语言：Python 3.13。包管理：uv 0.12.13
- Web：FastAPI 0.162.0，进程用 uvicorn 0.54.0 拉起，只听本机 3001。访问 FastGPT 只用 httpx2 2.16.0 的异步客户端。地址用 furl 2.1.4 拼接
- 数据库：PostgreSQL 18.6（Homebrew）。驱动 psycopg 3.3.6，ORM SQLAlchemy 2.1.6
- 配置：Pydantic 2.14.1，pydantic-settings 2.16.1
- 密码：argon2-cffi 25.1.0（Argon2id）
- 半截回答：Redis 服务器 8.10.2（Homebrew）。Python 库 redis 8.1.0
- 检查：ruff 0.17.2
- 格式化：ruff format，规则在 `server/pyproject.toml` 的 `[tool.ruff.format]`。
  `uv run ruff format .` 改格式，`uv run ruff format --check .` 只查不改。
  在仓库根目录跑 `bash scripts/check-server.sh` 是这两项检查加 ruff check 一起

`uv run server` 是 pyproject 里登记的命令，等价于起一个 uvicorn 进程听 127.0.0.1:3001。

接口清单看 `server/src/server/app.py`，字段和校验看 `server/src/server/types/api.py`。

## 本地启动

仓库根目录没有 `pnpm dev`。页面和接口分开起：

```bash
pnpm run dev:frontend
pnpm run dev:backend
```

`dev:frontend` 只起页面。`dev:backend` 执行 `scripts/start-server.sh`，接口听 `127.0.0.1:3001`。

数据库的表和初始账号要准备一次，命令是：

```bash
cd server
uv run python -m server.db.init
```

这条不用每次起服务都跑，只在改了数据库结构之后，或者项目维护者让你跑的时候再跑。

日常命令的完整清单在 [AGENTS.md](../AGENTS.md) 的「常用指令」一节。

## 环境变量

FastGPT 的访问地址、API 密钥和应用 ID，PostgreSQL 和 Redis 的连接信息，以及 `DEBUG`，写在仓库根目录的 `.env`。这个文件已被忽略，不会提交。`.env.example` 只说明每一项该填什么。

变量名不要以 `VITE_` 开头。Vite 会把 `VITE_` 开头的变量放进浏览器能下载到的页面里，密钥就会暴露。这些项只给服务端读取，页面代码不要读。服务端在 `server/src/server/settings.py` 读取仓库根目录的 `.env`。配置模型和接口模型在 `server/src/server/types`。

## Git

提交说明由 `.githooks/commit-msg` 检查：英文，类型加冒号加一句话，类型后面不带括号。
具体写法见 [AGENTS.md](../AGENTS.md) 的「Git」一节。

克隆本仓库后需要在仓库根目录执行一次：

```bash
bash scripts/setup-hooks.sh
```

该脚本会把本仓库的 `core.hooksPath` 设为 `.githooks`，并给钩子加上执行权限。
