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

仓库里有 `pnpm-lock.yaml`。装依赖和跑命令都用 pnpm，不要用 npm 或 yarn。`package.json` 的 `packageManager` 字段固定为 `pnpm@12.16.1`（2026-11-06 加，corepack 与 CI 的 pnpm/action-setup 都认它）；`engines` 字段没加，Node 版本仍靠 `.nvmrc` 约定。

## 前端

- 构建：Vite 8.3.5，插件 @vitejs/plugin-react 6.1.2
- UI：React 19.3.1、react-dom 19.3.1
- 路由：react-router 8.5.1，BrowserRouter 真实路径：聊天 `/`、会话 `/chat/:id`、强制改密 `/force-change-pwd`、自助改密 `/change-pwd`（旧 `/password` 是别名重定向）、登录入口 `/login`、控制台 `/admin`。登录本身是状态不是路由：未登录时任何路径直接渲染登录屏，登录成功后路由自动认领原地址（改密地址除外——一律归位根路径，见 CHAT_PAGE_BEHAVIOR「强制修改密码的拦截」）。不带 id 的 `/chat` 和未知路径归位到根路径
- 图标：lucide-react 1.61.0
- 样式：Tailwind CSS 4.3.3，插件 @tailwindcss/vite 4.3.3
- 组件库：daisyUI 5.7.50（Tailwind 插件，`src/index.css` 里用 `@plugin` 接线）。内置主题已关掉，只用自定义 `aiep` 主题：语义变量（base-*、primary、error 等）与 stone/emerald 色板同值。组件类按需生成，源码里没出现的类不会进产物
- 动画：tw-animate-css 1.4.0
- 代码高亮：react-syntax-highlighter 16.1.2（2026-11-05 装上并同日接线：`dist/esm/prism-light` 按需路线，只注册 python / javascript / typescript / java；第一个命中语言的代码块触发动态 `import()`，独立 chunk 约 45.5 kB（gzip 约 13.4 kB），主包不因此上涨；`@types/react-syntax-highlighter` 15.5.13 已于 2026-11-05 装为开发依赖，临时垫片已删除；该包的子路径类型是环境模块声明，tsconfig 用 `"types": ["react-syntax-highlighter"]` 显式把它拉进编译才生效）
- 语言：TypeScript 7.0.2。tsconfig 在 `strict` 全开之外再加两档（2026-11-06）：`noUncheckedIndexedAccess`（索引访问的类型含 `undefined`）与 `exactOptionalPropertyTypes`（可选属性不再默默接受显式 `undefined`）
- 检查：oxlint 1.89.0，插件 oxlint-tailwindcss 1.16.0、oxlint-tsgolint 7.0.2005。命令是 `pnpm lint`
- 格式化：oxfmt 0.75.0，规则写在 `.oxfmtrc.json`。`pnpm fmt` 改格式，`pnpm fmt:check` 只查不改。`pnpm check` 是 oxlint、oxfmt --check 加类型检查（`pnpm exec tsc --noEmit`）一起跑
- 类型检查和打包：`pnpm build`，等于 `pnpm exec tsc --noEmit && vite build`。产物在 `dist/`，已被忽略
- 构建产物形态（2026-11-06 实测）：vendor 代码块拆分走 `vite.config.ts` 的 `build.rolldownOptions.output.codeSplitting.groups`（Vite 8 是 rolldown 内核，旧 `manualChunks` 写法已废弃）——`vendor-react` 254.74 kB（react、react-dom、scheduler、react-router 家族），`vendor-markdown` 413.63 kB（react-markdown、remark、rehype、micromark、katex 整树；与高亮树共享的 14 个包显式排除在分组外，保持高亮按需块自包含）；主块 124 kB；`/admin` 懒加载出独立分块 `AdminConsole-*.js` 10.86 kB（gzip 2.98 kB）；代码高亮按需块 45.6 kB、zxcvbn 字典 4 个懒加载块不变。`build.sourcemap: 'hidden'`：生成 `.map` 但产物 JS 不写 `sourceMappingURL` 注释，部署不发布 `.map`（留构建机，排查故障时手动加载）
- 界面文案（i18n）：按功能域拆成 `src/i18n/` 下的 `index`、`common`、`chat`、`auth`、`admin`、`errors`、`format` 七个文件（2026-11-06，原单文件 `src/i18n.ts`），每域三语同屏、方便核对齐不齐。类型机制：简中对象 `typeof` 推导 `Messages` 类型，繁中/英文双层显式标注（域文件里一层、index 合并结果再一层）——任何一键在任何语言缺失都是 tsc 编译错误，不再留到运行时变 `undefined` 渲染成空白。带参数的文案走 `format(template, {name})` 具名占位插值（`src/i18n/format.ts`）。错误文案词条在 `src/i18n/errors.ts`，状态码映射与裁决规则在 `src/api/failure.ts`：简中界面后端 `detail` 逐字优先，英文/繁中用状态码映射文案（403/404/408/422/429/500/502/503，401 按 `reason` 分流 expired/disabled），映射不到退回 `detail`；改密页客户端门槛的两条提示同批三语化，简中与后端 `check_password_policy` 逐字一致
- 部署：真实路径路由要求托管方配 SPA 回落（任何未知路径返回 index.html），Nginx 配置和故障排查见 [NGINX_SPA_DEPLOYMENT_GUIDE.md](NGINX_SPA_DEPLOYMENT_GUIDE.md)
- `pnpm test` 只输出一句如实说明「本项目不使用测试框架，见 AGENTS.md」并正常退出（exit 0，2026-11-06 改，不再是 npm init 模板那个假失败）。仓库里没有自动化测试

