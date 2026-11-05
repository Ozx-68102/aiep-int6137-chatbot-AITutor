# 聊天页面行为

聊天页面现在是怎么动的：滚动、等待气泡、输入、轮询、超时重试、错误边界、读屏、会话过期。写于 2026-11-05，描述现状。

分工：流协议与轮次生命周期（四种帧、停止、重试的协议面、刷新续传的服务器侧）见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)；气泡脚注的操作矩阵（失败/被停提示与重试按钮、编辑重发、复制、点赞点踩）见 [MESSAGE_ACTIONS.md](MESSAGE_ACTIONS.md)，本文只写页面级行为；提示放哪里、什么颜色见 [UI_WARNINGS.md](UI_WARNINGS.md)。

## 滚动跟随与回到底部

[ChatMain.tsx](../src/components/chat/ChatMain.tsx) 的消息滚动容器：

- **距底 48px 以内算贴底**。贴底时内容变化自动滚到底（流式回答往下长，视口跟着走）；用户往上滚就停止跟随。
- 不贴底时露出悬浮的「回到底部」圆钮（`btn btn-circle btn-ghost` + lucide `ArrowDown`，`aria-label`/`title` 用 `backToBottom` 键）。点击一步滚到底——不用平滑滚动，平滑滚动的中间状态会把贴底判定又打回去。
- 切换会话时 App 用 key 把 ChatMain 整个重挂载，贴底状态自然复位。

## 等待气泡与进度显示

等回答时的三个点气泡（[ThinkingBubble.tsx](../src/components/chat/ThinkingBubble.tsx)）：

- 气泡本身 `role="status"`，读屏播报「正在思考」（`aria-label`）。
- **进度显示上游节点名原样**：`event: progress` 帧带来的工作流节点名直接显示在气泡下方，不做映射表、不配三语文案（2026-11-05 维护者拍板：受众是香港本地小三学生，繁体节点名对他们本就合适；节点名好不好懂归工作流搭建方负责）。首个进度事件到达前维持「正在思考」。
- 进度文本按会话记在 `progressBySession`（[use-turn-engine.ts](../src/hooks/use-turn-engine.ts)），只显示当前会话最新的一个节点名。清空时机：首个内容增量到达（进度完成使命）、流结束（五种结局都一样）、发送流程的 finally——清空是幂等的，本来就没有时返回同一份引用，不触发重渲染。
- 进度文本 `aria-hidden`：只做视觉展示，读屏维持只播「正在思考」，不随节点名变化反复播报。

## 输入

- **输入上限 8000 字**：提问框和编辑重发的编辑框都挂 `maxLength={8000}`；后端 `ChatRequest.message` 的 `Field(max_length=8000)` 对齐，超长的请求 422 回一句中文（不会静默截断）。密码类字段的 128 上限是另一回事，见 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)。
- 多行输入：提问框是自动增高的 textarea，Enter 发送 / Shift+Enter 换行，`isComposing` 防中文输入法组合期的回车误发；编辑框同一套按键（Enter/「发送」发出、Shift+Enter 换行、Esc 取消）。

## 未发送内容缓存

sessionStorage 的 `h2bot-unsent`（[src/session/unsent.ts](../src/session/unsent.ts)）：

- **被踢时存**：401 回整页登录路径（`enterLogin`）时，输入框里正打到一半的字存进去；发送没成功（409「这场对话还有一条正在回答」等）时，那条问题也存进去。
- **登录放回**：登录成功（`openAccount`）把存的话放回输入框，放回就消费掉（清缓存），不带去再下一次登录。原地重登录时输入框里的字本来就留着，没有存句就不动它。
- **主动退出清掉**：退出登录（signOut）成功之后清缓存——自己走的，不该留。

## 轮询与断线补查

