# Findings

记实际看过、但文档或接口说明里不明显的行为。新的发现按日期追加在下面，不要把密钥、密码或 cookie 写进来。

这个文件只收**浏览器、库和平台层**的实测反直觉行为。别的内容各有各的家，不要写进来：

- FastGPT 上游的接口与行为事实：[FASTGPT_API.md](FASTGPT_API.md)（本文件原有的十几条上游条目 2026-11-03 移到那里）
- 聊天流协议与轮次生命周期（停止、重试、刷新续传、`message` 表）：[CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)
- 登录态、令牌与限流：[LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)
- 轮次日志与排查：[TURN_LOGGING_AND_DIAGNOSTICS.md](TURN_LOGGING_AND_DIAGNOSTICS.md)
- 聊天页面行为：[CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)
- 消息操作区（脚注）：停止/失败提示、重试、编辑重发（第一至三期已实现）：[MESSAGE_ACTIONS.md](MESSAGE_ACTIONS.md)
- 环境变量和工具版本：[TECH.md](TECH.md)
- 账号和密码：[ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md)
- 后端代码的规矩：[server/AGENTS.md](../server/AGENTS.md)

## 2026-10-26 助手回复开头的空行来自上游正文

页面用 `whitespace-pre-wrap` 显示助手文字，不会自己插入换行。后端把 FastGPT 的 `delta.content` 原样放进 SSE，历史记录也是把上游 `text.content` 拼起来。实测「你好」的回答正文以两个换行开头，所以气泡顶部空出两行。页面显示时去掉助手文字开头的换行，中间的换行仍保留。

## 2026-10-26 置顶时刻由页面传给服务器

置顶时刻由页面在置顶时传给服务器，字段是 `pinned_at`。取消置顶时清空。页面按这个时间把较早置顶的排在上面，不再记在这台浏览器里。

（这条原来错贴在「助手回复开头的空行」那条的末尾，2026-11-03 挪出来单立。）

## 2026-10-29 会话标题原来只存在浏览器内存里

新建会话时，页面把首条提问写进自己的状态当标题，但没发给服务器，`session` 表的 `title` 一直是 NULL。刷新页面时列表从 `GET /api/sessions` 读回 NULL，标题就退回占位文字（新对话）。

`PATCH /api/sessions/{会话id}` 是唯一能写标题的接口，之前只被手动重命名用到；它也从来不写 `title_locale`，所以 `session.title_locale` 这一列在数据库里一直是 NULL，标题上的 `lang` 属性等于没有。

现在改成：建会话时 `POST /api/sessions` 可以带上 `title`，一次写进数据库；标题为 NULL 的旧会话在发出下一条消息时用 `PATCH` 补写一次。标题最长 500 字，超出后端返回 422，页面自己先截断。

标题的内容就是首条提问原文：FastGPT 没有生成标题的接口，本仓库里也没有，这是目前能做到的最好做法。老会话的标题不回填，是有意留着：它们下次发消息时用那次的提问当标题。标题没存进数据库时，页面退回占位文字，不出现「看着有标题、数据库里没有」的情况。

`session` 表里还有一列 `title_locale`，本来是给标题加语言标记用的，读屏软件按这个标记选语音念标题。这个功能先不做：只有简体中文、繁体中文、英文三个取值，标题里混了别的语言就标不对，不如不标。所以接口不再返回这一列，也不再写它；表里的列没动，将来做的时候直接用。

## 2026-10-29 重复点「创建新对话」不新建，也不提示

点「创建新对话」不会马上在服务器上建会话。页面只是进入"正在写新会话"的状态：把草稿存起来，清掉当前选中的会话，切到聊天页。真正建会话是发出第一条消息的时候才做的，`POST /api/sessions` 那时才调。

已经在"正在写新会话"的时候再点一次，页面什么都不做：不新建，不报错，也不提示。`src/App.tsx` 的 `addSession` 里看到 `composingNew` 为真，就 `setView('chat')` 直接返回。

这是有意为之，不是漏了提示。服务器那边也拦不住连续建空会话，它只负责建，不管建出来的会话有没有内容。

## 2026-10-30 刷新页面时，用户提问和「…」会一起消失（已修）

原因不在 Redis，在前端的归位逻辑。

`src/session/thread.ts` 的 `withPartial` 靠「线程里最后一条助手消息的文字是不是以 Redis 里那份文字开头」来判断当前这一轮对应哪条消息。刷新发生在第一块字到达之前，Redis 里的文字是空串，`startsWith('')` 恒成立，于是把**上一轮**的回答标成了「正在写」：

- 上一轮回答有文字，「…」就不会出现（`waitingForText` 要求文字为空）；
- 接着 `resumePartial` 找到的也是上一轮那条，轮询时新文字拼不进去（`partial.text` 不是上一轮文字的开头），这一轮的回答在刷新后的页面上永远不出现；
- 用户的提问本来就没地方存：后端只把它转发给 FastGPT，Redis 只存助手那半截文字，我们自己的数据库里没有消息表。FastGPT 又是这一轮结束之后才把记录写进它的数据库。

