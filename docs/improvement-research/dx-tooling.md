# 工程化改进调研：构建、检查工具、文档体系、依赖管理

基于 main 分支 `1eadc4e8c042` 的代码状态。调研只读、不改代码；所有结论以「建议」形式给出，由维护者决定是否采纳。

## 概览

**读了哪些文件**：/package.json、/pnpm-workspace.yaml、/vite.config.ts、/tsconfig.json、/.oxlintrc.json、/.oxfmtrc.json、/index.html、/.gitignore、/.nvmrc、/.lww、/.env.example、/src/vite-env.d.ts、/src/index.css、/server/pyproject.toml、/server/.python-version、/server/AGENTS.md；/scripts/ 全部 3 个脚本（check-server.sh、setup-hooks.sh、start-server.sh）；/.githooks/ 两个钩子（commit-msg、pre-push）；/README.md、/AGENTS.md；/docs/ 全部文件（TECH、FINDINGS、UI_WARNINGS、ACCOUNT_MANAGEMENT、CHAT_STREAM_KNOWN_ISSUES、MESSAGE_ACTIONS、FASTGPT_API、INTERRUPTED_REPLY、NGINX_SPA_DEPLOYMENT_GUIDE、PARENT_PORTAL_PRIVACY；其中 CHAT_STREAM_KNOWN_ISSUES 与 INTERRUPTED_REPLY 已于 2026-11-05 退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md 等）与开发手册全部 4 篇；/public/、/dist/、/src/assets/ 目录清单与 dist 各 chunk 的实测大小；用 glob 统计了 src 下约 59 个 .ts/.tsx 文件，用范围限定的 grep 实测了 console.*、TODO、FIXME、@ts-expect-error、any 等在 /src 与 /server/src 两个范围的密度。未读取 /.env 与 /logs/server.log 的内容（敏感），只确认了它们存在于 LayerFS main 树中。

**现状简述**：这是一个工程化纪律相当好的项目——TypeScript strict 全开、oxlint 开了 typeAware 类型规则（同类项目少见）、ruff 配了 7 组规则集含 banned-api、git 双钩子管提交信息和分支名、文档体系分工明确（FINDINGS 文件头的分流规则且被实际执行过）。代码卫生实测干净：src 与 server/src 里 0 个 console 残留、0 个 any、0 个 @ts-expect-error、0 个 FIXME，仅 2 个 TODO 且都有文档追踪。主要缺口集中在四处：

1. 构建产物是单个 768 KB 主 chunk，无任何拆分策略，>500 kB 构建警告已常态化；
2. 检查工具齐全但**没有一个自动执行点**——无 pre-commit 钩子、无 CI，LayerFS→git 的 commit-tree 复刻落地路径更是完全绕过所有钩子，一切靠人自觉；
3. 依赖管理缺版本钉扎（无 packageManager/engines 字段），pnpm store 问题（FINDINGS 2026-10-31）的根治方案尚未落地，「依赖只能维护者装」是当前最大的协作瓶颈；
4. LayerFS main 树里混入了 node_modules、.pnpm-store、dist、server/.venv、.env、logs 等被 gitignore 的内容，导致 store 膨胀、fs grep/glob 被第三方代码淹没、敏感文件进入持久化版本库。

以下分五节共 28 条，每条含位置、现状、影响、方案（含草图）、第三方库/工具、风险、工作量（S=半天内，M=1~3 天，L=更大）。

## 一、构建与产物

### 1. 主 JS 是单个 768 KB chunk，没有 vendor 拆分

> **已完成（2026-11-06）**：拆分按 `build.rolldownOptions.output.codeSplitting.groups` 落地（Vite 8 是 rolldown 内核，本节 `advancedChunks` 草图与旧 `manualChunks` 写法都不适用）——实测 `vendor-react` 254.74 KB、`vendor-markdown` 413.63 KB（与高亮树共享的 14 个包显式排除在分组外，保高亮按需块自包含），主块降到 124 KB；`/admin` 懒加载另出 10.86 KB（gzip 2.98 KB）独立分块，highlighter 45.6 KB 按需块不变。>500 KB 构建警告不再来自主块，现存于按需懒加载子块——按本条实测体积，超限的是 zxcvbn 语言字典包（language-en 约 1.2 MB，打开改密弹窗才下载），不进首屏。现状见 docs/TECH.md「前端」一节。调研原文以 LayerFS 历史为准。

- **位置**：/vite.config.ts（只有 plugins 和 dev proxy，无 build 段）；产物 dist/assets/index-DdK49yAy.js 实测 768,004 字节（gzip 约 220 KB，FINDINGS 2026-11-03 有历次实测：引入 markdown 前 278 kB → 441 kB → katex 后 716 kB → zxcvbn 后 727 kB）。
- **现状**：react、react-dom、react-router、katex、react-markdown/remark/rehype、lucide-react 和全部业务代码打进同一个 chunk。zxcvbn 字典已经通过动态 import 天然分出 4 个懒加载 chunk（实测 core 33 KB、zh 427 KB、common 435 KB、en 1.2 MB，只在打开改密弹窗时下载）——这部分做得对，不用动。构建输出长期带 >500 kB 的 chunk 警告。
- **影响**：任何一处业务改动都会改写整个 768 KB 文件的 hash，回访用户全量重新下载，缓存命中率差；弱网首屏慢；警告常态化会稀释对真实问题的敏感度。
- **方案**：Vite 8 是 rolldown 内核，用 `build.rollupOptions.output.advancedChunks` 把稳定的第三方库拆成独立分组：

```ts
// vite.config.ts（草图，只示意新增部分）
export default defineConfig({
  plugins: [tailwindcss(), react()],
  build: {
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|react-router|scheduler)/ },
            { name: 'markdown', test: /node_modules[\\/](katex|react-markdown|remark-|rehype-|micromark|mdast-|hast-|unist|unified|vfile|devlop|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|zwitch|longest-streak|bail|trough|decode-named-character-reference|character-entities)/ },
          ],
        },
      },
    },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:3001' } },
});
```

拆完后 react-vendor 与 markdown 两组的 hash 跨版本稳定，业务改动只影响 index chunk；500 kB 警告也随主 chunk 变小自然消失（若仍有个别组超限，再评估是否继续细分，`chunkSizeWarningLimit` 只当最后手段，不调它来「消音」）。分组数量控制在 3~4 个，过多会增加 HTTP 请求数。
- **第三方库/工具**：无（Vite/rolldown 内建）。
- **风险**：markdown 组的包名清单要对着 `pnpm-lock.yaml` 与实际产物核对防漏网；改完需 `pnpm build` 对比产物清单并 `pnpm preview` 实测聊天、公式、改密弹窗三条链路。
- **工作量**：M（配置半天，核对分组与实测 1~2 天）。

