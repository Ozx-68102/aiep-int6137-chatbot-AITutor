# 聊天页面行为

聊天页面现在是怎么动的：滚动、等待气泡、打字机播放、新会话欢迎语、输入与草稿、轮询、超时重试、错误边界、标签页标题、多标签页同步、读屏、焦点、会话过期。写于 2026-11-05，2026-11-06 随前端四批更新，描述现状。

分工：流协议与轮次生命周期（四种帧、停止、重试的协议层面、刷新续传的服务器侧）见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)；气泡脚注的操作矩阵（失败/被停提示与重试按钮、编辑重发、复制、点赞点踩）见 [MESSAGE_ACTIONS.md](MESSAGE_ACTIONS.md)，本文只写页面级行为；提示放哪里、什么颜色见 [UI_WARNINGS.md](UI_WARNINGS.md)。

## 滚动跟随与回到底部

[ChatMain.tsx](../src/components/chat/ChatMain.tsx) 的消息滚动容器：

- **距底 48px 以内算贴底**。贴底时内容变化自动滚到底（流式回答往下长，视口跟着走）；用户往上滚就停止跟随。
- 不贴底时露出悬浮的「回到底部」圆钮（`btn btn-circle btn-ghost` + lucide `ArrowDown`，`aria-label`/`title` 用 `backToBottom` 键）。点击一步滚到底——不用平滑滚动，平滑滚动的中间状态会把贴底判定又打回去。
- 切换会话时 App 用 key 把 ChatMain 整个重挂载，贴底状态自然复位。

## 等待气泡与进度显示

等回答时的三个点气泡（[ThinkingBubble.tsx](../src/components/chat/ThinkingBubble.tsx)）：

- 气泡本身 `role="status"`，读屏播报「正在思考」（`aria-label`）。
- **进度显示上游节点名原样**：`event: progress` 帧带来的工作流节点名直接显示在气泡下方，不做映射表、不配三语文案（2026-11-05 维护者决定：受众是香港本地小三学生，繁体节点名对他们本就合适；节点名好不好懂归工作流搭建方负责）。首个进度事件到达前维持「正在思考」。
- 进度文本按会话记在 `progressBySession`（[use-turn-engine.ts](../src/hooks/use-turn-engine.ts)），只显示当前会话最新的一个节点名。清空时机：首个内容增量到达（进度完成使命）、流结束（五种结局都一样）、发送流程的 finally——清空是幂等的，本来就没有时返回同一份引用，不触发重渲染。
- 进度文本 `aria-hidden`：只做视觉展示，读屏维持只播「正在思考」，不随节点名变化反复播报。

## 打字机播放

上游的答案整块到达（根本原因见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「上游整块返回答案」），页面拿到全文后把「本轮刚收到」的回答渐进播放出来（[TypewriterText.tsx](../src/components/chat/TypewriterText.tsx) 包住既有的 [MarkdownText.tsx](../src/components/chat/MarkdownText.tsx)；2026-11-05 立项、2026-11-06 实施）：

- **登记与参数**：轮次引擎在本轮流的第一个内容增量到达时把消息 id 登记进 `presentIds`（[use-turn-engine.ts](../src/hooks/use-turn-engine.ts) 的 `onDelta` 里登记，不等 done 帧——done 帧到达时全文已经渲染过一帧，晚登记会先显示全文再倒回播放）。播放每个周期 60 毫秒；目标总时长 = clamp(文本长度 × 15 毫秒, 1 秒, 3 秒)——短文至少放 1 秒、长文封顶 3 秒（越长显示得越快，速度自适应），折算成周期数后夹在 17~50。每个周期的字数 = ceil(全文长度 / 周期数)，每个周期按最新全文重算：上游分块到达、播放中文本变长时，剩余内容仍按原周期数显示完。周期数封顶 50 也就是 MarkdownText 重解析次数的上限，累计解析量远低于掉帧量级——这是「按块输出＋节流」的取舍理由，requestAnimationFrame 级合并批次没做（渲染合并批次两条仍搁置）。
- **只播放本轮新收到的回答**：历史消息、刷新恢复、断线补回的回答根本不进 `presentIds`，天然立即全部显示；被停半截的也一样——轮次以停止、失败、断流收场时引擎注销登记，`present` 撤销直接从 props 派生（不走状态翻转），变 false 的这一帧立刻全部显示、定时器停掉。`prefers-reduced-motion` 的用户不播放，直接全部显示。
- **每条消息只放一次**：模块级 `everStarted` 集合保证跨组件重挂载成立（切会话会整棵重挂载 ChatMain，回来不重播）；只存内存，刷新页面即清空——刷新恢复的回答本来就不播放。播放收尾之后文本再变长（上游分块、极罕见）直接全部显示，不二次播放。
- **读屏与全文操作**：播放中渐显层 `aria-hidden`，另配一个 sr-only 全文节点——读屏一次拿到全文，不逐字播报；播放结束两层撤掉，DOM 与不播放时一致。`message.text` 状态自始是全文：复制、点赞点踩、错误边界的降级文本拿到的都是全文，播放只是视觉层。
- **滚动跟随衔接**：每个周期气泡长高而消息数组不变，既有的滚动跟随效果指望不上；`onReveal` 每个周期回调滚动容器，查 `atBottomRef`——贴底就持续跟随，用户上滚即停（见「滚动跟随与回到底部」和「已知限制」）。