所以刷新那一刻，「你问了什么」在服务器上哪儿都没有，页面自然就空了。等到模型答完再刷新，FastGPT 的历史里才有这一轮，页面才恢复。

日志能对上：20:15:33 发出提问，20:15:34、20:15:35、20:15:36 连续三次刷新，每次都是先读 `/partial` 再读 `/messages`，而那一刻 `/messages` 拿不到这一轮；20:15:40 上游整段到达，20:15:41 `[DONE]`；20:15:42 再刷新，页面才完整。

现在改成：每一轮有自己的编号，Redis 里连着提问一起存着，服务器把「正在写的那一轮」接在历史后面一起返回，页面按编号认消息，不再靠文字猜。详见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)。

## 2026-10-30 刷新得太急，上游承受不住压力，日志会超出容量

21:18 的一次实测：发出提问以后连着刷新了十来次，每次刷新都问一次 FastGPT 要整段历史。上游（maas.eduhk.hk）从 21:18:18 起连不上了 —— 报的是 `httpx2.ConnectTimeout`，也就是 TCP 连接根本没完成握手，不是响应慢。紧接着 21:18:24 连聊天本身也失败了（「FastGPT 读取失败」）。

三个后果，都改掉了：

1. **上游承受不住压力**：每一次页面加载都要问一次上游要历史，刷新得急了就是几十个并发请求。现在服务器留五秒的缓存，刷新多少次上游就只被问一次（实测：连着刷新十次，上游被问两次）。
2. **日志超出容量**：一次失败打 250 行。`app.py` 的通用异常处理器打一遍栈，Starlette 处理完还会把异常再抛一次，uvicorn 又打一遍栈。现在网络错误（连接超时、读超时）在 FastGPT 客户端就被转换成 `FastGPTError`，接口回一个 502 和一行字，不打栈；通用处理器也只记一行。
3. **错误信息对用户没有意义**：上游出故障时页面只说「暂时问不到上游，请稍后重试」。

## 2026-10-30 Safari 的网站图标