### 2. 生产构建无 sourcemap，线上排障无从下手

> **已完成（2026-11-06）**：`build.sourcemap: 'hidden'` 已配（vite.config.ts）——生成 `.map` 但产物 JS 不写 `sourceMappingURL` 注释，浏览器不会自动加载；部署约定按本节执行：`.map` 不发布、留构建机，排障时手动加载。Sentry 未引入（本节建议只到 hidden 为止）。现状见 docs/TECH.md「前端」一节。调研原文以 LayerFS 历史为准。

- **位置**：/vite.config.ts（未设 `build.sourcemap`，默认 false）；`fs glob main 'dist/**/*.map'` 实测为空。
- **现状**：产物只有 minified JS。部署环境是真实用户的 nginx（NGINX_SPA_DEPLOYMENT_GUIDE），线上报错只能对压缩代码猜。
- **影响**：项目没有错误监控服务，sourcemap 价值打折；但人工排障场景（用户报「公式显示乱了」）没有任何定位手段。
- **方案**：开 `build.sourcemap: 'hidden'`——生成 .map 但不在 JS 尾部写 `//# sourceMappingURL` 注释，终端用户的浏览器不会自动加载。配套约定：部署时**不把 .map 拷上服务器**（在 NGINX 指南的部署清单里加一行），.map 留在构建机，排障时在 DevTools 手动加载。若将来引入错误监控（点名 @sentry/react + @sentry/vite-plugin，理由是它能自动上传 sourcemap 并把压缩栈还原成源码栈），这一步是前置条件；本条只建议到 hidden sourcemap 为止。
- **第三方库/工具**：无（Sentry 仅作为将来可选项点名，不建议现在引入）。
- **风险**：.map 含完整源码，误部署到公网目录等于开源——文档必须写死。
- **工作量**：S。

### 3. tsconfig 严格度可再上两档

> **已完成（2026-11-06）**：两档都开，按本节要求分两步两个提交——`noUncheckedIndexedAccess` 报 20 处（收窄/默认值修 9 处解决 19 错，带不变量注释的 `!` 仅 1 处）；`exactOptionalPropertyTypes` 报 7+1 处（类型标注加宽 7 处、补默认值 3 处）。全程零真实越界 bug，运行行为零变化。`vite.config.ts` 的两处索引访问经主代理特别授权做了最小修复（`??` 兜底＋不变量注释），include 覆盖未丢失。现状见 docs/TECH.md「前端」一节。调研原文以 LayerFS 历史为准。