- **续传轮询 500 毫秒**一拍（[src/session/poll.ts](../src/session/poll.ts) 的 `startPartialPolling`）：问服务器「还在写吗」。200 → 把半截文字应用到页面、接着轮；**404 和 401 都是终止条件**（onEnd 带上那个 ApiError，调用方分开处理「这一轮没在写了」→ 对账数据库，和「会话过期」→ 统一的 401 出口）；网络错继续下一拍——问不到服务器不等于没在写。
- **后台标签暂停**：页面切到后台（`document.hidden`）不发请求、光等；回到前台立刻补查一次，不等下一拍。
- **断线补查**：`window online` 事件和 `visibilitychange` 回可见时，对每个还在等回答的会话挨个补查一次线程（`refreshThread`，里面带着续传逻辑）；**跳过本页正在流式的会话**——那场让流自己收尾，别在这儿换掉消息列表（[use-turn-engine.ts](../src/hooks/use-turn-engine.ts) 的 catchUp）。
- **兜底定位键**：从上游回填的老会话消息可能没有轮次编号。waiting 消息没有 turnId 时，轮询用 `message.id` 当定位键（只认还在等待中的那条），续传不再静默失效（`applyPartialText` 的 fallbackKey 分支）。
- 服务器侧 `/partial` 的收窄语义（200 只回 streaming、其余一律 404）和 `probePartial` 三态见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「刷新续传与断流恢复」。

## 超时与重试

- **普通请求超时 15 秒**；FormData（头像上传）放宽到 60 秒（[src/api/http.ts](../src/api/http.ts)，`AbortSignal.timeout`）。超时被包成 `ApiError(0, null)`，落进「连不上」的既有降级路径。
- **流式对话请求没有总超时**：上游整块返回，一轮实测可达 23 秒，15 秒的总超时套不上去；连接断了靠断流恢复流程（问「还在写吗」再对账）。
- **非幂等请求不自动重试**：只有 GET 默认自动重试（4 次、间隔 300 毫秒）；POST/PATCH/DELETE（建会话、登录、停止、重命名、置顶）连接断了再盲发一次可能做出两份，默认只跑一次，调用方明确知道能重发时才传 `retry: true` 打开。
- 对话流自己的重发规则（只有服务器明确说「没在写」才带同一个轮次编号重发一次）是协议面的事，见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「重试与编辑重发」。

## 错误边界与降级

- **单条消息**：[BubbleBoundary](../src/components/chat/BubbleBoundary.tsx) 包住每条消息的渲染。一条消息渲染炸了（Markdown/KaTeX 管线、组件定制抛错），那一条降级成纯文本气泡（原文照显），其余消息照常——不再整页白屏。
- **整页**：[PageBoundary](../src/components/shell/PageBoundary.tsx) 包住 App 根部。非消息区域炸了给整页降级：「页面出了点问题」（`pageError` 键）+「刷新页面」（`refreshPage` 键）按钮。

## 读屏行为

- **消息滚动容器 `role="log"`，不挂 aria-live**：log 语义就是「追加式消息记录」，浏览器对新增内容有默认的礼貌处理；早先整个大容器挂 `aria-live="polite"`，流式期间每个 chunk 都触发播报，读屏用户基本没法用。容器带 `aria-label`（会话标题）和 `aria-busy`（这一轮在写时为真）。
- **独立的 sr-only status 区只报「正在思考」**：本会话有等待中的回答时报，空闲时为空——读屏播报收窄到这一处里程碑，不逐字播。
- 等待气泡自身 `role="status"`；进度节点名 `aria-hidden`（见「等待气泡与进度显示」）。

## 会话过期原地态

会话类 401 现在带 `reason` 字段（词表和后端实现见 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)「401 带原因」）。页面这边（[App.tsx](../src/App.tsx) 的 `handleAuthError`）：