SVG favicon 在 Safari 26 之前一直不支持（[caniuse](https://caniuse.com/link-icon-svg)：Safari 3.1–18.7 不支持，26 起支持；Chrome 80 起就支持）。所以老 Safari 上 tab 里显示不出图标，要准备一份 PNG。

另外 Safari 的 favicon 缓存是按**页面地址**记的：某个地址缓存成「没有图标」之后，重新加载同一个地址它也不会再取一次，换成带查询参数的地址（新的缓存键）才会重新取。这就是「根目录没有图标，带上 ?session=xxx 刷新才有」这种现象的来源（当时地址还是查询参数方案；2026-11-04 起路由已改为真实路径，Safari 按地址缓存 favicon 的机制不变）。

## 2026-10-31 会话行上的 transform 会把行内的浮层关进去

会话行有重新排序的动画，动画期间行上会带 `transform: translateY(...)`（`Sidebar.tsx` 里直接写 `row.style.transform`）。这一下有两个副作用：

- 带 transform 的元素会**建立层叠上下文**，行内那个 `fixed z-50` 的二级菜单的层级就被关在这一行里，排在后面的会话行画在它上面 —— 菜单被后面的会话卡片盖住，点「重命名」「删除」点到的其实是下面那一行；
- 带 transform 的元素还是 `position: fixed` 的**包含块**，浮层的位置是相对这一行算的，不是相对视口。

所以二级菜单改成用 `createPortal` 挂到 `body` 上（`SessionRow.tsx`），位置直接按视口算：`top` 用按钮的 `getBoundingClientRect().bottom`，`right` 用 `window.innerWidth - rect.right`。点外面关菜单的判断也要改成同时看菜单本身和那个按钮（菜单已经不在按钮的父节点里了）。

教训：行内浮层（菜单、下拉）一律走 portal，不要挂在带 transform 的行里。

## 2026-10-31 接口服务连不上时，页面要自己撑住登录态

接口服务断掉时，浏览器里的 `login` cookie 还在，但页面读不到用户信息（`/api/profile` 读不到），左下角的用户名就空了，看起来像登录状态丢了。另外「连不上服务器」被报了两遍：服务状态那边一条琥珀色，动作失败那边又一条红色。

现在的做法：

- **用户名和语言记在本地**：`src/session/profile-cache.ts` 把它们放在 localStorage 的 `h2bot-profile` 里，读到就写，退出登录清掉。页面启动时先用本地那份，接口服务连不上也照样显示用户名和原来的语言。
- **「连不上服务器」只报一次**：连不上的动作不再单独报一条红色，统一归到服务状态（`markService('unreachable')`），聊天区上方只有那一个琥珀色的框。
- **接口服务回来，页面自己恢复**：状态轮询（每 30 秒一次，`/api/status`）发现服务从「连不上」变回「正常」，就重新拉一次会话列表和用户信息（`refreshWorkspace`），不用用户手动刷新页面。

实测（2026-10-31，无头 Chrome 走 DevTools 协议）：在线 → 断掉服务并重新加载页面 → 聊天区上方只有一个「无法连接到服务器，请稍后重试」，没有红色重复提示，用户名还在；服务起来之后提示自己消失，三条会话自己回来了。

## 2026-10-31 异步接口里的同步数据库调用会卡住事件循环

FastAPI 里 `def`（同步）的接口跑在线程池里，不占事件循环；但 `async def` 的接口里直接写 `with db_session()`，整个事件循环就被卡住 —— 卡住的时候，正在流式输出的那一轮发不出去，停止请求也进不来（这就是停止偶尔停不掉的另一半原因）。

本仓库受影响的只有四个异步接口：`/api/chat`、`/api/sessions/{id}/abort`、`/api/sessions/{id}/messages`、`DELETE /api/sessions/{id}`。其余接口都是同步的，没这个问题。

改法：异步接口里碰数据库的那一步放到线程里（`await asyncio.to_thread(_authorize_session, ...)`，`app.py` 里的 `_authorize_session` / `_delete_session_row`）。

实测（2026-10-31，本机 PostgreSQL）：数据库一次查询中位 **0.30 毫秒**，最大 78 毫秒（第一次要开连接）；Redis 一次写入中位 **0.09 毫秒**。所以 Redis 那几处（每轮状态、半截文字）留在事件循环里没问题，数据库那几处值得挪走。改完之后：停止请求从发出到返回 17 毫秒，`/partial` 读到 `aborted`，流里没有 `[DONE]` —— 停止照旧灵。

## 2026-10-31 pnpm 的 store 目录随环境变，沙箱里装的依赖在维护者终端里加不上

在维护者的终端里跑 `pnpm add react-markdown remark-gfm`，报 `ERR_PNPM_UNEXPECTED_STORE`：`node_modules` 现在连的是 `<项目>/node_modules/.pnpm-store/v11`，而 pnpm 想用 `~/Library/pnpm/store/v11`。

不是配置写错，也不是 pnpm 版本对不上：

- 全局没有任何显式配置：项目根、`~`、`~/.config/pnpm/rc` 都没有 `.npmrc`；`pnpm-workspace.yaml` 里只有 `allowBuilds`；`pnpm config get store-dir` 是 undefined。
- 两个 store 都是 v11，机器上两份 pnpm（`~/Library/pnpm/bin` 的 12.16.1、nvm 下用 npm 装的 12.15.0）行为一致。报错里「可能是因为 node_modules 是用另一个大版本 pnpm 装的」这句在这里不适用。

原因是 **pnpm 12 的默认 store 目录是运行时决定的**。pnpm 12.0.0 的变更记录里写着：「When no directory above the project accepts a hard link — inside an AI agent sandbox that only grants write access to the project, or a container with just the project mounted writable — the default store is now created at `<project>/node_modules/.pnpm-store` instead of in the pnpm home directory」（pnpm/pnpm#13525）。pnpm 二进制里也有对应的提示串：「is not used because packages cannot be hard linked from it into this project. Using the store at …」。

也就是说，能不能用 home 里的 store，取决于这台机器上能不能把包从 store 硬链接进项目。在 agent 沙箱里只有工作区可写，home 里的 store 不可写，于是 pnpm 改用项目内的 store。

实测（2026-10-31）：

- 沙箱里对 `~/Library/pnpm/store/v11/index.db` 申请写权限 → `Operation not permitted`；同一个项目内的 store 正常可写。
- 沙箱里 `pnpm store path` 返回 `<项目>/node_modules/.pnpm-store/v11`。这行命令可以当作「当前这个 shell 会用哪个 store」的探针。
- 全局 store 的 `projects/` 里有一个指向本项目的软链（10-29 19:41）——那次是在沙箱外装的，用的是全局 store；随后项目内 store 的 `index.db` 和 `node_modules/.modules.yaml` 都是 10-29 19:46——那次是在沙箱里装的，把 `node_modules` 改连到了项目内 store。之后没人重装过。

修法：

1. **在维护者的终端里跑一次 `pnpm install`**：把 `node_modules` 重新连到全局 store。全局 store 里已经有 react@19.3.1、vite@8.3.5、typescript@7.0.2 这些包（索引 435 条），`pnpm-lock.yaml` 和 `package.json` 是同步的（15 个依赖对得上），所以这次基本只是重新硬链接，不改锁文件。这一步不能在 agent 沙箱里跑 —— 沙箱里跑只会又切回项目内 store。
2. **把 store 固定下来**：项目根放 `.npmrc`，写 `store-dir=node_modules/.pnpm-store`，终端和沙箱都用项目内 store，两边一致。代价是仓库多一个文件、失去跨项目共享缓存。`.gitignore` 里已经有 `.pnpm-store/`，这个布局本来就是预期的。
3. **明确指定全局 store**：`pnpm config set store-dir ~/Library/pnpm/store --global`。这样在沙箱里跑 pnpm 会直接报错，而不是静默换 store；代价是沙箱里彻底装不了依赖。

给 agent 的约束：**装依赖这步只能由维护者做**。只要在沙箱里装过一次，`node_modules` 就连到了项目内 store，维护者下一次 `pnpm add` / `pnpm install` 就会碰到这个错。在 store 目录固定下来之前，agent 不要跑 `pnpm install` / `pnpm add`。

另外 `react-markdown` 和 `remark-gfm` 两个 store 里都没有，装它们需要联网。

## 2026-10-31 助手回答改成渲染 Markdown

以前助手回答整段当纯文本显示，`**加粗**`、标题、列表、表格全是原样。现在用 `react-markdown` + `remark-gfm` 渲染（表格、删除线、任务列表这些 GFM 的写法也认），样式写在 `src/components/chat/markdown.css`。

实测出来的几点：

- **原始 HTML 不会被执行**。`react-markdown` 默认不解析 Markdown 里的 HTML，`<div>…</div>` 会当文字显示出来，和以前一样，页面不用自己转义。
- **地址只放行一部分协议**：http、https、irc、ircs、mailto、xmpp 和相对地址。其余的（`javascript:`、`data:` 这些）在渲染前就被清空了。
- **图片不去加载**。`![](…)` 渲染成一个链接文字，页面不去请求第三方地址。图片生成那部分还没开放，先不给页面开这个例外，代码里标了 TODO（`src/components/chat/MarkdownText.tsx`）。
- **转换器会在块与块之间插换行**，这些换行在 `white-space: pre-wrap` 下会变成空行，列表里尤其明显（一项和下一项之间空出小半屏）。所以 Markdown 容器用 `white-space: normal`，只有段落和纯文本的列表项用 `pre-wrap`，含子块的列表项（带子列表的那种）改回 normal。
- **助手回答的气泡从 `<p>` 换成 `<div>`**：`<p>` 里不能放列表、表格这些块级元素。
- **包不小**：加上这两个依赖，产物里的 js 从 278 kB（gzip 85 kB）涨到 441 kB（gzip 134 kB）。

## 2026-10-31 公式要另外一层：remark-math + rehype-katex

Markdown 里没有公式。`$a^2 + b^2 = c^2$` 这种写法，Markdown 只会当普通文本显示。现在加 `remark-math`（认出 `$...$` 和 `$$...$$`）和 `rehype-katex`（用 KaTeX 排版）。

实测出来的几点：

- **KaTeX 的样式可以直接在 `src/index.css` 里 `@import 'katex/dist/katex.min.css';`**：Tailwind v4 能解析包里的路径，不用改 `tsconfig.json`。
- **公式写错不会让页面崩溃**。`rehype-katex` 自己捕获 KaTeX 的报错，改用宽松模式再排一次，出错时把原文显示出来；我们把 `errorColor` 设成 `currentColor`，出错时颜色跟正文一样，不会变成一片红。
- **`$` 会被消耗掉**：中文回答里写「$5 和 $10」这种价格，`remark-math` 会把中间那段当成公式，美元符号消失、公式按数学字体显示。这是这套东西的固有毛病，改不掉（要避开只能不用单美元符号的公式，我们上游正是用单美元符号写的）。
- **流式输出时公式会跳一下**：公式没写完的时候前半段按普通文字显示，闭合的 `$` 到了才变成公式。
- **体积**：js 从 441 kB（gzip 134 kB）涨到 716 kB（gzip 217 kB），css 多 23 kB。dist 里还会多出 KaTeX 的字体文件（20 个字体、woff2/woff/ttf 三份加起来约 800 kB），浏览器实际只下载用得上的那一两个 woff2。`pnpm build` 会提示 chunk 超过 500 kB。
- **行内公式的字号调小了一点**：KaTeX 自带样式把行内公式放成 1.21 倍字号，我们在 `src/components/chat/markdown.css` 里改成 1.05 倍，跟正文齐平。

对着真部署的「测试版本」会话验过：第三条回答里的 `$a^2 + b^2 = c^2$`、`$a$`、`$b$`、`$c$` 都排出来了，没有报错元素。

## 2026-11-02 Starlette 的 multipart 大小限制管不着上传的文件

做头像上传时查出来的：`starlette/formparsers.py` 里的 `max_part_size`（默认 1 MB）只管普通表单字段，不管上传的文件。文件那一份是写进 `SpooledTemporaryFile` 的，超过 1 MB 就落到临时文件上，没有上限。

所以「Starlette 默认限制上传 1 MB」这种说法不成立。要给上传的文件限大小得自己定：我们读文件时只读上限加一的字节，超了直接退回去（`server/src/server/avatar.py`）。

## 2026-11-02 部署的 Redis 只放行 `h2botapp-chat:*` 前缀，新键空间会静默失效

给改密接口做失败限流时实测出来的：应用连的 Redis 用户是 `h2bot_app`，它的 ACL 只授权了 `h2botapp-chat:*` 这一个键前缀——

- `h2botapp-chat:ratelimit:password:x` → 放行（SET/GET/INCR/EXPIRE/DEL/SCAN 都可以）；
- `h2botapp-ratelimit:password:x`、`h2botapp:x`、裸键 → 一律 `NoPermissionError: No permissions to access a key`；
- `ACL WHOAMI` / `ACL GETUSER` 也被禁了：应用侧**没法自查自己有哪些权限**，只能像上面这样一个前缀一个前缀试。

**问题就出在「静默」两个字**：`NoPermissionError` 是 `RedisError` 的子类，所以凡是照 `reply_store` 那套「Redis 不通就放行并记警告」降级写法的功能，碰到 ACL 拒绝时不会报错、不会 500——功能直接失效，只有日志里每条请求多一段警告栈。限流第一版就是这么全军覆没的：连错 5 次旧密码，第 6 次照旧放行，表面上接口一切正常。

所以规矩是：**新的 Redis 键空间一律挂在 `h2botapp-chat:` 前缀底下**（维护者确认过：这个前缀指的是整个项目，不是只有聊天那一个动作），要另起前缀就得先请维护者放开 ACL。限流键现在是 `h2botapp-chat:ratelimit:{scope}:{identifier}`（`server/src/server/ratelimit.py`）。这条规矩也写进了 [server/AGENTS.md](../server/AGENTS.md) 的「边界」一节。

顺带：验收这类「Redis 不通就放行」的降级路径时，降级被触发这件事本身要从日志里主动确认一遍，不能只看接口返回——接口返回正常恰恰可能是降级路径在处理错误。

## 2026-11-03 zxcvbn-ts 的中文字典是拼音，收不到无声调的连写

密码强度检测换成 [zxcvbn-ts](https://github.com/zxcvbn-ts/zxcvbn)（Dropbox zxcvbn 的 TypeScript 移植，MIT）。选型时以为「中文支持」是指汉字，实测下来不是：

- `@zxcvbn-ts/language-zh` 里**一个汉字都没有**，全是罗马化拼音。字典来源是 OpenSubtitles 2024（经 OPUS 提供，ODC-BY，再分发要署名——已写进 README）。
- `wordSequences` 那份是无声调拼音（`yi er san si wu`），但 `commonWords` 那份**带声调**（`wǒ`、`nǐ`、`shì`）。用户实际输入的是无声调连写，带声调的条目匹配不上。
- 后果是拼音常见密码评分虚高：不加自定义字典时，`woaini1314`（中文泄露密码榜的常客）被评成 **3 分「强」**，`wodemingzi`、`xiaoming123` 同样是 3 分。`@zxcvbn-ts/language-common` 的泄露密码榜偏西方，也收不到这些。
- 修法：zxcvbn-ts 的 `dictionary` 是 `Record<string, string[]>`，官方支持自定义字典（数组顺序即频率排名）。补一份约 70 条的 `pinyin-common`（woaini、520、1314、mima、xiaoming、wangzherongyao 这类），`woaini1314`/`wodemingzi`/`mima123` 降到「太弱」，`xiaoming123` 降到「弱」。这是给库提供数据，不是自己另写一套评分。
- 简繁体不分：拼音对简繁是同一套（愛/爱 都是 ai），所以一个 zh 包对两边同等有效。

字典体积（`pnpm build` 实测）：core 33 kB、common 435 kB、zh 427 kB、en 1.2 MB，合计约 2.1 MB（gzip 约 1 MB）。全部走动态 import，**首屏包只涨 9 kB**（718.56 → 727.52 kB，gzip 217.31 → 220.02），字典只在打开改密弹窗时才下载。单次 `check` 实测 2 毫秒，每次击键同步算就够，不用 debounce。

顺带一条产品结论：**密码只收不含空格的可打印 ASCII**（维护者定的）。理由和 passphrase 形态的取舍记在 [ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md) 的「注册」一节，这里不重复。zh 字典仍然有用——用户实际会输入的「中文密码」本来就是拼音。

（另：`banana42` 这类 8 位小写加数字，zxcvbn 评「弱」——这是它按猜测次数给的老实判断，不是按长度卡人。原来的手写版本给「一般」是虚高。8 位仍然能过、能用，只是提示老实了。）

## 2026-11-03 LayerFS 的读取和列目录都是分页的，校验脚本必须拼接

`fs.read` 一次调用只回一个窗口（返回体带 `truncated`/`nextLine`），大文件拿到的是前缀。这批做同步校验时没翻页，md5 对不上，差点误判成「main 上的 App.tsx 和 pnpm-lock.yaml 没同步」——实际上文件是完整的，是读被截断了。`fs.list` 同样分页，不拼会漏条目（曾把 `.env.example` 误报成 LayerFS 里不存在）。凡是拿内容做比对的脚本，都要循环读到 `truncated` 为假再算哈希。

## 2026-11-03 LayerFS 的 fs.apply 不能写不存在的目录

往新目录里写文件报 `NoSuchPath`，得先建目录再写。副作用是会产生一个「纯目录、零文件」的提交；git 没有空目录的概念，用 commit-tree 复制时这种提交只能跳过（LayerFS 侧痕迹保留，git 侧提交数比那边少一个，属预期）。

## 2026-11-03 LayerFS 合并提交的父指针跟 git 惯例相反

merge 产生的提交里 `parent` = 源分支 tip，`secondParent` = 合并目标当时的 **layer id**（不是 commit id）；git 惯例正好相反（p1 是发起合并的一侧）。且 `list_commits` 只走 first-parent 链，从合并结果分支看不到 main 一侧的历史。要把 main 的合并链复制进 git，得按发布顺序逐个取合并提交（每个合并结果分支的 head），main 侧的父提交按已知顺序推；publish 输出的 `publishedLayer.id` 与合并 head 一一对应，可用来校验 `secondParent`。

## 2026-11-03 httpx2 的 ASGITransport 只挂 AsyncClient

server 的依赖是 `httpx2`（2.16.0），环境里没有 `httpx` 包。这个版本的 `ASGITransport` 不支持同步 `Client`，进程内接口测试要用 asyncio + `AsyncClient` 写。另外 per-request 的 `cookies=` 参数已被标记弃用（警告归警告，行为还是对的）。

## 2026-11-03 oxfmt 会把「一行多个元素」的数组展开

`password-strength.ts` 是早前版本 oxfmt 写的（`PINYIN_COMMON` 一行多个元素），在当前 node_modules 的 oxfmt 0.75.0 下过不了 `--check`——main 上带了这个失配一段时间，`pnpm check` 一直不通过。2026-11-03 合并批次写进 git 后用 `pnpm fmt` 重排（唯一受影响的就是这个文件；把 diff 的去空白结果逐字符比对过，确认纯排版），单独提交成 style。教训：写完就跑 `pnpm check`，别跨工具版本变动留尾巴。

## 2026-11-03 LayerFS 项目 store 损坏：两条独立访问路径同报 Malformed，1.x 无修复工具，只能重建

症状与证据（本会话实测）：

- 会话的 LayerFS worker 起初没在运行（endpoint.json 缺失）；宿主程序于 15:26 自动启动 `layerfs-worker` 容器，端口映射和 endpoint.json 会自动改写，GUI 重启后容器仍存活。
- worker 起来后，所有项目调用（`project list_branches`、`fs read`，**连不存在的项目名也一样**）在约 5ms 内报 `Failed: Os NotFound`——失败发生在项目查找之前。而 store 卷 `layerfs-aiep-int6137-chatbot-aitutor-store-mvzakkdi` 本身完好：`global/store.sqlite` 114MB、SQLite 文件头有效、最后写入当天 11:53；worker 容器内 bundle、daemon、native 模块、卷内 store 全部可见。
- 按文档允许的 `layerfs init` 做了一次探测，被拒 `Store install: Store destination exists`（未写入数据）；此后 `sandbox create` / `project list_sandboxes` 的报错变为 `Store open: physical Store I/O: pack persistence: Malformed`。无法判定是 init 探测改动了磁盘状态，还是两类调用走到了 open 路径的不同深度。
- **GUI 侧边栏 LayerFS 面板显示一字不差的同一句 Malformed**——它是与会话 CLI 独立的访问路径，但走同一个 worker 和同一个卷。所以损坏在 store 数据本身，**与会话模式无关**（「极简模式」vs「标准模式」）；标准模式会话能看 Work/History，是因为那两页读会话记录，不开项目 store。
- 重启 GUI、重启 worker 容器均无效（数据和卷跨重启存活）。

上游对照（Ephemeral-AI-Lab/layerfs，公开仓库，浅克隆 `35d3657` 核对源码）：

- `PersistenceError::Malformed` 定义在 `core/crates/layerfs-storage/src/port/persistence.rs`，语义是「后端响应违反存储格式的文法或边界」；`Store open:` 前缀来自 `engine/crates/layerfs-store-service`。即打开 store 时读到的 pack/元数据自身不一致——结合先出现的 NotFound，推测是上午会话之后 pack 数据部分丢失，sqlite 元数据引用了不存在或越界的东西。
- 精确短语 `"pack persistence: Malformed"` 在 GitHub 全站 issue 搜索 0 命中，无同款报告。
- **1.x 没有任何修复或部分读取工具**：#511（rm/compact/prune）、#519/#485（只读打开坏 store 抢救数据）均为 open 未实现；#379（pack 写失败后 store 永久拒写）官方结论原话 "The only way out is to … delete the Store"。
- 10月28日前合并的三个 delta 链预算修复（#472/#473/#479）早于本机 worker build（11月2日，`build-linux-222129a2…`），且修的是**写入被拒**侧（Integrity 错误），救不了**打开时** Malformed；最新 tag v1.1.0 正是在用版本——不存在「升级后就能读开」的 build。

结论：这份 store 在 1.x 下不可恢复，只能删掉重建。（**此结论已被下一条更正：store 数据完好，出问题的是项目记录**。）本地目录是当初 init 的源目录、且比 LayerFS 侧更新（新装的 daisyui / tailwind-bootstrap-grid 只在本地），重建的实际损失仅限 LayerFS 侧未同步回本地的历史——store 打不开，无法列出确认有哪些。

## 2026-11-03 macOS 上 `layerfs init` 结构性损坏，重建项目必须走宿主自己的流程

上游 #513（open，2026-10-30）描述与本机实测完全一致：macOS worker 路线下（会话环境带 `LAYERFS_WORKER_ENDPOINT` 等变量），`layerfs init` 即使对全新项目名也报 `Store destination exists`。issue 指出 macOS 上唯一能工作的初始化路径是 `@layerfs/runtime` 的 `project.start_init`（它会预置卷、设置每项目 STORE_PATH），而 CLI 直接暴露 `LayerFS.init`，绕过了这层编排。维护者答复：修复排进 LayerFS 2.0（roadmap #446），当前阶段冻结。

所以规矩是：**不要试图删卷后用 CLI init 手动重建**；重建项目要走宿主图形界面自带的创建入口。相关背景：#534（open）记录了原生 macOS 路线并发 `LayerFS.open` 报 Store busy 等问题，同属「macOS 路线未修完」一族。

## 2026-11-03 更正：坏的不是 store 数据，是「项目记录」；本会话的 init 探测把故障升级了

另一个会话做了只读的深入检查（SQLite 直读 + 源码对照），上一条的诊断要更正三处：

- **store 数据一个字节都没坏**：卷里 `store.sqlite` 的 `PRAGMA integrity_check` 返回 ok、`foreign_key_check` 0 行，22 分支 / 91 提交 / 15 层 / 25,227 对象完好（含 password-backend、console-server、split-findings 等真实开发分支）。`Malformed` 不是数据损坏，是**身份校验拒绝**：open 时用 `project.record` 里的 binding 去比对 store 存的 `binding_key`/`catalog_id`（`schema.rs` 的 `validate()`），不等就报 `Integrity` → 打印成 `pack persistence: Malformed`。
- **丢的是 home 目录里的项目记录**。时间线：~12:36 macOS 清理重建了 `tmpdir`，旧 `project.record` 随之丢失——这才是 15:25 起 `Os NotFound` 的真正原因（记录引用的 home 侧 sealed store 文件不存在）；**15:35 本会话跑的 `layerfs init` 探测生成了新的随机绑定密钥并写入新记录**，而「装进卷」一步被拒（`Store destination exists`），于是记录和卷里的老 store 成了两套身份，15:37 起每次 open 都被拒。上一条里「无法判定 init 探测是否改动了磁盘状态」现在确认：改了，而且是故障形态从「缺记录」（插件有 `noRecord` 分支可识别）恶化成「记录与 store 不匹配」（难以识别）的转折点。
- **「不可恢复」不成立**：老 store 可以用官方恢复脚本（restore-store，配合 `LAYERFS_READER` 环境变量）只读导出；但老记录里随机生成的 `cursor_key` 只存在于丢失的那份记录里，「把老 store 原样接回」缺一块拼图。干净路径仍是走宿主的 remove（删卷 + 删记录）再重新 Import。

规矩升级：**macOS 上任何情况下都不要再跑 `layerfs init`**——即使安装被拒它也会写入新记录和新绑定密钥，主动制造身份错配。上一条的「不要删卷后 CLI init 手动重建」从「走不通」升级为「有害」。

根源是插件的持久/易失不对称：绑定和 store 卷是持久的，而 home（`config.js` 默认落在系统临时目录下的固定子目录）会被 macOS 系统清理——记录和 store 生命周期不一致。先控制住问题的方案是给 layerfs-host 配稳定 home 路径（`config.js` 支持 `home` 键，指到用户主目录下的固定目录），改动在宿主的 profile 配置里做。

## 2026-11-03 LayerFS store 已恢复；沙箱里 pnpm/tsc/vite 可用——前提是 node_modules 按 Linux 重建

傍晚另一个会话把老 store 救了回来（22 分支 / 91 提交重新可读；修复发生在记录层，数据本体从头到尾没坏，诊断见上一条）。当时本地 git 领先 LayerFS 8 个提交，同步回去按下面流程走完，可复现：

1. **diff**：117 个 git 跟踪文件逐个从 main 分页读出（`fs.read` 带 `nextLine` 循环，pnpm-lock.yaml 超过单窗口 48KiB）、md5 对比本地——差异集恰好是 8 个提交涉及的 32 个文件，无缺失；
2. **重放**：fork 分支 `daisyui-migration`，把 8 个 git 提交逐个 `fs.apply` 上去（每个文件的内容取 `git show <hash>:<path>`，提交信息照抄，FINDINGS.md 两步演进这类中间态也保留）；
3. **复验**：对分支重跑第 1 步的 diff，117/117 零差异才继续；
4. **沙箱构建**：node_modules 按 Linux 重建后验证 `tsc --noEmit` 和 `vite build`（见下）；
5. **发布**：`branch publish` 更新 main，抽查关键文件收尾。

**更正一个流传的旧结论**：「LayerFS 内所有的 uv run 以及 pnpm 命令都不可用」不成立（前端这半被实测证伪）。真正的问题是 **store 里的 node_modules 是从 macOS 导入的，原生二进制全是 darwin 的**：TypeScript 7 的原生 tsc 要 `@typescript/typescript-linux-arm64`，vite 8（rolldown）和 Tailwind v4（oxide）同理，所以沙箱里直接跑会报 `Unable to resolve @typescript/typescript-linux-arm64`。命令本身没问题——在沙箱里 `rm -rf node_modules && CI=true pnpm install --frozen-lockfile` 重建后，实测 `tsc --noEmit` exit 0、`vite build` 487ms 通过。重建后的树已提交并随 publish 进了 main，之后的沙箱挂载即可直接构建。（后端 `uv run` 这次没测，那半个结论既不成立也不被证伪。）

重建过程遇到的三个具体问题：

- **增量安装不补平台包**：在既有 darwin 树上直接 `pnpm install --frozen-lockfile`，5.9 秒报 Done，但 Linux 平台包依然缺——pnpm 认为树是最新的，跳过了平台可选依赖。必须 `rm -rf node_modules` 全量重建（重建只要 3.9 秒，镜像里有热缓存）。
- **npm 不能在 pnpm 树里跑**：npm 11 在项目根 `npm i` 会报 `EUNSUPPORTEDPROTOCOL "catalog:"`——它扫描现有 node_modules 树时读到了 pnpm 的 `catalog:` 协议残留，`--no-save` 也躲不开。要用 npm 就在隔离目录装（`/tmp` 下 `npm init -y` + `npm i`，再把包目录 `cp -R` 回来），或者直接用 pnpm。
- **沙箱生命周期**：最后一个 workspace 卸载 2 分钟后沙箱自动关闭，再调用报 `NoSuchSandbox`，重新 `sandbox create` 即可；镜像里自带 pnpm 11.28.5（本机是 12.16.1），lockfileVersion 9.0 两者都认；沙箱有外网（npm registry 可达，实测 4 个包 1 秒装完）。

## 2026-11-06 生产环境 Redis 的 ACL 不放行脚本命令，原子抢占改用 SET … GET

要把「单轮抢占」做成一个原子动作，先按常规用了 Lua 脚本（redis 包的 `register_script`，走 EVALSHA）。在真实环境一跑：`NoPermissionError: User h2bot_app has no permissions to run the 'evalsha' command`——生产环境 ACL 只放行了键前缀 `h2botapp-chat:` 和业务用得到的那批命令，脚本命令不在内（连 `info` 都不放行，版本号都问不出来）。更糟的是按「Redis 不通就放行」的降级设计，脚本失败会静默降级：单轮守卫整个失效，冒烟实测同一场会话同时发出两轮全部放行、上游真的生成了两遍。

修法：抢占改成 `SET 状态键 streaming EX ttl GET` 单命令——写入新值的同时原子拿回旧值，旧值是 `streaming` 就是没抢到；`set`/`get`/`del`/`scan`/`expire`/`append` 都在 ACL 放行范围内（现有代码一直在用，逐个是在真实环境验证过的）。`SET … GET` 要求 Redis 服务器 ≥ 6.2（生产环境 8.10.2 实测可用）。

教训：**在这个项目里用任何没先用过的 Redis 命令，先拿真实用户试一次**——ACL 的命令白名单应用侧看不到（`info`、`acl` 都被拒），只有试了才知道；而且「失败即放行」的降级设计会把这类错误藏成静默的功能消失，冒烟测试必须盯日志里的降级警告。相关代码：`server/src/server/reply_store.py` 的 `claim_round`。