- **位置**：/tsconfig.json。
- **现状**：已经相当严格：`strict`、`noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`、`verbatimModuleSyntax`、`moduleDetection: force` 全开。未开的高价值项：`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
- **影响**：本项目大量操作数组和字典（会话列表、消息线程 src/session/thread.ts、i18n 词条 src/i18n.ts），当前 `arr[i]` 的类型不含 undefined，越界访问编译期不报。在「明确不引入测试框架」的前提下，类型检查是最重要的兜底手段，这两档正是把兜底织密的地方。
- **方案**：分两步、各一个提交：第一步开 `noUncheckedIndexedAccess`，跑 `pnpm exec tsc --noEmit` 清点报错（预计集中在 src/session/、src/hooks/），逐个补空值处理；第二步开 `exactOptionalPropertyTypes`。不要一次全开，报错洪水会把真正有价值的修复淹没。
- **第三方库/工具**：无（TS 7 原生 tsc）。
- **风险**：开启后可能对第三方类型定义产生连带报错，可逐处窄化或豁免；属一次性迁移成本。
- **工作量**：M（估 20~60 处报错，1~2 天）。

### 4. index.html 元数据不全

- **位置**：/index.html。
- **现状**：只有 charset、viewport、三个图标 link、title。缺 `<meta name="description">`、`<meta name="theme-color">`、Open Graph 标签。
- **影响**：链接被分享到 IM/社交平台时无摘要卡片；影响小，但成本极低。
- **方案**：

```html
<meta name="description" content="H^2 Bot —— 讲不明白时继续问：先把卡住的地方讲清楚，再说清它为什么是这样。" />
<meta name="theme-color" content="#f7f6f2" /> <!-- 与 aiep 主题 --color-base-200 同值的十六进制近似 -->
<meta property="og:title" content="H^2 Bot" />
<meta property="og:description" content="…" />
```
- **第三方库/工具**：无。
- **风险**：无。
- **工作量**：S。

### 5. dist/ 提交进了 LayerFS main，产物与源码可能脱节

> **已完成（2026-11-05）**：LayerFS main 已按本地 git 跟踪清单重新播种，dist/ 不再存在于 main；本地 git 侧 dist/ 一直在 .gitignore 里、从未被跟踪。产物一律在沙箱/部署机现构（LayerFS 沙箱实测 vite build 半秒内），「过期 dist」无从发生。规则沉淀的尾巴见第 19 条注记。

- **位置**：LayerFS main 树 /dist/（git 侧被 .gitignore 忽略，仅 LayerFS 侧存在此问题）。
- **现状**：main 里有一份完整构建产物，但没有任何机制保证它是当前 main 源码构建出来的；每次沙箱挂载都会带上它。
- **影响**：可能误用过期 dist；store 占空间。
- **方案**：并入第 19 条的清理——维护者确认后 `fs.rm` 掉 /dist，并立规则「构建产物不进 main，需要时在沙箱现构」（LayerFS 沙箱实测 `vite build` 487ms，FINDINGS 2026-11-03，重建远比维护一致性便宜）。
- **第三方库/工具**：无。
- **风险**：若有流程直接从 main 取 dist 部署，需改为「挂沙箱 → pnpm build → 导出」；当前部署是 nginx 手工流程，本地 git 侧不受影响。
- **工作量**：S。

### 6. preview 验证路径缺文档说明

- **位置**：package.json `"preview": "vite preview"`；README「本地运行」与 TECH.md「类型检查和打包」节。
- **现状**：Vite 的 `preview.proxy` 默认继承 `server.proxy`，所以 `pnpm preview` 下 /api 转发其实是通的——但前提是后端同时在跑，且 preview 默认听 4173 端口。这两点没有任何文档提及。
- **影响**：新人用 preview 验证 dist 时看到「无法连接到服务器」，容易误判产物坏了。
- **方案**：在 TECH.md 与 README 各补一句：「`pnpm preview` 验证产物前，先起 `pnpm run dev:backend`；preview 默认监听 4173」。
- **第三方库/工具**：无。
- **风险**：无。
- **工作量**：S。

## 二、检查工具

### 7. oxlint 规则面窄，卫生基线缺守护规则

- **位置**：/.oxlintrc.json。
- **现状**：plugins 开了 react、typescript、oxc，jsPlugins 开了 oxlint-tailwindcss，`typeAware: true`（oxlint-tsgolint 类型规则）——这套底座配置是同类项目里少见的完整。但 rules 段只显式列了 7 条（hooks 规则、4 条 tailwind 规则等），其余全靠 oxlint 默认（基本只有 correctness 类）；未启用 import、unicorn、promise、react-perf 插件；没有 `no-console`、`typescript/no-explicit-any` 守护。实测当前 src 里 console.* 与 any 都是 0（见第 25 条）——正因为基线干净，现在上守护规则是零成本窗口，等破了再上就要先清存量。
- **影响**：新代码引入 console.log、any、循环依赖、忘 return 的 promise，检查都不会报。
- **方案**：

```jsonc
// .oxlintrc.json 增量草图
{
  "plugins": ["react", "typescript", "oxc", "import", "promise"],
  "categories": { "correctness": "error", "suspicious": "warn" },
  "rules": {
    // 保留现有 7 条不动，另加：
    "no-console": ["warn", { "allow": ["warn", "error"] }],
    "typescript/no-explicit-any": "error",
    "import/no-cycle": "error",
    "promise/always-return": "warn"
  }
}
```

unicorn 与 react-perf 规则面宽、风格类噪音多，本项目规模下收益有限，建议先不开，需要时单条挑选。改完先跑 `pnpm lint` 清点新增命中，误报多的规则降 warn 或行内豁免。
- **第三方库/工具**：无新增（import/promise 插件是 oxlint 内建）。
- **风险**：`import/no-cycle` 在 typeAware 模式下略慢，oxlint 是 Rust 内核，秒级可接受。
- **工作量**：S。

### 8. `pnpm check` 不含类型检查，也没有独立 typecheck 脚本

> **已实现（2026-11-05）**：pnpm check 现在等于 oxlint + oxfmt --check + pnpm exec tsc --noEmit 一起跑（package.json）；独立的 typecheck 脚本没有另加，pnpm exec tsc --noEmit 就是等价入口。功能描述见 docs/TECH.md「前端」一节。调研原文以 LayerFS 历史为准。

### 9. 前后端检查没有统一入口

> **已完成（2026-11-06）**：`scripts/check-all.sh`——前端规范（oxlint）、前端格式（oxfmt --check）、前端类型（tsc --noEmit）、后端两件套（复用 scripts/check-server.sh）四步连跑，失败点名是哪一步并给复验命令，开头检查 pnpm/uv 在不在。是 CI 的本地等价物（CI 只多一次构建）。真机实测四步全绿、总共约 4 秒。

- **位置**：/scripts/check-server.sh（后端 ruff check + format --check）、package.json `check`（前端）。
- **现状**：完整验收要记住两个入口：前端在根目录 `pnpm check`（+第 8 条后的 tsc），后端 `bash scripts/check-server.sh`。没有一键全查。
- **影响**：跨栈改动（API 字段调整这类两边都动的事）容易漏查另一边；AGENTS.md 验收一节的指令分散在两处。
- **方案**：新增 /scripts/check-all.sh 并挂到 package.json：

```bash
#!/usr/bin/env bash
# Run every static check: frontend lint/format/types + backend ruff.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
pnpm check          # oxlint + oxfmt --check (+ tsc, if item 8 lands)
bash scripts/check-server.sh
```

```json
"check:all": "bash scripts/check-all.sh"
```

check-server.sh 已有 uv 缺失时的友好报错，无需改。
- **第三方库/工具**：无。
- **风险**：无。
- **工作量**：S。

### 10. Git 钩子只管「格式」，没有 pre-commit 代码检查

> **已完成（2026-11-06）**：先更正本节前提——仓库原来根本没有查代码的钩子（只有 commit-msg 查提交信息、pre-push 查分支名，「只管格式」指的是提交信息格式）。新建 `.githooks/pre-commit`：跑 check-all.sh 全套（含 tsc——文档证据加实测都是秒级，四项共约 4 秒），失败给中文提示与 `--no-verify` 逃生门（并警告 CI 还会跑同一套）。`setup-hooks.sh` 现有逻辑自动启用，安装脚本未改。落地当天就在真实提交上拦下过一次格式不齐，实战验证。

- **位置**：/.githooks/（commit-msg 管提交信息、pre-push 管分支名）。
- **现状**：两个钩子都是元数据检查，代码质量没有任何自动执行点。FINDINGS 2026-11-03 有现成教训：oxfmt 版本变动导致 `password-strength.ts` 格式失配，main 上 `pnpm check` 红了一段时间才被发现——当时若有 pre-commit 就不会落地。
- **影响**：未格式化、未过 lint、类型报错的代码可以被提交并推送。
- **方案**：新增 .githooks/pre-commit，按本次暂存文件只查对应侧：

```bash
#!/usr/bin/env bash
# Run the checks for whichever side has staged changes.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
staged="$(git diff --cached --name-only)"
if grep -qE '^(src/|index\.html|vite\.config\.ts|tsconfig\.json|\.ox(lint|fmt)rc\.json)' <<<"$staged"; then
  pnpm check
fi
if grep -q '^server/' <<<"$staged" && command -v uv >/dev/null 2>&1; then
  bash scripts/check-server.sh