## 新会话欢迎语

空会话里合成的「第 0 轮」assistant 气泡（2026-11-06 维护者决定）：

- **显示条件**：只在「还没有任何消息」的会话视图里显示——新对话（composingNew），或消息列表已知为空（messagesKnown 且消息为空）。历史加载期间（messagesKnown 为 false）不显示，防止欢迎语先出现、历史加载后又消失的闪烁。
- **首条消息发出即退场**：第一条消息发出后欢迎气泡随即消失。有历史消息的旧会话永不显示，不追溯。
- **纯前端合成气泡**：不进 `message` 表、不进 POST /api/chat 请求、不进上游上下文；气泡不带 MessageActions 操作行（复制、点赞点踩等一概没有）。
- **文案逐字跟随上游**：固定繁中，逐字取自上游应用配置 `chatConfig.welcomeText`，不随界面语言本地化。我们没有读 chatConfig 的接口，所以是前端把上游那段文字原样固定下来（上游事实——欢迎语在应用配置里、不是聊天记录——见 [FASTGPT_API.md](FASTGPT_API.md)「杂项」对应条目）。
- **取代原空态占位**：原先没有消息时显示的 `text.empty` 空态占位词条（三语）随之下线，已从词表删除。

## 输入

- **输入上限 8000 字**：提问框和编辑重发的编辑框都挂 `maxLength={8000}`；后端 `ChatRequest.message` 的 `Field(max_length=8000)` 对齐，超长的请求 422 回一句中文（不会静默截断）。密码类字段的 128 上限是另一回事，见 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)。
- 多行输入：提问框是自动增高的 textarea，Enter 发送 / Shift+Enter 换行，`isComposing` 防中文输入法组合期的回车误发；编辑框同一套按键（Enter/「发送」发出、Shift+Enter 换行、Esc 取消）。
- **等回答时可以继续打字**（2026-11-06）：流式期间输入框不再禁用（`inputLocked` 只算「新会话建立中」与会话过期后留在原页面的状态）。这一轮进行中（pending）且输入为空时发送位显示停止按钮；有字（trim 后）时换成**禁用的发送按钮**，外壳 span 挂悬停浮层「请等待 AI 回答完毕」（`waitForReply` 键，三语）——disabled 按钮不接收鼠标事件，浮层挂外壳、按钮加 `pointer-events-none`；触屏（`(hover: none)` 命中）点按外壳弹同款 toast。pending 期间按 Enter 不发送，弹同一句提示（选「给提示」而不是静默：框里正打着字，静默会像键盘坏了）。清空输入，停止按钮回来。发送仍锁到本轮结束（`sendLocked`），打的字随按随写进该会话草稿（见下节）。
- **移动端**（2026-11-06）：底部输入条 padding-bottom 取 `max(1rem, env(safe-area-inset-bottom))`，配合 [index.html](../index.html) viewport meta 的 `viewport-fit=cover`，iPhone 刘海屏/横屏下发送按钮不再贴进圆角；气泡窄屏 `max-w-[85%]`、md 断点起维持 600px 上限（[message-class.ts](../src/components/chat/message-class.ts)）；输入框 `text-base`（16px）防 iOS 聚焦缩放（随多行输入实施）。

## 未发送内容缓存与按会话草稿

sessionStorage 的 `h2bot-unsent`（[src/session/unsent.ts](../src/session/unsent.ts)）：

- **被强制下线时存**：401 回整页登录路径（`enterLogin`）时，输入框里正打到一半的字存进去；发送没成功（409「这场对话还有一条正在回答」等）时，那条问题也存进去。
- **登录放回**：登录成功（`openAccount`）把存的话放回输入框，放回就消费掉（清缓存），不带去再下一次登录。在原页面重新登录时输入框里的字本来就留着，没有存句就不动它。
- **主动退出清掉**：退出登录（signOut）成功之后清缓存——自己走的，不该留。

按会话草稿（2026-11-06，[src/session/drafts.ts](../src/session/drafts.ts)）：