## 后端

命令在 `server/` 里用 `uv run`，不要直接用 `python` 或 `pip`。各库目前装上的版本：

- 语言：Python 3.13。包管理：uv 0.12.13
- Web：FastAPI 0.162.0，进程用 uvicorn 0.54.0 启动，只监听本机 3001。访问 FastGPT 只用 httpx2 2.16.0 的异步客户端。地址用 furl 2.1.4 拼接
- 数据库：PostgreSQL 18.6（Homebrew）。驱动 psycopg 3.3.6，ORM SQLAlchemy 2.1.6
- 迁移：alembic 1.20.1（2026-11-05 装上；脚本在 `server/migrations/`，现有 0001 = login_token.expires_at 索引、0002 = account.must_change_password 列。表结构变更一律写迁移文件，规矩见 [server/AGENTS.md](../server/AGENTS.md)「迁移」节）
- 配置：Pydantic 2.14.1，pydantic-settings 2.16.1
- 密码：argon2-cffi 25.1.0（Argon2id）
- 半截回答：Redis 服务器 8.10.2（Homebrew）。Python 库 redis 8.1.0
- 检查：ruff 0.17.2；类型检查：basedpyright 1.40.2（standard 档，2026-11-07 加入，配置在 `server/pyproject.toml` 的 `[tool.basedpyright]` 节）
- 格式化：ruff format，规则在 `server/pyproject.toml` 的 `[tool.ruff.format]`。`uv run ruff format .` 改格式，`uv run ruff format --check .` 只查不改。在仓库根目录跑 `bash scripts/check-server.sh` 是三项检查一起跑（ruff check、ruff format --check、basedpyright）

`uv run server` 是 pyproject 里登记的命令，等价于起一个 uvicorn 进程监听 127.0.0.1:3001。

接口清单看 `server/src/server/routes/`（按域拆分的路由包；`app.py` 只做装配），字段和校验看 `server/src/server/types/api.py`。