fi
```

setup-hooks.sh 已经给 .githooks/ 下所有文件 chmod +x，零改动兼容。要认清它的边界：钩子要克隆后手工 `bash scripts/setup-hooks.sh` 启用，且 `--no-verify` 可绕过——所以它是本地快速反馈的第一道，**不能替代第 11 条的 CI**。
- **第三方库/工具**：无。刻意不选 husky/lint-staged：仓库已有原生钩子体系且工作良好，检查本身秒级，没必要引入一层 Node 依赖（也与「不擅自加依赖」守则一致）。
- **风险**：提交时多几秒等待；脚本按路径过滤后 docs-only 提交不受影响。
- **工作量**：S。

### 11. 没有 CI：GitHub Actions 可行且正好覆盖现有盲区（建议）

> **已完成（2026-11-06）**：`.github/workflows/ci.yml`——push main 与全部 PR 触发；前端作业（pnpm 12.16.1 显式钉住与 packageManager 字段对齐、Node 读 .nvmrc、冻结安装、`pnpm check`、构建并确认产物），后端作业（setup-uv、Python 3.13、冻结同步、ruff 两件套）。CI 不跑迁移不起服务（runner 无 PG/Redis），文件头注释写明。**注**：尚未在 GitHub 实跑——push 权在维护者，首次 push 时第一次触发；action 标签均经 API 核实存在、YAML 经解析器验证。

- **位置**：仓库根（/.github 实测不存在）；仓库推送 GitHub（Ozx-68102/aiep-int6137-chatbot-AITutor，package.json 已配 repository/bugs URL）。
- **现状**：所有检查只发生在本地。远端已开分支名 ruleset（AGENTS.md），但没有任何 check 类 ruleset。尤其关键：LayerFS 合并走 `git commit-tree` 复刻落地，**复刻提交不触发任何本地钩子**（AGENTS.md 自己写明 commit-msg 要手动逐条预检）——这条最主要的落地路径目前完全绕过自动检查，CI 是唯一能兜住它的位置。
- **影响**：main 是否始终全绿（lint/类型/构建/ruff 全过）完全依赖人和 agent 的自觉。
- **方案**（建议，需维护者在 GitHub 侧启用）：新增 .github/workflows/ci.yml：

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:

jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4        # 读 package.json 的 packageManager 字段（依赖第 15 条）
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm check                   # 含 tsc（第 8 条落地后）
      - run: pnpm build
  server:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: server } }
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - run: uv sync --locked
      - run: uv run ruff check .
      - run: uv run ruff format --check .
```

跑通后在 GitHub 仓库 Settings → Rules → Rulesets（就是现有分支名规则集的同一处）把两个 job 设为 main 的 required check。**不引入任何测试框架**，CI 只做 lint、类型检查、格式检查、构建——与「本仓库没有自动化测试」的维护者决定完全兼容，也正好回答「没有测试时怎么兜底」：静态检查全绿 + 构建成功是无测试项目能自动化的全部下限，CI 把这个下限从「自觉」变成「强制」。
- **第三方库/工具**：actions/checkout、pnpm/action-setup、actions/setup-node、astral-sh/setup-uv（均为官方免费 Action，点名理由：分别解决取码、pnpm 版本一致性、Node 版本+.nvmrc、uv 安装四件事，无需自写安装脚本）。
- **风险**：私有仓库 Actions 免费额度 2000 分钟/月，此工作流单次约 3~5 分钟，够用；CI 抓不到运行时行为（无测试的既定取舍）；LayerFS 侧的并行开发过程不经过 GitHub，CI 只在落地 git 后生效——这正是它的定位，不是缺陷。前置依赖第 15 条（packageManager 字段），否则 pnpm/action-setup 要手写版本。
- **工作量**：M（工作流文件本身 S，与维护者联调、配 ruleset 为 M）。

### 12. ruff 规则集缺 ASYNC 与安全类

> **部分实现（2026-11-05）**：ASYNC（flake8-async）已加进 ruff 的 select（server/pyproject.toml 的 [tool.ruff.lint]）；安全类 S（bandit）以及 SIM、RUF 没加，仍是 backlog。功能描述见 server/pyproject.toml。调研原文以 LayerFS 历史为准。

### 13. ruff 被列进生产依赖

- **位置**：/server/pyproject.toml `[project].dependencies` 含 `"ruff>=0.17.2"`。
- **现状**：清单里其余依赖（fastapi、sqlalchemy、uvicorn 等）都是运行必需，唯独 ruff 是开发检查工具。生产部署 `uv sync` 会把它一起装上。
- **影响**：生产环境多装无用包（安全面与体积都小，但纯属不必要）；依赖清单语义混淆。
- **方案**：用 PEP 735 依赖组：

```toml
[dependency-groups]
dev = ["ruff>=0.17.2"]
```

从 `[project].dependencies` 删除 ruff。uv 默认安装 dev 组，本地 `uv run ruff`、scripts/check-server.sh 行为不变；生产部署改用 `uv sync --no-dev`（在部署文档补一句）。锁文件需维护者跑一次 `uv lock` 更新。
- **第三方库/工具**：无（uv 原生支持 dependency-groups）。
- **风险**：部署方忘加 `--no-dev` 也只是维持现状，不是回归。
- **工作量**：S。

### 14. WEAK_PASSWORDS 前后端双清单，一致性只靠注释约定

- **位置**：/src/components/settings/password-strength.ts（`WEAK_PASSWORDS`，注释原话「跟 server/src/server/passwords.py 的 _WEAK_PASSWORDS 保持一致，改一处必须改两处」）与 server/src/server/passwords.py。
- **现状**：同一份弱口令拒绝名单在 TS 与 Python 各维护一份，一致性靠注释和自觉，无任何自动校验。文件头注释和 UI_WARNINGS.md 都强调「后端会拒的，提示不能骗人」——这份名单正是该承诺的载体。
- **影响**：单边漏改时前端强度提示与后端硬门槛静默不一致，且没有任何检查会报。这是全项目最典型的「跨语言不变量靠人肉同步」点。
- **方案**（两案，建议先 a 后评估 b）：
  a. **一致性检查脚本**：新增 /scripts/check-weak-passwords.py（Python 单文件，无第三方依赖），分别用正则从 password-strength.ts 提取 `WEAK_PASSWORDS` Set 字面量、从 passwords.py 提取 `_WEAK_PASSWORDS`，排序比对，不一致 exit 1 并打印差集；**提取失败也要 exit 1**（防止格式重排后脚本静默放行）。挂进第 9 条的 check-all.sh 与第 11 条 CI 的 server job。
  b. **单一事实源**：名单挪到 /shared/weak-passwords.json，前端 `import` JSON（Vite 原生支持），后端启动时读同一文件。彻底消除漂移，但引入跨语言路径耦合，且后端读路径要兼容源码运行方式。
- **第三方库/工具**：无。
- **风险**：方案 a 对两边代码的书写格式敏感（oxfmt/ruff format 重排可能破坏正则），故必须「提取失败=检查失败」；方案 b 改动面大一点，属接口契约旁的重构，按 AGENTS.md 属「大改动」需维护者许可。
- **工作量**：a 为 S；b 为 M。

## 三、依赖管理

### 15. package.json 缺 packageManager 与 engines 字段