- **各存各的**：sessionStorage 键 `h2bot-draft:{sessionId}`，「新对话」用固定键 `h2bot-draft:new`（键名风格对齐 `h2bot-unsent`）。按键即写、刻意不做防抖——sessionStorage 同步写开销可忽略，还省掉「切会话/卸载时何时 flush」的时序问题（依据写在代码注释里）。存不下（隐私模式、配额满）静默放弃，草稿丢了不阻塞输入。
- **恢复落点**：切会话（`showSession`）、开新对话（`showNewChat`）读各自的键；刷新/深层链接后由 `claimPath` 认领状态，它的三个落点（回根路径开新对话、地址里的会话 id 找不到、按 id 找到会话）各读各的草稿。离线启动保底处理那段也读新对话草稿。**unsent 恢复优先于草稿**：被强制下线、繁忙回填存下的句子不能丢，没有存句才用草稿。
- **清理时机**：发送成功清对应键（新会话首问和普通发送两条路径都 `clearDraft`）；主动退出登录 `clearAllDrafts()` 清空全部草稿，其他标签页收到登出标记时也各自清空自己的（共用电脑不留半截字，对齐 `clearCachedProfile` 的隐私处理；sessionStorage 按标签页隔离，各页只能清自己的）；被强制下线不清——重登录后草稿原样恢复。旧的 `rememberDraft` 单槽机制已删除。
- 分工：`h2bot-unsent` 管「已提交但没送达」，草稿管「输入框里正打着的字」，两回事。

## 轮询与断线补查

- **续传轮询每个周期 500 毫秒**（[src/session/poll.ts](../src/session/poll.ts) 的 `startPartialPolling`）：问服务器「还在写吗」。200 → 把半截文字应用到页面、接着轮询；**404 和 401 都是终止条件**（onEnd 带上那个 ApiError，调用方分开处理「这一轮没在写了」→ 核对并修正数据库，和「会话过期」→ 统一的 401 出口）；网络错继续下一个周期——问不到服务器不等于没在写。
- **后台标签暂停**：页面切到后台（`document.hidden`）不发请求、光等；回到前台立刻补查一次，不等下一个周期。
- **断网即时感知与恢复确认**（2026-11-06 改写，[use-service-status.ts](../src/hooks/use-service-status.ts)）：`offline` 事件立即挂既有的服务横幅（`unreachable` 档、`connectionRetry` 文案），不用等最坏 30 秒的下一个周期。`online` 不轻信——网卡通了不代表服务器可以连通——主动探测 `GET /api/status` 确认，失败按 1s/2s/4s…封顶 15s 指数退避重试；世代编号（`confirmGeneration`）作废旧的确认循环：offline 和新的 online 都把世代编号加一，不会出现两条确认循环并存；`navigator.onLine` 为假时暂停、等下一次 online。确认进行期间，常规 30 秒周期与可见性补查都让路——同一时刻只有一条探测链在请求 `/api/status`。确认成功后先 `clearTimeout` 再同步重挂 30 秒定时器（倒计时清零，任何时刻只有一个定时器），并广播 window 事件 `h2bot:network-ok`（[poll.ts](../src/session/poll.ts) 导出的 `networkOkEvent`）。
- **恢复时合并会话列表，不整份替换**（2026-11-11 修正，[use-service-status.ts](../src/hooks/use-service-status.ts) 的 `refreshWorkspace`）：确认服务回来之后重新拉的会话列表，每条都是没读过历史的空壳（消息为空、`messagesKnown` 为假）。早先的做法是拿它直接替换整个列表，已经读出来、正在显示的消息跟着就没了；而「这个会话的历史已经读过」的标记记在线程加载层（[use-thread-loader.ts](../src/hooks/use-thread-loader.ts) 的 `loadedThreads`），没有任何路径会清掉它，也就不会有人再读一次历史——聊天区就一直空着，只能刷新页面。现在改成保留合并：标题、置顶这些信息用服务器的新值，消息和 `messagesKnown` 沿用本地的那一份；服务器上已经不存在的会话照旧跟着消失。断线期间正在流式回答的会话也因此不再被删除。按地址重新认领状态仍在合并之后照旧调用。
- **谁在听 `h2bot:network-ok`**：① 500 毫秒续传轮询循环——提前结束这个周期的等待、立即以全新的周期开始（`finish` 幂等；唤醒后先发请求、请求回来才建下一个周期定时器，没有新旧定时器并存的窗口）。② 断线补查 catchUp（[use-turn-engine.ts](../src/hooks/use-turn-engine.ts)）——不再直接监听浏览器原生的 `online`：那时补查多半无谓失败一次，还会和主动探测形成双份补查。补查行为不变：对每个还在等回答的会话挨个补查一次线程（`refreshThread`，里面带着续传逻辑），**跳过本页正在流式的会话**——那场让流自己收尾，别在这儿换掉消息列表。`visibilitychange` 回可见的常规补查与可见性提前结束轮询等待照旧。
- **保底定位键**：从上游回填的老会话消息可能没有轮次编号。waiting 消息没有 turnId 时，轮询用 `message.id` 当定位键（只认还在等待中的那条），续传不再静默失效（`applyPartialText` 的 fallbackKey 分支）。
- 服务器侧 `/partial` 的收窄语义（200 只回 streaming、其余一律 404）和 `probePartial` 四种结果见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「刷新续传与断流恢复」。