- **进入条件**：auth 是 ready 时收到带 reason 的 401 → 进「会话失效」原地态（`sessionInvalid`：expired 或 disabled）。不带 reason 的 401（老后端）保守回退整页 `enterLogin` 路径；checking/anonymous 阶段的 401 照旧走整页登录屏。
- **原地态保留什么**：会话列表、消息、草稿、profile 缓存全部原样不动；输入区禁用（`inputLocked` 把 `sessionInvalid` 算进去）；输入区分隔线上方挂**常驻警示条，不可关闭**——expired 用琥珀的「有状况」语气 + 「重新登录」按钮（`logInAgain` 键），disabled 用红色出错语气、不给按钮（终态，登录也没用）。白底黑字、语义色只在图标上（[UI_WARNINGS.md](UI_WARNINGS.md) 的颜色规则）。
- **就地重登录**：Modal 里嵌 LoginScreen 同款卡片，不清聊天页的任何状态；登录失败弹窗不关、错误留在表单里；成功走 `openAccount` 原地恢复——`resetForLogin` 把上一个登录态的在飞请求、轮询和「线程已加载」标记一次清掉，`bumpThreadRetry` 让当前会话的历史重新拉（activeId 和 auth 都没变，线程加载效果只能靠 retry 计数重新触发），然后清 `sessionInvalid`、关弹窗。
- **其余动作的 401 出口**（侧栏、设置、改密、服务状态恢复）走 `enterLoginGuarded`：已经在原地态里时不再升级成整页清空——横幅已经挂着了，清空反而把原地态保住的东西弄丢。
- **断线补查的 401**（轮询撞 404 后、网络恢复、重试前的 `refreshThread`）走统一的 `onAuthError` 出口：会话已过期就进原地态，不再被静默吞掉。
- 触发靠「下一次请求吃到 401」，不是服务器主动推：`/api/events` 推送通道未做（[ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md)「会话状态通道」backlog）。

## SSE 解析器（前端）

[src/api/chat.ts](../src/api/chat.ts) 的解析器按 SSE 规范写（帧语义见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「流里的四种帧」）：

- 事件边界同时认 `\n\n` 和 `\r\n\r\n`（CRLF）。
- 同一事件里多条 `data:` 行先按规范用 `\n` 连成一帧解析；连起来解析不出来时退回逐行认——坏的行丢掉，其余的行（可能正是 `[DONE]`）照常处理。**一帧坏 JSON 只拖累它自己。**
- 命名事件按名处理：`progress` 解析成节点名 + 状态词，`done` 解析成结局（字段任何一个不合就整帧忽略——宁可没收到结局，不能解出一个错误的结局）；未知命名事件的 data 整帧忽略（给将来别的命名事件留位）；注释帧（`: ping` 心跳）只认 `data:`/`event:` 行，天然被忽略。

## 进场动画的 id 集合

消息进场动画的追踪集合 `enteringIds` 是 `Set`（查询 O(1)），`markEntering` 时同时挂一个 **500 毫秒的兜底超时清理**（幂等）：正常由 `onAnimationEnd` 移除；气泡在动画结束前就被删掉时（重发去掉旧回答、发送没成功整轮回滚），`onAnimationEnd` 不会再来，超时清理保证 id 不会永远漏在集合里。`prefers-reduced-motion` 的用户不加 id，没有这个问题。

## 已知限制

- **`probePartial` 把 401 归为 unreachable**：流断了去问「还在写吗」时如果会话已过期，401 被归进「问不到服务器」，走连接警示横幅而不是会话过期原地态。等推送通道落地时再认 reason。
- **原地态里侧栏/设置操作的 401 静默失败**：`enterLoginGuarded` 保证不清页，但那些操作本身也没成功，用户看不到单独的解释（横幅是共用的那条）。
- **`/password` 页提交吃到 401 无可见反馈**：会话过期原地态的提示在聊天页，独立路由的改密页收不到；提交失败只留在表单错误里，不说「会话已过期」。
- **多标签页登录态不同步**：一个标签页退出/改密，另一个要等下一次请求吃 401 才知道。等推送通道。
- **滚动跟随只看消息列表和编辑框文本**：纯高度变化（高亮懒加载迟到、KaTeX 排版完成、思考气泡进度文本）不会重新触发贴底判定，已贴底时跟随可能悄悄脱钩；「回到底部」按钮仍可用。