> **部分完成（2026-11-06）**：`packageManager` 已钉 `pnpm@12.16.1`（package.json）；**`engines` 未加**——Node 版本仍只有 `.nvmrc` 约定、无硬约束，`engine-strict` 也无从谈起，这半仍是 backlog。现状见 docs/TECH.md「包管理」一节。调研原文以 LayerFS 历史为准。

- **位置**：/package.json；/.nvmrc（`lts/jod` = Node 22，与 TECH.md 表格的 22.23.2 一致）。
- **现状**：pnpm 版本完全靠各环境碰巧装了什么。FINDINGS 2026-11-03 实测：维护者机器上有两份 pnpm（12.16.1 与 nvm 下 npm 装的 12.15.0），LayerFS 沙箱镜像自带 11.28.5。lockfileVersion 9.0 目前两者都认，但没有机制保证将来如此。Node 版本只有 .nvmrc 约定，无 engines 硬约束。
- **影响**：环境漂移只能事后发现；pnpm 大版本间安装行为与锁文件格式可能变化。
- **方案**：

```json
{
  "packageManager": "pnpm@12.16.1",
  "engines": { "node": ">=22 <23", "pnpm": ">=12 <13" }
}
```

packageManager 字段被 corepack 与 pnpm/action-setup（第 11 条 CI）识别，一处声明三处受益；engines 默认只警告，要硬拦可在第 16 条的 .npmrc 里加 `engine-strict=true`。
- **第三方库/工具**：无。
- **风险**：LayerFS 沙箱内置 pnpm 11.28.5 会触发 engines 警告（若开 engine-strict 会被拦）——沙箱里能否经 corepack 换 pnpm 12 需实测一次，不能则只警告不 strict，取舍归维护者。
- **工作量**：S。

### 16. pnpm store 问题根治：把 store-dir 固定进项目

- **位置**：仓库根（/.npmrc 实测不存在）；FINDINGS 2026-10-31「pnpm 的 store 目录随环境变」条目（已列三个修法）。
- **现状**：pnpm 12 的默认 store 按「能否从 home 硬链接进项目」运行时决定：agent 沙箱落到 `node_modules/.pnpm-store`，维护者终端用 `~/Library/pnpm/store`。沙箱里装过一次，维护者下次 `pnpm add` 就报 ERR_PNPM_UNEXPECTED_STORE。现行对策是「依赖只能由维护者安装」写进 AGENTS.md 守则——这是目前 agent 与维护者协作的最大瓶颈。
- **影响**：任何需要加依赖的改动都要停下来等人；且报错形态（UNEXPECTED_STORE）对不知情人极难诊断。
- **方案**：采纳 FINDINGS 的方案 2，仓库根新增 /.npmrc：

```ini
store-dir=node_modules/.pnpm-store
```

终端与沙箱从此都用项目内 store，行为一致，报错根因消失。.gitignore 已有 `.pnpm-store/`，LayerFS /.lww 的 `%include .gitignore` 也覆盖它，不会产生合并冲突。落地后维护者需在终端跑一次 `pnpm install` 把 node_modules 重连到项目内 store；AGENTS.md「依赖只能由维护者装」条款可随之放开（改文档前由维护者确认）。FINDINGS 方案 3（全局显式 store-dir）会让沙箱彻底装不了依赖，不推荐。
- **第三方库/工具**：无。
- **风险**：store 固定在项目内后，`rm -rf node_modules` 会连 store 一起删，全量重装需要联网且失去热缓存（沙箱实测热缓存下 3.9s，冷装会慢）；维护者机器失去跨项目共享缓存，磁盘占用上升——单项目开发可接受。是否连带开 `engine-strict`（第 15 条）由维护者定。
- **工作量**：S（配置一行 + 维护者验证一轮）。

### 17. 版本策略与 catalog：维持锁文件为中心，不建议引入 catalog

- **位置**：/package.json（15 个依赖全部 `^` 浮动，唯 katex 为 `~0.16.47`）；/pnpm-workspace.yaml（只有 `allowBuilds: esbuild`，无 catalog）；/pnpm-lock.yaml（95 KB，已提交，与 package.json 同步——FINDINGS 2026-10-31 核对过 15 个依赖对得上）。
- **现状**：策略是「范围声明 + 锁文件锁定」，状态健康。katex 用 `~` 是有道理的（0.x 版本 minor 位可能有破坏性变化）。另外澄清一点：AGENTS.md/FINDINGS 提到「npm 在 pnpm 树里跑会报 catalog: 协议错误」，但本仓库**并未使用** catalog——那是 npm 扫描 node_modules 残留时的误读，不构成引入 catalog 的先例。
- **影响**：无现存问题。catalog 的价值在 monorepo 多包共享版本源；本仓库 pnpm workspace 只有根包一个成员（server 由 uv 管理），引入 catalog 收益为零、徒增一层间接。
- **方案**：**不引入 catalog**。把现行隐含策略写进 TECH.md「包管理」节固化成文：①新依赖默认 `^`；②0.x 版本与构建内核类用 `~`；③升级走 `pnpm outdated` 评审 → `pnpm update` → `pnpm check && pnpm build` 全量验证，禁止手改锁文件；④server 侧维持 `uv lock --check`（已在 server/AGENTS.md 指令清单）。冗余/过期依赖方面：本次核对 package.json 15 个依赖全部在源码中有实际 import（zxcvbn 四包见 password-strength.ts、katex 见 index.css、tailwind 三插件见 index.css @plugin、其余组件级引用抽查通过），无冗余依赖。
- **第三方库/工具**：无。
- **风险**：无。
- **工作量**：S（半页文档）。

### 18. 大依赖体积盘点：zxcvbn 英文字典是最大的可砍项

- **位置**：package.json dependencies；dist 实测（第 1 条）；FINDINGS 2026-11-03 两条有完整实测数据。
- **现状**：
  - zxcvbn 四个懒加载 chunk 合计约 2.1 MB，其中 **language-en 独占 1.2 MB**；首屏只涨 9 KB，懒加载做法本身已是教科书级。
  - katex：JS 进主 chunk（随第 1 条拆出），CSS 并入 index CSS（126.5 KB），dist 另有 20 字体 × woff2/woff/ttf 三份约 800 KB，浏览器实际只下载用得到的 woff2。
  - lucide-react：实测 src 全部具名导入（`import {Send} from 'lucide-react'` 等 6 处），tree-shaking 正常，无问题。
  - react-markdown/remark/rehype/micromark 家族全部在主 chunk，随第 1 条一并拆出。