## 超时与重试

- **失败怎么分类（2026-11-11 改写）**：以前只看「有没有 detail」，于是网关 502 的错误页、正文不是 JSON、字段形状对不上，全都被当成「连不上服务器」。现在按实际发生了什么分：请求没送到或没等到回应（含超时）是传输失败，照旧挂「无法连接到服务器」的横幅；服务器答话了但内容用不了是另一种，提示「服务器返回了看不懂的内容」并且不挂横幅；非 2xx 又读不出 detail 的服务端错误（比如网关的 502 错误页）仍按连不上处理——服务确实用不了。只有传输失败会自动重试，服务器已经答话的错误不再重发。给响应形状错误专用的错误类型保留了真实状态码，读不懂正文那种是 200，不再一律折叠成 0。（[http.ts](../src/api/http.ts)、[failure.ts](../src/api/failure.ts)）
- **普通请求超时 15 秒**；FormData（头像上传）放宽到 60 秒（[src/api/http.ts](../src/api/http.ts)，`AbortSignal.timeout`）。超时被包成传输失败（`TransportError`），进入「连不上」的既有降级路径。
- **流式对话请求没有总超时，但有 60 秒空闲超时（2026-11-06）**：上游整块返回、一轮实测可达 23 秒，15 秒的总超时套不上去。空闲超时是读取循环每收到任何字节就重置一个 60 秒定时器（后端 15 秒一次的心跳注释帧也算——只要底层有字节到达）；到点没有任何字节，前端主动中止这条流，落入既有的中断语义：收到过内容按断流进续传流程（问「还在写吗」再核对并修正），一点内容都没收到就去问服务器这一轮的下落。网络半开（移动网络切换那种）不再永远卡在「正在思考」。实现在 [chat.ts](../src/api/chat.ts)。
- **非幂等请求不自动重试**：只有 GET 默认自动重试（4 次、间隔 300 毫秒）；POST/PATCH/DELETE（建会话、登录、停止、重命名、置顶）连接断了再盲目重发一次可能做出两份，默认只跑一次，调用方明确知道能重发时才传 `retry: true` 打开。
- 对话流自己的重发规则（只有服务器明确说「没在写」才带同一个轮次编号重发一次）是协议层面的事，见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「重试与编辑重发」。

## 错误边界与降级

- **单条消息**：[BubbleBoundary](../src/components/chat/BubbleBoundary.tsx) 包住每条消息的渲染。一条消息渲染崩溃了（Markdown/KaTeX 管线、组件定制抛错），那一条降级成纯文本气泡（原文照显），其余消息照常——不再整页白屏。
- **整页**：[PageBoundary](../src/components/shell/PageBoundary.tsx) 包住 App 根部。非消息区域崩溃了给整页降级：「页面出了点问题」（`pageError` 键）+「刷新页面」（`refreshPage` 键）按钮。`/admin` 懒加载分块的 rejection（分块到手后渲染崩溃了）也由它捕获。
- **管理页懒加载与分块加载失败**（2026-11-06）：`/admin` 改 `React.lazy` ＋ `Suspense`，fallback 是控制台自己 checking 占位同款的空白 div（`h-full bg-base-200`，不引入新文案）。发布过渡期（旧页面要旧分块、服务器已换新）会让动态 import 失败，Vite 统一派发 `vite:preloadError`：App 顶层的 PageBoundary **之外**另挂 `ChunkFailureToast` 监听它，弹 toast「有新版本了，刷新页面即可」（`newVersionRefresh` 键，三语）；模块级标志保证一次页面会话只弹一条（刷新页面即复位——刷新后就拿到新分块了，一条就够）。刻意挂在边界外：`/admin` 分块加载失败时 lazy 的 rejection 会把整页送进错误边界，toast 得留在边界外才看得见。它的语言在失败瞬间从本地记的资料取一次快照，读不到随系统。

## 标签页标题与 html lang

`useDocumentMeta(locale, pageTitle?)`（[use-document-meta.ts](../src/hooks/use-document-meta.ts)，2026-11-06）统管 `<html>` 的 `lang` 属性和 `document.title` 两件事，ChatApp 与 AdminConsole 里两处重复的同款效果已删除：