全局安全响应头（`server/src/server/security/headers.py` 的 `SecurityHeaders`）：纯 ASGI 中间件，在 `app.py` 最外层注册，给所有 HTTP 响应附加三条头（端点已设的不覆盖）——`X-Content-Type-Options: nosniff`（别让浏览器猜 MIME 类型）、`X-Frame-Options: DENY`（任何站点都不能把本应用嵌进 iframe）、`Referrer-Policy: same-origin`（跨源跳转不带 Referer）。CSP、HSTS 这类与加密和部署形态绑定的头留给 nginx 层统一发，避免两层各发一份互相覆盖（部署日批次，方案见 [improvement-research/backend-infra.md](improvement-research/backend-infra.md) 第 9 条）。

## 本地启动

仓库根目录没有 `pnpm dev`。页面和接口分开起：

```bash
pnpm run dev:frontend
pnpm run dev:backend
```

`dev:frontend` 只起页面。`dev:backend` 执行 `scripts/start-server.sh`，接口监听 `127.0.0.1:3001`。

数据库的表和初始账号要准备一次，命令是：

```bash
cd server
uv run python -m server.db.init
```

这条不用每次起服务都跑，只在改了数据库结构之后，或者项目维护者让你跑的时候再跑。

日常命令的完整清单在 [AGENTS.md](../AGENTS.md) 的「常用指令」一节。

## 环境变量

FastGPT 的访问地址、API 密钥和应用 ID，等上游的读超时（`FASTGPT_READ_TIMEOUT_SECONDS`，默认 30 秒，管「等上游第一个字节」和「两块字之间」），PostgreSQL 和 Redis 的连接信息，以及 `DEBUG`，写在仓库根目录的 `.env`。这个文件已被忽略，不会提交。`.env.example` 只说明每一项该填什么。

变量名不要以 `VITE_` 开头。Vite 会把 `VITE_` 开头的变量放进浏览器能下载到的页面里，密钥就会暴露。这些项只给服务端读取，页面代码不要读。服务端在 `server/src/server/settings.py` 读取仓库根目录的 `.env`。配置模型和接口模型在 `server/src/server/types`。

## Git

提交说明由 `.githooks/commit-msg` 检查：英文，类型加冒号加一句话，类型后面不带括号。分支名在推送前由 `.githooks/pre-push` 检查。正则是 [Conventional Branch 1.1.0](https://conventionalbranch.org/v1.1.0/spec.json) 里的那条，用 Perl 匹配。具体写法见 [AGENTS.md](../AGENTS.md) 的「Git」一节。

克隆本仓库后需要在仓库根目录执行一次：

```bash
bash scripts/setup-hooks.sh
```

该脚本会把本仓库的 `core.hooksPath` 设为 `.githooks`，并给钩子加上执行权限。

2026-11-06 起检查多了三层：

- **提交前钩子**（`.githooks/pre-commit`，`setup-hooks.sh` 自动启用）：提交前跑一遍前后端的格式与代码规范检查（调 `scripts/check-all.sh`，含前端类型检查和后端 basedpyright，实测总共约 3 秒）。失败会点名哪一步不过、给复验命令；紧急可以 `git commit --no-verify` 跳过，但 CI 还会跑同一套，跳过不解决问题。
- **统一检查入口**：仓库根 `bash scripts/check-all.sh`——前端规范（oxlint）、前端格式（oxfmt --check）、前端类型（tsc --noEmit）、后端三项（复用 `scripts/check-server.sh`：ruff 两步 + basedpyright）四步连跑，是 CI 的本地等价物。
- **持续集成**：`.github/workflows/ci.yml`，push 到 main 和所有 pull request 自动跑：前端作业（pnpm 冻结安装 → `pnpm check` → 构建并确认产物）、后端作业（uv 冻结同步 → ruff 两步 + basedpyright）。CI 不跑迁移、不起服务（runner 没有 PostgreSQL/Redis）。**2026-11-06 已在 GitHub 首跑**（维护者首次 push 触发）：前端作业 29 秒、后端作业 11 秒，全部通过。