- **影响**：en 字典占懒加载体积一半以上；产品用户是中文语境学生（界面简/繁/英三语），英文密码场景存在但非主流。字体三份只占服务器磁盘，对用户零负担。
- **方案**：给维护者一个决策点：评估去掉 `@zxcvbn-ts/language-en`，评分只用 common（已含西方泄露密码榜）+ zh + 自建拼音字典，懒加载体积从 2.1 MB 降到约 0.9 MB。改动本身只是删 password-strength.ts 里一行动态 import 和 package.json 一行。字体裁剪（只留 woff2）需要构建后处理脚本，收益仅服务器磁盘，**不建议做**。
- **第三方库/工具**：无（属裁剪决策）。
- **风险**：去 en 字典后纯英文密码的评分准确度下降（会偏低），需维护者产品拍板，不是纯工程决定。
- **工作量**：S。

### 19. LayerFS main 树混入依赖树、构建产物与敏感文件

> **部分完成（2026-11-05）**：第 1~3 步已全部落地——main 按本地 git 跟踪清单重新播种（145 个文件），/.env、/logs、/node_modules、/.pnpm-store、/dist、/server/.venv、各缓存目录、/.idea、各处 .DS_Store 都不在 main 里了（/.env.example 保留）。第 4 步（把「gitignored 路径不进 LayerFS main」写进 AGENTS.md）没有做，是本条唯一的尾巴。已知残留：含旧敏感文件的历史层仍在**本机** store 里，从未离开本机，维护者知情并接受；彻底清掉历史层属宿主工具层操作，不在本条范围内。

- **位置**：LayerFS main：/node_modules、/.pnpm-store、/dist、/server/.venv、/server/.ruff_cache、/server/src/server/__pycache__、/logs/server.log、/.env、/.idea、多处 .DS_Store。git 侧全部被 .gitignore 忽略，不受影响；问题仅存在于 LayerFS 侧。
- **现状**：初始导入把 gitignored 内容全部带了进来。实测影响：(a) FINDINGS 记录 store.sqlite 已达 114 MB；(b) `fs grep` 根目录范围几乎不可用——本次调研 grep TODO 命中被 skip 1762 条，几乎全部来自 .venv 与 .pnpm-store 的第三方代码，必须逐次手工限定路径范围；(c) **/logs/server.log 含用户提问与 FastGPT 上游原文、/.env 含 FastGPT API key 与数据库/Redis 密码**（AGENTS.md 明令敏感；本调研只确认存在、未读内容），二者进入了持久化、项目访问者可读的版本化 store；(d) /.lww `%include .gitignore` 只解决这些路径的合并策略，不阻止它们进树。
- **影响**：检索噪音拖慢所有读操作；store 膨胀；敏感文件入库是治理问题——LayerFS store 的生命周期与访问控制和本地 .gitignore 的假设不同。
- **方案**（全部需维护者决策与执行，本调研只读）：按优先级分四步——
  1. 敏感项：`fs.rm` /logs 与 /.env（保留 /.env.example）；约定 LayerFS 侧今后不导入运行密钥与日志；
  2. 可重建项：`fs.rm` /node_modules、/.pnpm-store、/dist、/server/.venv、/server/.ruff_cache、各 __pycache__；沙箱实测 `rm -rf node_modules && CI=true pnpm install --frozen-lockfile` 全量重建仅 3.9 秒（FINDINGS 2026-11-03），代价可忽略；
  3. 杂项：`fs.rm` /.idea 与 5 处 .DS_Store（详见第 26 条）；
  4. 规则沉淀：把「gitignored 路径不进 LayerFS main」写进 AGENTS.md 的 LayerFS 一节，重建/再导入流程照此过滤。
- **第三方库/工具**：无。
- **风险**：删 node_modules 后「挂载即构建」的假设失效，首次需重装（AGENTS.md 已写明重建方法）；删 .env 后若要在 LayerFS 沙箱跑后端需另行注入环境变量——当前后端调试都发生在本地 git 侧，实际影响待维护者确认。清理是不可逆写操作，动手前应确认 main 无其他分支正基于这些路径工作。
- **工作量**：M（操作本身 S，敏感文件决策与流程确认 M）。

## 四、文档体系

### 20. 开发手册未完成，且与项目现状存在多处不一致

- **位置**：/docs/开发手册/（00-目录.md + 01-准备环境 3 篇：认识前端、Node和nvm、包管理器）。
- **现状**：手册定位新人科普，行文质量不错，但：(a) 只有 01 一章，目录承诺的系列停在「包管理器」；(b) 多处与现状不一致——正文教 `nvm install 24`，而 .nvmrc 是 `lts/jod`（Node 22）、TECH.md 也写 22.23.2；nvm 安装脚本引 v0.40.3，TECH.md 写 0.40.7；scripts 示例是手写旧版（`dev:backend` 写成 `cd server/ && uv run uvicorn …`，实际走 `./scripts/start-server.sh`；`build` 少了 `pnpm exec` 前缀），新人对照真实 package.json 会困惑；(c) 完全没有项目特有内容：双进程启动、.env 准备、PostgreSQL/Redis、uv、Git 钩子、验收命令都散在 README/TECH/AGENTS，手册没有通往它们的路径。
- **影响**：手册的目标读者（零基础新人）装完 Node 和 pnpm 后，仍然不知道这个项目怎么跑起来；版本教错会造成「文档说 24、.nvmrc 说 22」的混乱。
- **方案**：①修正不一致：Node 安装教学改为 `nvm use`（读 .nvmrc）并注明本项目锁 lts/jod；scripts 示例直接复制真实 package.json 片段；②补 02 章「跑起这个项目」：克隆 → `bash scripts/setup-hooks.sh` → 复制 .env.example 填 .env → 起 PostgreSQL/Redis → 双终端 `pnpm run dev:frontend` / `dev:backend` → `uv run python -m server.db.init`，从 README「本地运行」提炼，手册讲「为什么这样做」、README 保持「怎么做」；③补 03 章「规矩」：提交信息/分支名规范（会被钩子拦）、验收命令（pnpm check / build / check-server.sh）、各文档的分工地图（可直接引 AGENTS.md「去哪儿找什么」）。
- **第三方库/工具**：无。
- **风险**：手册与 README/TECH 内容重叠会产生双份维护——写作时坚持「手册讲概念与路径、具体命令链接权威文档」，少复制多引用。
- **工作量**：M。

### 21. TECH.md 硬编码全部版本号，是结构性漂移源

