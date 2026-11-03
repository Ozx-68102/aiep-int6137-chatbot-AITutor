# Agent Guidelines

本仓库是 H^2 Bot：聊天页面在 `src/`，接口服务在 `server/`。本文件只写"从代码里读不出来、猜错代价高"的事。

## 最重要的一条

**没有我的明确许可，不要动手实现。** 我回答你的问题、给你补充信息，都不算许可；只有我明确表示可以动手了，才动手。

在那之前只做只读的事：读文件、搜索、查资料、分析问题、给方案、列下一步能做什么。不写文件、不改代码，也不跑会改动仓库的命令——`pnpm install`、`pnpm fmt`、`pnpm build`、`uv sync`、`git add`、`git commit` 都算改动。只读的命令随便跑：`pnpm check`、`pnpm exec tsc --noEmit`、`bash scripts/check-server.sh`、`git status`。

遇到大改动，不管前面许没许可，都停下来：说清楚为什么这么改、要动哪些地方、有什么风险，然后等我的明确许可再继续，不准闷声干大事。算大改动的包括：一次动多个文件、改数据结构或接口契约、加依赖或换工具、动登录/会话/流式这类核心链路、动真实数据、起服务。

## 去哪儿找什么

- 产品与本地运行：[README.md](README.md)
- 工具版本、环境变量、本地启动、Git 钩子：[docs/TECH.md](docs/TECH.md)
- 新人上手：[docs/开发手册/](docs/开发手册/)
- 实测到的反直觉行为（浏览器、库、平台层）：[docs/FINDINGS.md](docs/FINDINGS.md)。新发现追加到那里，不写密钥、密码、cookie，也不贴 logs/ 里的内容——logs/server.log 里写着用户提问和 FastGPT 的上游原文，超过 5MB 会轮转归档
- FastGPT 上游的接口与行为实测：[docs/FASTGPT_API.md](docs/FASTGPT_API.md)。聊天流、停止、重试和 `message` 表：[docs/INTERRUPTED_REPLY.md](docs/INTERRUPTED_REPLY.md)
- 界面上的提示（警示框、消息里的错误、表单里的红字）放在哪里：[docs/UI_WARNINGS.md](docs/UI_WARNINGS.md)
- UI 组件体系：daisyUI 5（类名速查 daisyui.com/components）；主题变量和插件接线在 `src/index.css`
- 控制台/家长端的定位决定和香港私隐法规依据：[docs/PARENT_PORTAL_PRIVACY.md](docs/PARENT_PORTAL_PRIVACY.md)
- 后端特有的规矩和命令：[server/AGENTS.md](server/AGENTS.md)

## 守则

- 信息不足先问：需求、接口、字段、配置不清楚时停下来问并说明理解，不猜、不臆造
- **不推送**；提交自己做（维护者给了常驻许可），发现问题了再补一个提交，不改写已推送的历史。改写历史、强推、删文件等破坏性操作一律先要许可。推送只能维护者做：上游推送后禁止删除和改写提交树，模型推上去的东西一旦有问题就再也改不了
- 不擅自加依赖、换包管理器、改目录结构，如有需要直接提出来，不要静默绕过这些问题。依赖目前只能由维护者装：agent 沙箱里 pnpm 会把 store 切到 `node_modules/.pnpm-store`，维护者终端里用的是 `~/Library/pnpm/store`，两边对不上，pnpm 报 ERR_PNPM_UNEXPECTED_STORE。沙箱里装一次，维护者下一次 `pnpm add` 就撞上这个错。store 目录固定下来之后这条可以放开，细节见 [docs/FINDINGS.md](docs/FINDINGS.md) 里 2026-10-31 那条
- 聊天页面在 `src/`，接口服务在 `server/`。浏览器只访问本仓库的接口，不直连 FastGPT。FastGPT 的工作流和知识库不在本仓库改，那边的事找 FastGPT 的维护者。我们这个 FastGPT 是内部部署的 **v4.14.5** 基线，接口以官方源码为准，不要照文档站抄（见 [server/AGENTS.md](server/AGENTS.md) 的「FastGPT 的版本基线」）
- 登录状态存在浏览器的 `login` cookie 里，请求都要带上它：普通请求走 `src/api/http.ts` 里的 `requestEmpty` / `requestJson`，流式回答在 `src/api/chat.ts`，两处都已经带上 `credentials: 'include'`。不要另写 fetch，也不要用绝对地址——服务端没有 CORS，浏览器会拦
- 用户名和语言另外记在 localStorage 的 `h2bot-profile` 里（`src/session/profile-cache.ts`）：接口服务连不上的时候靠它撑住「我是谁、我用哪种语言」，退出登录要清掉。别当成冗余删了
- 密钥只放根目录 `.env`（已忽略）。不进前端代码、不加 `VITE_` 前缀
- 界面一律用 daisyUI 5 的组件类（btn、input、card、alert、chat、table、menu、avatar、loading 等），不再手写「描边 + 圆角 + hover 变色」这类 utility 组合。颜色优先用语义类（btn-primary、text-error、bg-base-200），它们在 `aiep` 主题下与 stone/emerald 色板同值。类名的权威参考是 `node_modules/daisyui/components/*.css`（按钮在 button.css，不在 btn.css），别凭记忆猜。聊天气泡是 `.chat` 包装 + `.chat-bubble` 双层结构（`src/components/chat/message-class.ts`），气泡下方的按钮要包 `.chat-footer`，否则会被 grid 定位挤歪
- `src/components/shell/Modal.tsx` 面板上的 `opacity-100 scale-100` 两个类是在反制 `.modal-box` 的默认隐藏态：daisyUI 靠 `.modal-open` 父级解锁可见，而本项目用的是自建 portal 外壳、没有那个父级。删掉这两个类，所有弹窗会直接隐形
- 会话行和语言菜单的浮层保持 createPortal 结构，不要换成 daisyUI 的 dropdown：dropdown 依赖行内定位，会被行上动画的 transform 层叠上下文困住（原理见 [docs/FINDINGS.md](docs/FINDINGS.md) 2026-10-31 那条）
- CSS 注释里不要出现 `col-*/offset-*` 这种带 `*/` 的写法：注释会提前终止，后面的 `@plugin` 块被静默丢弃——构建照常成功，只有一条 `Unexpected token` 警告，产物却少了整个插件（2026-11-03 踩过）
- 格式交给工具：写完跑对应的 fmt 命令，不要手动跟格式较劲
- 文档和对话都用平常话，不用自造词和行话
- 说话用陈述语气，少用问句：全程平等探讨，可以列出下一步能做的事，但不要在结尾用「要不要…」「需要吗…」这种问句逼我拍板，也不要把选项包装成二选一或多选一，更不要推销

