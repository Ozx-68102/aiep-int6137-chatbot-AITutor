# Agent Guidelines

本仓库是 H^2 Bot：聊天页面在 `src/`，接口服务在 `server/`。
本文件只写"从代码里读不出来、猜错代价高"的事。

## 去哪儿找什么
- 产品与本地运行：[README.md](README.md)
- 工具版本、环境变量、本地启动、Git 钩子：[docs/TECH.md](docs/TECH.md)
- 新人上手：[docs/开发手册/](docs/开发手册/)
- 实测到的反直觉行为：[docs/FINDINGS.md](docs/FINDINGS.md)。新发现追加到那里，不写密钥、密码、cookie，
  也不贴 logs/ 里的内容——logs/server.log 里写着用户提问和 FastGPT 的上游原文，超过 5MB 会轮转归档

## 守则
- 信息不足先问：需求、接口、字段、配置不清楚时停下来问并说明理解，不猜、不臆造
- 动手前先给方案：先讲做法，等确认后再改
- 不直接推送、未经确认不提交；改写历史、强推、删文件等破坏性操作一律先要许可
- 聊天页面在 `src/`，接口服务在 `server/`。浏览器只访问本仓库的接口，不直连 FastGPT。
  FastGPT 的工作流和知识库不在本仓库改，那边的事找 FastGPT 的维护者
- 登录状态存在浏览器的 `login` cookie 里，请求都要带上它：普通请求走 `src/api/http.ts`
  里的 `requestEmpty` / `requestJson`，流式回答在 `src/api/chat.ts`，两处都已经带上
  `credentials: 'include'`。不要另写 fetch，也不要用绝对地址——服务端没有 CORS，浏览器会拦
- FastGPT 的地址、应用 id、变量名、登录方式和接口路径都不臆造，缺了就问
- 密钥只放根目录 `.env`（已忽略）。不进前端代码、不加 `VITE_` 前缀
- 文档和对话都用平常话，不用自造词和行话

## 验收
- 改完 `src/`：`pnpm lint` 和 `pnpm build`（build 里已经带类型检查，几秒就完，产物在 `dist/`）
- 只想做类型检查、不产出 `dist/` 时：`pnpm exec tsc --noEmit`
- 改完 `server/`：在 `server/` 里 `uv run ruff check .`
- 改完界面、跳转或页面状态：在浏览器里点一遍受影响的流程；没有浏览器工具就说明哪一步没验
- 本仓库没有自动化测试，不要引入测试框架

## Git
- 一次逻辑改动一个提交；不改写已推送的历史，不强推
- 提交说明用英文写成 `feat: add session pinning` 这种样子：类型、冒号、一句话；
  类型后面不要加括号（`feat(server): ...` 会被钩子拒绝）
- 新克隆后执行一次 `bash scripts/setup-hooks.sh`
- 不提交 `.env`、`server/.venv`、`logs/`

## 常用指令

**前端（仓库根目录）**
- `pnpm install` — 装依赖；只用 pnpm
- `pnpm run dev:frontend` — 起页面
- `pnpm run dev:backend` — 起接口服务（127.0.0.1:3001）
- `pnpm lint` — oxlint，含类型相关规则
- `pnpm build` — 类型检查 + 打包到 `dist/`
- `pnpm exec tsc --noEmit` — 只做类型检查，不产出 `dist/`
- `pnpm preview` — 预览 `dist/`
- 页面开发服务器会把 `/api/...` 转给 3001 端口的接口服务，所以前端只写相对路径
- 没有 `pnpm dev`：页面和接口是两个进程，要两个终端；接口没起来时页面会提示连不上
- `pnpm test` 是占位脚本，会直接失败，不要用

**后端（`server/` 里）**
- `uv sync` — 按 uv.lock 装好依赖（Python 锁 3.13）
- `uv lock --check` — 检查锁文件
- `uv run ruff check .` — 后端检查
- `uv run server` — 起接口服务，等价于 `pnpm run dev:backend`
- `uv run python -m server.db.init` — 只补缺的表和列，建初始账号，不改已有密码。
  不要每次起服务都跑：只在项目维护者下令时，或改了数据库结构之后跑
- 起接口服务前，本机 PostgreSQL 和 Redis 必须在运行