- **位置**：/docs/TECH.md。
- **现状**：前端 14 个工具、后端 12 个库全部写死精确版本号（含「PostgreSQL 18.6（Homebrew）」「Redis 服务器 8.10.2」等外部环境）。package.json、pnpm-lock.yaml、uv.lock 才是权威版本源，TECH.md 是手工副本。本次逐项核对**当前一致**，但第 20 条的开发手册已经示范了写死版本的文档如何过期。
- **影响**：每次依赖升级都要记得同步 TECH.md，这个记忆成本没有任何检查兜底；漂移只是时间问题。
- **方案**：降级为「工具清单 + 职责说明」：锁定在 lockfile 里的依赖（vite、oxlint、fastapi、ruff 等）删去版本号，写「版本以 package.json / pnpm-lock.yaml / uv.lock 为准」；**不在锁文件里的外部环境**（PostgreSQL 18.6、Redis 8.10.2、nvm/Node/pnpm 的本机版本）保留写死但标注「实测环境，非约束」；FastGPT v4.14.5 基线的权威出处是 server/AGENTS.md，TECH.md 改为链接不重复维护。备选方案「保留版本 + AGENTS.md 加同步规则」也可行，但长期成本更高，不推荐。
- **第三方库/工具**：无。
- **风险**：想快速知道「现在用哪个大版本」的人要多开一个文件——可接受。
- **工作量**：S。

### 22. FINDINGS.md 混入 LayerFS 平台经验，产品事实与工具链经验耦合

- **位置**：/docs/FINDINGS.md（34.9 KB）。
- **现状**：文件头的分流规则清晰且被执行过（上游 FastGPT 条目 2026-11-03 移到 FASTGPT_API.md）。但 2026-11-03 一天新增 6 条中，LayerFS store 损坏诊断、macOS init 缺陷、fs.apply 空目录行为、合并提交父指针方向、分页读取等属于**开发工具链**经验，与「Safari favicon 缓存」「transform 层叠上下文」这类产品运行时行为不同性质、不同受众（后者给产品开发者，前者给操作 LayerFS 的维护者与 agent）。文件 9 天涨到 35 KB，照此速度数月内会成为仓库最大文档。
- **影响**：查产品行为坑的人要翻过平台工具流水账；两类经验的生命周期也不同（LayerFS 问题可能随上游版本修复而过时）。
- **方案**：拆出 docs/LAYERFS_FINDINGS.md，把 LayerFS 平台相关条目整体迁移；FINDINGS.md 头部分流规则加一行「开发工具链（LayerFS、沙箱）实测去 LAYERFS_FINDINGS.md」。注意迁移的连带成本：全仓「见 FINDINGS 2026-xx-xx 那条」式引用实测约 11 处、分布在 AGENTS.md（5）、README（1）、server/AGENTS.md（1）、ACCOUNT_MANAGEMENT（3）、INTERRUPTED_REPLY（1；该文档已退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md），迁移条目涉及的引用要同步改。另定归档阈值：单文件超过约 50 KB 或跨自然年时按年拆分。pnpm store 条目（2026-10-31）介于两者之间，倾向留在 FINDINGS（它约束的是所有协作者的行为，不只 LayerFS 操作者），迁移时由维护者定夺。
- **第三方库/工具**：无。
- **风险**：引用锚点漏改会造成文档死链，迁移后应全仓 grep「FINDINGS」核对一遍。
- **工作量**：S。

### 23. docs/ 缺索引与状态标注，待办与现行事实混排

- **位置**：/docs/ 目录（14 个文件 + 开发手册）。
- **现状**：文档入口分散在 README「本地运行」段与 AGENTS.md「去哪儿找什么」——后者实际已是索引，但站在 agent 指南里，人在 GitHub 上浏览 docs/ 目录时没有任何导览。文档性质混杂且无标注：现行事实（TECH、FASTGPT_API、UI_WARNINGS、ACCOUNT_MANAGEMENT）、机制记录（FINDINGS、INTERRUPTED_REPLY——已退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md）、部署手册（NGINX 指南）、**待办**（MESSAGE_ACTIONS 整篇原是「以后要做的事」——2026-11-04 第一至三期已实现、CHAT_STREAM_KNOWN_ISSUES 是待修问题清单——已退役，并入 docs/CHAT_STREAM_PROTOCOL.md 等）、决策记录（PARENT_PORTAL_PRIVACY）。GitHub Issues（package.json 已配 bugs URL）完全未使用。
- **影响**：待办埋在文档里没有跟踪机制，容易遗忘；新人分不清「这是现状还是计划」。
- **方案**：①新增 docs/README.md 索引表：文件、一句话范围、性质（现行事实/机制记录/待办/手册/决策）、最后核实日期；AGENTS.md「去哪儿找什么」改为链接它，消灭双索引；②每篇文档头部加统一状态行：`> 状态：现行事实 ｜ 最后核实 2026-11-03`；③MESSAGE_ACTIONS 与原 CHAT_STREAM_KNOWN_ISSUES（已退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md 等）里的可执行条目由维护者决定是否登记 GitHub Issues，文档保留背景分析、头部标「已建 issue #N 跟踪」。
- **第三方库/工具**：无（GitHub Issues 现成）。
- **风险**：「最后核实日期」需要维护纪律，否则成为新漂移源——建议只对机制记录类要求，现行事实类随第 21 条改造后不再需要。
- **工作量**：S（索引 + 状态行）；issue 迁移另计 M。

### 24. AGENTS.md 与代码一致性：本次核对通过，建议把核对固化为例行动作

- **位置**：/AGENTS.md（11.4 KB）、/server/AGENTS.md。
- **现状**：逐项核对结果：package.json 的 9 个 scripts 与「常用指令」清单一一对应（含「pnpm test 是占位脚本」的提醒）；引用的文档路径全部存在；验收命令（pnpm check、pnpm build、tsc --noEmit、check-server.sh）与脚本实际行为一致；LayerFS 沙箱可用性描述与 FINDINGS 实测记录一致。**未发现不一致**。这在 agent 指南类文档中不常见，是正面结论。
- **影响**：无现存问题；风险在未来漂移（每次规矩变化都要记得同步这份 11 KB 文档）。
- **方案**：无需改动。建议把「AGENTS.md 指令清单 vs package.json scripts、TECH.md vs 锁文件」的核对加进每批次合并落地（commit-tree 复刻流程）的收尾 checklist；第 21 条落地后 TECH.md 漂移面缩小，核对成本更低。
- **第三方库/工具**：无。
- **风险**：无。
- **工作量**：S（checklist 一行）。

## 五、代码卫生

### 25. 卫生基线实测干净，建议用规则锁定

