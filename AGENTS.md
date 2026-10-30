# Agent Guidelines

本仓库是 H^2 Bot：聊天页面在 `src/`，接口服务在 `server/`。
本文件只写"从代码里读不出来、猜错代价高"的事。

## 最重要的一条
**没有我的明确许可，不要动手实现。** 我回答你的问题、给你补充信息，都不算许可；只有我明确表示可以动手了，才动手。

在那之前只做只读的事：读文件、搜索、查资料、分析问题、给方案、列下一步能做什么。
不写文件、不改代码，也不跑会改动仓库的命令——`pnpm install`、`pnpm fmt`、`pnpm build`、
`uv sync`、`git add`、`git commit` 都算改动。
只读的命令随便跑：`pnpm check`、`pnpm exec tsc --noEmit`、`bash scripts/check-server.sh`、`git status`。

## 去哪儿找什么
- 产品与本地运行：[README.md](README.md)
- 工具版本、环境变量、本地启动、Git 钩子：[docs/TECH.md](docs/TECH.md)
- 新人上手：[docs/开发手册/](docs/开发手册/)
- 实测到的反直觉行为：[docs/FINDINGS.md](docs/FINDINGS.md)。新发现追加到那里，不写密钥、密码、cookie，
  也不贴 logs/ 里的内容——logs/server.log 里写着用户提问和 FastGPT 的上游原文，超过 5MB 会轮转归档
- 后端特有的规矩和命令：[server/AGENTS.md](server/AGENTS.md)

## 守则
- 信息不足先问：需求、接口、字段、配置不清楚时停下来问并说明理解，不猜、不臆造
- 不直接推送、未经确认不提交；改写历史、强推、删文件等破坏性操作一律先要许可。
  推送只能我做：上游推送后禁止删除和改写提交树，模型推上去的东西一旦有问题就再也改不了
- 不擅自加依赖、换包管理器、改目录结构，如有需要直接提出来，不要静默绕过这些问题
- 聊天页面在 `src/`，接口服务在 `server/`。浏览器只访问本仓库的接口，不直连 FastGPT。
  FastGPT 的工作流和知识库不在本仓库改，那边的事找 FastGPT 的维护者
- 登录状态存在浏览器的 `login` cookie 里，请求都要带上它：普通请求走 `src/api/http.ts`
  里的 `requestEmpty` / `requestJson`，流式回答在 `src/api/chat.ts`，两处都已经带上
  `credentials: 'include'`。不要另写 fetch，也不要用绝对地址——服务端没有 CORS，浏览器会拦
- 密钥只放根目录 `.env`（已忽略）。不进前端代码、不加 `VITE_` 前缀
- 格式交给工具：写完跑对应的 fmt 命令，不要手动跟格式较劲
- 文档和对话都用平常话，不用自造词和行话
- 说话用陈述语气，少用问句：全程平等探讨，可以列出下一步能做的事，但不要在结尾用
  「要不要…」「需要吗…」这种问句逼我拍板，也不要把选项包装成二选一或多选一，更不要推销

## 验收
- 改完 `src/`：`pnpm check`（oxlint + oxfmt --check）和 `pnpm build`（build 里已经带类型检查，几秒就完，产物在 `dist/`）
- 只想做类型检查、不产出 `dist/` 时：`pnpm exec tsc --noEmit`
- 改完 `server/` 里的代码：按 [server/AGENTS.md](server/AGENTS.md) 的验收一节做
- 改完界面、跳转或页面状态：在浏览器里点一遍受影响的流程；没有浏览器工具就说明哪一步没验
- 本仓库没有自动化测试，不要引入测试框架

## Git
- 一次逻辑改动一个提交；不改写已推送的历史，不强推
- 远端开着禁止删除和禁止强推，别去关它。要改已经推送的内容，用新提交、`git revert`
  或 `git commit-tree`；推送之后不要强推，要解除这两条规则先问维护者
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
- `pnpm fmt` — 按 `.oxfmtrc.json` 改格式
- `pnpm fmt:check` — 只查格式，不改文件
- `pnpm check` — oxlint + oxfmt --check
- `pnpm build` — 类型检查 + 打包到 `dist/`
- `pnpm exec tsc --noEmit` — 只做类型检查，不产出 `dist/`
- `pnpm preview` — 预览 `dist/`
- 页面开发服务器会把 `/api/...` 转给 3001 端口的接口服务，所以前端只写相对路径
- 没有 `pnpm dev`：页面和接口是两个进程，要两个终端；接口没起来时页面会提示连不上
- `pnpm test` 是占位脚本，会直接失败，不要用

后端的命令在 [server/AGENTS.md](server/AGENTS.md) 的「常用指令」一节。