- 聊天页标题 =「{会话名} - H^2 Bot」：会话名超过 30 字符截断加省略号；无标题、新对话、未登录都只是「H^2 Bot」。切会话、改名、置顶刷新（sessions 整份替换）、登录登出都经由 `active` 自动跟随，不用额外接线。
- 管理台标题 =「管理员控制台 - H^2 Bot」（`adminConsole` 键）。
- `document.title` 是纯文本赋值，会话标题是学生随手输入也没有注入风险。

## 多标签页同步

登录态、语言与头像的跨标签页同步（2026-11-06，[use-multi-tab-sync.ts](../src/hooks/use-multi-tab-sync.ts) 的 storage 监听；键与辅助函数在 [profile-cache.ts](../src/session/profile-cache.ts)）。storage 事件只派发给「其他」标签页，写入方自己收不到：

- **资料与头像**：`h2bot-profile` / `h2bot-avatar` 变更当场应用语言、用户名、头像（另一标签页切语言，本页立即跟着换）。`newValue` 为 null（清缓存只发生在登出/被强制退回登录页路径）不做二次处理、更不会把页面退回登录界面——主动登出由下面的登出标记接管，服务器侧的强制下线照旧靠 401 保底处理。
- **主动登出标记**：键 `h2bot-logout`，值是写入时刻的时间戳（只用来区分「新标记」，数值无业务含义）。`signOut` 成功写入，登录（`openAccount`）清除。其他标签页听到且 `newValue ≠ null` → `enterLoginGuarded`：已经处于「会话过期后留在原页面的状态」的标签页保持原样（横幅挂着、输入锁着，不升级成整页清空），否则走整页登录路径；正打的字照旧存进 `h2bot-unsent`。写入方收不到自己的事件，不会把自己强制退回登录页；`openAccount` 清除标记时会广播一次 `newValue` 为 null 的 storage 事件，消费方只认非 null 的写入，不会误把用户强制退回登录页。各标签页在处理登出标记时还会把自己保存的全部会话草稿清掉（2026-11-06 补：sessionStorage 按标签页隔离，登出方清不到别的标签页，只能各清各的）。
- **与服务器侧失效的分工**：会话过期、账号停用、改密吊销令牌都不写任何本地标记：2026-11-06 起由 `/api/events` 推送通道实时推给所有标签页（进入与带 reason 的 401 同一套留在原页面的过期状态），下一次请求的 401 作保底；主动退出仍走上面的 localStorage 标记（退出登录不推送，属设计决定）。分工依据注在 profile-cache.ts 的注释里。

## 侧栏置顶乐观更新

置顶/取消置顶改乐观更新（2026-11-06，[use-session-actions.ts](../src/hooks/use-session-actions.ts) 的 `pinOpenSession`）：

- 点击界面立即生效（`pinnedAt` 先写入本地时间），请求后台发；成功把本地值换成服务端的权威值；失败回滚界面。回滚简化：原 `pinnedAt` 没快照，恢复成 null——罕见的回滚场景只影响这条会话在置顶组里的先后，可忽略（调研 frontend-app O11 认可过这个简化）。
- 失败反馈走错误 toast（菜单点完就关，输入区上方的警示框容易被漏看）——从原来的 `setNotice` 改成 toast；401 走登录界面、带服务器给的说法，不弹 toast；连接类失败照旧挂全局服务横幅（横幅与 toast 一起出现）；成功不提示。
- 侧栏的 FLIP 重排动画跟着乐观更新立即播，失败回滚时再反向播一次。

## 读屏行为

- **消息滚动容器 `role="log"`，不挂 aria-live**：log 语义就是「追加式消息记录」，浏览器对新增内容有默认的礼貌处理；早先整个大容器挂 `aria-live="polite"`，流式期间每个 chunk 都触发播报，读屏用户基本没法用。容器带 `aria-label`（会话标题）和 `aria-busy`（这一轮在写时为真）。
- **独立的 sr-only status 区只报「正在思考」**：本会话有等待中的回答时报，空闲时为空——读屏播报收窄到这一处里程碑，不逐字播。
- 等待气泡自身 `role="status"`；进度节点名 `aria-hidden`（见「等待气泡与进度显示」）。

## 焦点管理

Modal 的焦点管理（2026-11-06，[Modal.tsx](../src/components/shell/Modal.tsx)，全部弹窗统一；调研 frontend-app P6 的落点）：