- **位置**：/src（约 59 个 .ts/.tsx 文件）、/server/src。
- **现状**（范围限定 grep 实测，已排除 node_modules/.venv/.pnpm-store 第三方目录）：`console.log/debug/info/warn/error` 0 处；`: any` / `as any` / `<any>` 0 处；`@ts-expect-error` / `@ts-ignore` 0 处；FIXME 0 处；TODO 仅 2 处——src/components/chat/ChatMain.tsx:129（每轮加编辑按钮，MESSAGE_ACTIONS.md 整篇追踪；该 TODO 已随 2026-11-04 编辑功能实现移除）与 src/components/chat/MarkdownText.tsx:17（图片只渲染链接不加载，FINDINGS 2026-10-31 有决策记录）。**两个 TODO 都有文档归属，不是孤儿注释**。这个基线在同规模项目中属于非常干净的一档。
- **影响**：无现存问题；风险仅在增量——没有守护规则时基线会被无声突破。
- **方案**：即第 7 条的 `no-console` 与 `typescript/no-explicit-any` 两条规则（增量锁定）；另在 AGENTS.md 守则加一句「TODO 注释必须同时指向追踪文档或 issue」。存量已清点完毕，无需专项清理。
- **第三方库/工具**：无。
- **风险**：无。
- **工作量**：S（并入第 7 条）。

### 26. 杂物文件：.DS_Store×5、.idea/（仅 LayerFS 树）

> **已完成（2026-11-05）**：随第 19 条重新播种一并清掉——LayerFS main 里已无任何 .DS_Store 与 .idea/；本地 git 从未跟踪过这两类文件。

- **位置**：/.DS_Store、/docs/.DS_Store、/docs/开发手册/.DS_Store、/src/.DS_Store、/server/.DS_Store；/.idea/。均只存在于 LayerFS main，git 侧被 .gitignore 忽略。
- **现状**：macOS Finder 与 JetBrains 残留随初始导入进入版本化 store。
- **影响**：每次 fs list 都出现的视觉噪音；.idea 含本机 IDE 配置，对协作者无意义。
- **方案**：随第 19 条一并由维护者 `fs.rm` 清理。防再犯：git 侧 ignore 已有；LayerFS 侧靠导入流程过滤（第 19 条方案第 4 点的规则）。
- **第三方库/工具**：无。
- **风险**：无（只删 LayerFS 侧副本，维护者本机 IDE 配置不受影响）。
- **工作量**：S（并入第 19 条执行）。

### 27. 死资产线索：avatar-default.png 零引用；favicon.ico 属惯例保留

> **已完成（2026-11-06）**：`public/avatar-default.png` 已删除（前后端默认头像统一走 `/avatar-default.svg`）；`favicon.ico` 按惯例保留（浏览器默认请求，无显式引用）。调研原文以 LayerFS 历史为准。

- **位置**：/public/avatar-default.png、/public/favicon.ico。
- **现状**（实测 grep）：avatar-default.png 在 src、server/src、index.html 中零引用——前后端默认头像统一用 `/avatar-default.svg`（src/api/profile.ts:5 与 server/src/server/app.py:119 双确认），png 是死文件，且每次构建都被拷进 dist。favicon.ico 无 `<link>` 引用，但浏览器存在默认请求 `/favicon.ico` 的惯例行为（老浏览器、地址栏、爬虫），**不算死文件**，属惯例保留。public 其余文件均有引用（favicon.svg、favicon-32.png、apple-touch-icon.png 在 index.html；矢量 logo 走 src/assets）。
- **影响**：冗余资产体量小，但「是没在用还是我没找到用法」对后人是个悬案。
- **方案**：git 侧常规提交流程删除 public/avatar-default.png；favicon.ico 保留，并在 TECH.md（或 index.html 注释）记一句「favicon.ico 无显式引用，为浏览器惯例请求保留」。删除前可顺手在部署访问日志里确认 png 无历史请求。
- **第三方库/工具**：无。
- **风险**：极低；若担心某处运行时拼接了 png 路径（实测 grep 'avatar-default' 仅 svg 一处命中，可能性很小），删除后走一轮头像相关流程验证即可。
- **工作量**：S。

### 28. `pnpm test` 占位文案与项目决策不符

> **已完成（2026-11-06）**：文案已改为如实说明（「本项目不使用测试框架，见 AGENTS.md」）；退出码取 exit 0——与本节「保留 exit 1 响亮失败」的建议不同，以如实说明代替假失败。现状见 docs/TECH.md「前端」一节。调研原文以 LayerFS 历史为准。

- **位置**：/package.json `"test": "echo \"Error: no test specified\" && exit 1"`。
- **现状**：npm init 模板残留文案。「no test specified」暗示「该有测试而没写」，但本项目的实际情况是维护者明确决定不引入测试框架（AGENTS.md：「本仓库没有自动化测试，不要引入测试框架」）。
- **影响**：新人或外部工具（部分 CI 模板会自动跑 test 脚本）拿到误导性失败信息。
- **方案**：把文案改为如实表达决策，保留 exit 1（误调用仍然响亮失败）：

```json
"test": "echo 'No automated tests by maintainer decision (see AGENTS.md). Static checks: pnpm run check:all' && exit 1"
```
- **第三方库/工具**：无。
- **风险**：无。
- **工作量**：S。

## 优先级建议（供维护者参考）

按「收益/成本」排序：

1. **第 16 + 15 条**（.npmrc store-dir、packageManager/engines）：解除「依赖只能维护者装」的协作瓶颈，配置共约 4 行，是全部 28 条里杠杆最高的。
2. **第 19 + 26 条**（LayerFS 树清理）：.env 与 logs/server.log 离开版本化 store 是治理问题，优先级高于一切工程优化；顺带解决检索噪音与 store 膨胀。
3. **第 8 + 12 条**（check 并入 tsc、ruff 加 ASYNC/S）：两处配置改动，直接对准项目已经踩过的真实坑（格式失配红过 main、事件循环阻塞）。
4. **第 11 条**（GitHub Actions CI）：覆盖 LayerFS→git 复刻落地这条目前完全无保护的路径。
5. **第 1 + 2 条**（chunk 拆分、hidden sourcemap）：用户可感知的缓存与排障收益。
6. **第 14 条**（弱口令名单一致性检查）：小脚本锁住跨语言不变量。
7. 文档与卫生类（第 20~24、27、28 条）随批次间隙做，单项都不超过一天。

---

*本调研全程通过 layerfs CLI 只读访问 LayerFS main（`1eadc4e8c042`），未修改任何既有文件；未读取 /.env 与 /logs/server.log 的内容。*