## 验收

- 改完 `src/`：`pnpm check`（oxlint + oxfmt --check）和 `pnpm build`（build 里已经带类型检查，几秒就完，产物在 `dist/`）
- 只想做类型检查、不产出 `dist/` 时：`pnpm exec tsc --noEmit`
- 改完 `server/` 里的代码：按 [server/AGENTS.md](server/AGENTS.md) 的验收一节做
- 改完界面、跳转或页面状态：在浏览器里点一遍受影响的流程；没有浏览器工具就说明哪一步没验
- 本仓库没有自动化测试，不要引入测试框架

## Git

- 一次逻辑改动一个提交；改完自己提交，不用等许可；不改写已推送的历史，不强推
- 远端开着禁止删除和禁止强推，别去关它。要改已经推送的内容，用新提交、`git revert` 或 `git commit-tree`；推送之后不要强推，要解除这两条规则先问维护者
- 提交说明用英文写成 `feat: add session pinning` 这种样子：类型、冒号、一句话；类型后面不要加括号（`feat(server): ...` 会被钩子拒绝）
- 类型按语义选：用户能感知到的界面或能力变化（含视觉改版）用 feat；纯代码排版用 style；行为不变的重构用 refactor；依赖增删用 chore
- 分支名遵循 Conventional Branch（https://conventionalbranch.org）：`main`、`master`、`develop` 不用前缀；其余写成 `<type>/<description>`。类型只用 feature、feat、bugfix、fix、hotfix、release、chore，以及 ai、copilot、cursor、claude、codex。描述只用小写字母、数字、连字符和点，例如 `feature/add-login-page`。推送前由 `.githooks/pre-push` 检查，正则是 https://conventionalbranch.org/v1.1.0/spec.json 里的那条，用 Perl 匹配
- 远端 GitHub 已经导入同一份分支名规则集（https://conventionalbranch.org/enforce/#rulesets）。不合规的分支名推不上去，本地用 `--no-verify` 跳过钩子也绕不过
- 用 LayerFS 并行开发时，最终合并在 LayerFS 里做：0 冲突才落地 git——用 `git commit-tree` 把那边的分支和提交复刻过来，拓扑、每个提交的时间戳、每一步的改动痕迹都照搬；分支名和提交信息按上面两条钩子规矩写（commit-tree 是底层命令，不触发钩子，所以要逐条拿 `.githooks/commit-msg` 预检）。复刻出来的合并提交，信息里引用的分支名要用 git 侧的合规名（`feature/password-relax` 这种），不要照抄 LayerFS 的合并消息——LayerFS 分支名不允许斜杠，照抄过来必不合规（2026-11-03 踩过）。有冲突就停下来问维护者怎么合，不自己拍板
- 复刻落地之后，把本轮在 git 里建的分支删掉（`git branch -d` 只删已合并的，删不丢内容；这一步属于常驻许可，不用再问）
- 上面这套仪式防的是真有重叠的那天：文件不相交时线性提交的信息一样全，但两条线改了同一个文件时，线性重放会静默覆盖掉一边的改动，只有真合并会把冲突报出来
- 新克隆后执行一次 `bash scripts/setup-hooks.sh`
- 不提交 `.env`、`server/.venv`、`logs/`

## 常用指令

**前端（仓库根目录）**

- `pnpm install` — 装依赖；只用 pnpm。装依赖由维护者执行，原因见上面「不擅自加依赖」那条
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