- **面板栈**：模块级 `openPanels` 栈，多个弹窗叠开时（例如会话过期在原页面重新登录叠在设置弹窗上）只有栈顶那个响应 Esc 和 Tab 焦点圈定，不互相抢键盘。
- **打开即聚焦**：优先 `autofocus` 元素，其次面板里第一个可聚焦元素；一个可聚焦元素都没有就退回面板本身（`tabIndex=-1`）。
- **Tab 首尾循环**（Shift+Tab 同理）；焦点不知怎么落到面板外时直接拉回第一个元素。`focusableIn` 过滤 `inert` 子树里的（收起状态的语言菜单浮层）和 `display: none` 的（头像的 file input）——它们不进 Tab 顺序也不进圈定循环。
- **背景滚动锁**：`body` 的 `overflow: hidden`，计数式——最后一个弹窗关闭才恢复。移动端 Safari 上 `overflow: hidden` 不保留滚动位置（解锁后跳回顶部），已知小瑕疵先接受（`position: fixed` 的替代方案代价更大，不做）。
- **关闭还焦点给触发元素**：打开时记录（此刻焦点还在面板外才算数；面板 autofocus 先抢走焦点时没有可靠的触发元素可记，跳过）；还焦点前查 `isConnected`——触发元素随页面卸载了就不再 focus。
- 面板上的 `opacity-100` / `scale-100` 反制动效类**未动**（既有硬约束，原样保留）。

两处 `role="menu"` 浮层的键盘导航（2026-11-06，[LanguageMenu.tsx](../src/components/language/LanguageMenu.tsx) 与 [SessionRow.tsx](../src/components/sidebar/SessionRow.tsx) 的行级更多菜单，同款写法各自实现）：

- 方向键上/下循环移动、Home/End 跳首尾；type-ahead 不做（选项少，方向键循环够用，注释记了理由）。
- 打开即聚焦（语言菜单优先落在当前语言项上）；关闭把焦点还给触发按钮——只在浮层转入 `inert`、浏览器把焦点丢回 body 或焦点还留在菜单里时接管，点外部按钮关闭的场景焦点已在点击目标上，不抢回来。

## 会话过期后留在原页面的状态

会话类 401 现在带 `reason` 字段（词表和后端实现见 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)「401 带原因」）。页面这边（[use-auth-flow.ts](../src/hooks/use-auth-flow.ts) 的 `handleAuthError`）：

- **进入条件**：auth 是 ready 时收到带 reason 的 401 → 进入留在原页面的过期状态（`sessionInvalid`：expired 或 disabled）。不带 reason 的 401（旧后端）保守回退整页 `enterLogin` 路径；checking/anonymous 阶段的 401 照旧走整页登录屏。
- **留在原页面的过期状态保留什么**：会话列表、消息、草稿、profile 缓存全部原样不动；输入区禁用（`inputLocked` 把 `sessionInvalid` 算进去）；输入区分隔线上方挂**常驻警示条，不可关闭**——expired 用琥珀的「有状况」语气 + 「重新登录」按钮（`logInAgain` 键），disabled 用红色出错语气、不给按钮（终态，登录也没用）。白底黑字、语义色只在图标上（[UI_WARNINGS.md](UI_WARNINGS.md) 的颜色规则）。
- **在原页面重新登录**：Modal 里嵌 LoginScreen 同款卡片，不清聊天页的任何状态；登录失败弹窗不关、错误留在表单里；成功走 `openAccount` 在原页面恢复——`resetForLogin` 把上一个登录态的进行中请求、轮询和「线程已加载」标记一次清掉，`bumpThreadRetry` 让当前会话的历史重新拉（activeId 和 auth 都没变，线程加载效果只能靠 retry 计数重新触发），然后清 `sessionInvalid`、关弹窗。
- **其余动作的 401 出口**（侧栏、设置、改密、服务状态恢复）走 `enterLoginGuarded`：已经处于留在原页面的过期状态时不再升级成整页清空——横幅已经挂着了，清空反而会把这个状态下已经保留的内容丢失。
- **断线补查的 401**（轮询碰到 404 后、网络恢复、重试前的 `refreshThread`）走统一的 `onAuthError` 出口：会话已过期就进入留在原页面的过期状态，不再被静默忽略。
- 触发来源现在有两条（2026-11-06 起）：① 下一次请求收到带 reason 的 401（原路径）；② 服务器 `/api/events` 推送通道实时推来 `valid:false` 失效帧（改密、控制台重置、令牌过期）——与 401 走同一个处理入口进入同一状态。推送的 reason 词表三个词：`expired`/`password_changed`/`admin_reset`。横幅文案 2026-11-08 起统一（维护者决定）：三种 reason 一律「会话已过期，请重新登录」，「为什么被强制下线」的解释归强制改密页的横幅（被重置的账号重新登录就会撞见它）；`disabled` 是终态、保留「账号已被停用」；不认识的词保守按失效处理（文案退帧里的 `message`，缺失退「会话已过期」）。后端 401 的 detail（「未登录」）自同日起不对用户显示。接线模块：[push-channel.ts](../src/session/push-channel.ts)。
- **连接断了会自己接回来（2026-11-11）**：连接被彻底关掉（`readyState` 变成 `CLOSED`）时不再一律当成「登录态已失效」而收手——网关故障也会走到这个状态，而浏览器的 `error` 事件不告诉我们状态码，两者长得一模一样。现在先问一次 `/api/profile` 分辨：401 才是登录态真的没了，照旧不再重连并进入「留在原页面的过期状态」；其余情况（网络错、5xx）按 1 秒起、每次翻倍、封顶 30 秒的退避重新建一条连接，关掉通道时在途的探测和排队中的重连都会作废，不会在关掉之后又冒出新连接。改之前的代价是：服务抖动一次，推送能力就一直失灵到用户重新登录。


## 强制修改密码的拦截

密码来自别人手的账号（预设密码、被控制台重置过密码），服务器带着 `must_change_password` 标记（迁移 0002），中间件对它请求非豁免路径一律回 403（code `must_change_password`）。前端对应的拦截（2026-11-06）：

- **进入拦截的三个来源**：登录响应里标记为真；页面恢复时拉到的资料里标记为真；任何请求收到 403 且 code 为 `must_change_password`（[http.ts](../src/api/http.ts) 在唯一的响应体解析口广播全局事件，[use-auth-flow.ts](../src/hooks/use-auth-flow.ts) 监听后进入拦截）。
- **拦截期间的行为**：只渲染强制改密页（[ChangePasswordPage.tsx](../src/components/settings/ChangePasswordPage.tsx) 的强制模式：标题「设置新密码」，顶部一条白底说明横幅解释为什么被拦），正常聊天主体一概不渲染；路径守卫把地址强制改到 `/force-change-pwd`——手输别的地址、用浏览器前进后退都会被送回。进闸门前守卫一并记下「来路」（只记 `/chat/:id`，别的地址不记）：改密成功或放弃登录都回到这里就地重新登录，登录后路由认领回原会话（契约见 [password-return.ts](../src/session/password-return.ts)）。
- **放弃本次登录（2026-11-07 补上，2026-11-08 改名）**：被标记账号的登录不算登录成功——服务器发的只是一条能到豁免路径的受限会话。强制页的「放弃本次登录」即放弃这次登录：尽力调用注销接口作废受限会话（服务器联系不上也照样回登录页，受限会话到不了聊天功能、会自行过期），清掉本地登录态、回「记下的来路」就地渲染登录屏，其他标签页经登出标记一起回登录界面；草稿按主动退出的规矩清空。标记仍留在账号上，下次登录照样被拦，直到改完密码。实现：[use-auth-flow.ts](../src/hooks/use-auth-flow.ts) 的 `cancelGatedLogin`。
- **拦截期间登录态死掉（2026-11-08 修正）**：拦截时聊天主体不渲染，「留在原页面的过期状态」的警示条看不见，此前推送失效帧和提交收到的 401 都被静默忽略——点「修改」页面毫无反应，只有开发者工具里能看到 401。现在两条出口都直接带文案回登录页：推送失效帧走 handlePushInvalid 的闸门分支（帧里的 message，缺失时退「会话已过期，请重新登录」）——本页正在改密（提交中或已成功待收尾）时例外，帧不抢先，成功收尾自己会清状态跳登录；提交收到 401 表单错误按 reason 映射成「会话已过期，请重新登录」（不再透出服务端 detail「未登录」），出口直通登录页。重新登录后由登录响应决定要不要再进闸门。
- **解除（2026-11-08 重做收尾）**：改密成功后服务器在同一事务里吊销全部令牌并清 cookie，「改完接着用」物理上做不到。收尾三步：①提交按钮点击即禁用加转圈（改密页两种模式同款），成功先就地亮一条「密码已修改，请用新密码重新登录」的白底横幅；②片刻后回「记下的来路」（只记 `/chat/:id`，没有就根路径）就地渲染登录屏——地址不动，与被 401 强制退回登录页同一套机制，登录屏带同句提示；③用新密码重新登录，claimPath 认领回原会话；登录响应里标记已是 false，拦截解除。收尾不走 enterLoginGuarded：那道守卫在「留在原页面的过期状态」挂起时会忽略整页清空，而服务器先推 `password_changed` 帧再回 204——帧先到、被守卫忽略，就是「点修改毫无反应」卡死的根。万一标记仍为真，拦截重新生效。
- **控制台一侧**：服务器不做强制改密（维护者永久决定，见 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)「必须改密标记」）。控制台的「修改我的密码」入口（[ChangeMyPasswordDialog.tsx](../src/components/admin/ChangeMyPasswordDialog.tsx)）纯自助；修改成功后所有设备同样下线，回控制台登录界面用新密码重新登录。

## SSE 解析器（前端）

[src/api/chat.ts](../src/api/chat.ts) 的解析器按 SSE 规范写（帧语义见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「流里的四种帧」）：

- 事件边界同时认 `\n\n` 和 `\r\n\r\n`（CRLF）。
- 同一事件里多条 `data:` 行先按规范用 `\n` 连成一帧解析；连起来解析不出来时退回逐行认——坏的行丢掉，其余的行（可能正是 `[DONE]`）照常处理。**一帧坏 JSON 只拖累它自己。**
- 命名事件按名处理：`progress` 解析成节点名 + 状态词，`done` 解析成结局（字段任何一个不合就整帧忽略——宁可没收到结局，不能解出一个错误的结局）；未知命名事件的 data 整帧忽略（给将来别的命名事件留位）；注释帧（`: ping` 心跳）只认 `data:`/`event:` 行，天然被忽略。

## 进场动画的 id 集合

消息进场动画的追踪集合 `enteringIds` 是 `Set`（查询 O(1)），`markEntering` 时同时挂一个 **500 毫秒的保底超时清理**（幂等）：正常由 `onAnimationEnd` 移除；气泡在动画结束前就被删掉时（重发去掉旧回答、发送没成功整轮回滚），`onAnimationEnd` 不会再来，超时清理保证 id 不会永远漏在集合里。`prefers-reduced-motion` 的用户不加 id，没有这个问题。

## 已知限制

- **`probePartial` 把 401 归为 unreachable（原限制，2026-11-07 关闭）**：流断了去问「还在写吗」时如果会话已过期，401 曾被归进「问不到服务器」，走连接警示横幅而不是会话过期后留在原页面的状态。现在 401 单列为「会话已失效」（unauthorized）结果、带上 reason，四个调用点全部接入会话过期处理：引擎的断流恢复（`recoverReply`）和停止收尾（`finishStop`）直接走统一的 401 出口（`onAuthError`）；`chat.ts` 的 `outcomeAfterFailure` 和 `thread.ts` 的 `loadThread` 把 401 原样抛给调用方既有的 401 出口。
- **留在原页面的过期状态里侧栏/设置操作的 401 静默失败**：`enterLoginGuarded` 保证不清页，但那些操作本身也没成功，用户看不到单独的解释（横幅是共用的那条）。
- **改密页提交的反馈（原限制，2026-11-08 重做）**：提交按钮点击即禁用加转圈直到请求完成；成功就地亮「密码已修改」横幅再收尾跳登录；401 的表单错误按 reason 映射成「会话已过期，请重新登录」（不透出「未登录」），出口直通登录页、不再被守卫忽略（见「强制修改密码的拦截」）。
- **服务器侧失效已实时推送（原限制，2026-11-06 关闭）**：改密、控制台重置、令牌过期经 `/api/events` 推送通道推到所有开着的标签页、进入与带 reason 的 401 同一套留在原页面的过期状态，下一次请求的 401 作保底；主动退出照旧走 localStorage 标记（退出登录不推送，属设计决定）。
- **滚动跟随只看消息列表和编辑框文本**：打字机播放的每个周期长高已持续跟随（2026-11-06，每个周期 `onReveal` 查贴底，见「打字机播放」）；其余纯高度变化（高亮懒加载迟到、KaTeX 排版完成、思考气泡进度文本）仍不会重新触发贴底判定，已贴底时跟随可能悄悄脱钩；「回到底部」按钮仍可用。
- **其余 7 个组件「lang 属性按连接错误硬标 zh-Hans」的临时写法未收敛**：`error === text.connectionError ? htmlLang[locale] : 'zh-Hans'` 还留在 AdminConsole、AdminLoginForm、ConfirmAdminLogout、ConfirmResetPassword、LoginScreen、ConfirmLogout、SettingsModal 七个组件里——错误文案 i18n 映射（2026-11-06）之后，英/繁界面的错误多数已是本地化映射文案，内容正确，但这个写法会把它们的 `lang` 标成 `zh-Hans`，标注不准。另有同族变体第 8 处：ChangePasswordPage 的 `localizedError ? htmlLang[locale] : 'zh-Hans'`（判断条件从「是不是连接错误」换成「是不是本地化映射文案」），收敛时一并处理。归 frontend-app P4 后续收敛。
- **`must_change_password` 已消费（原限制，2026-11-06 关闭）**：强制修改密码的拦截已实施，行为见「强制修改密码的拦截」一节。
