# 前端聊天主链路改进调研

调研日期：2026-11-04。只读调研，全部论断基于 `main@1eadc4e8c042` 的代码原文，关键处都标了文件和行号。

## 概览

### 读了哪些文件

- `/src/api/chat.ts`、`/src/api/messages.ts`、`/src/api/partial.ts`、`/src/api/http.ts`、`/src/api/failure.ts`、`/src/api/session.ts`
- `/src/hooks/use-turn-engine.ts`
- `/src/components/chat/` 全部七个文件（ChatMain.tsx、FailedReply.tsx、MarkdownText.tsx、ThinkingBubble.tsx、WarningBox.tsx、markdown.css、message-class.ts）
- `/src/session/` 全部八个文件（thread.ts、poll.ts、unsent.ts、text.ts、title.ts、pin-order.ts、empty.ts、profile-cache.ts）
- `/src/type/chat.ts`、`/src/App.tsx`（集成层，用于确认滚动/草稿/提交的实际行为）、`/src/i18n.ts`（文案键）、`/package.json`（依赖版本）
- 文档：`/docs/CHAT_STREAM_KNOWN_ISSUES.md`、`/docs/INTERRUPTED_REPLY.md`（两者已退役，内容并入 `/docs/CHAT_STREAM_PROTOCOL.md` 等）、`/docs/MESSAGE_ACTIONS.md`、`/docs/FINDINGS.md`

文档里已记录且已修好的事（轮询 401 死循环、被强制下线时输入丢失、422 detail 数组）不再重复报告；`remark-math` 把 `$` 解析成公式定界符、流式公式跳变、会话行浮层必须走 portal 这些已有记录的固有行为也不再当新问题提。

### 聊天主链路现状（数据流）

1. **输入**：`ChatMain.tsx` L161 是一个单行 `<input>`，值由 `App.tsx` 的顶层 `draft` state 控制。提交走原生 form submit（`submitMessage`，App.tsx L530 附近）。
2. **发送**：`submitMessage` 先本地追加一条 user 消息（带 `turnId = crypto.randomUUID()`），然后调 `use-turn-engine.ts` 的 `sendQuestion`（L404）；新会话首条走 `sendFirstMessage`（App.tsx L468），先 `POST /api/sessions` 建会话再发问。
3. **流式**：`sendQuestion` 调 `api/chat.ts` 的 `streamReply`（L16）→ `POST /api/chat`，SSE 逐帧解析（`readStream` L103、`pieceFromEvent` L142），每个文本块回调 `onDelta`。结局有五种：`completed` / `interrupted` / `not-started` / `aborted` / `busy`；`not-started` 会自动重发一次（L27-30）。
4. **渲染**：`onDelta` 每块都调 `applyStreamText`（use-turn-engine.ts L149）→ `updateSession` 全量替换 messages 数组 → `App.tsx` 顶层 `sessions` state 更新 → 整棵树（含 Sidebar）重渲染 → `MarkdownText`（memo，按 text 比较）对流式那条全量重解析 Markdown + KaTeX。
5. **断流恢复**：流断且无 `[DONE]` → `recoverReply`（L348）读 `GET /partial` 核对；服务器还在写就 `startPolling`（L295，500ms 固定间隔轮询 `/partial`，`session/poll.ts`）。刷新页面后由线程加载效果（L64-124）拉 `/messages` + `/partial`，`resumePartial`（L339）接上正在写的一轮。
6. **停止**：`stopSending`（L555）先本地 `abort()`，再由 `finishStop`（L512）调 `POST /abort` 并读 `/partial` 按服务器说的收尾。
7. **存储**：前端不存消息，历史全部来自服务器（自有 `message` 表 + FastGPT 回填）；本地只有 `h2bot-unsent`（sessionStorage 单槽，被强制下线/切会话时暂存未发送文本）和 `h2bot-profile`（localStorage，用户名+语言）。

整体评价：断流核对、轮次编号幂等、停止语义这些"难而正确"的部分做得扎实（与原 INTERRUPTED_REPLY.md 的记录一致，该文档已退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md）。短板集中在**渲染与交互层**：没有任何滚动管理、单行输入框、草稿不分会话、流式期间全树重渲染，以及若干错误分支把"可重试"做成了"不可重试"。

---

## 一、新功能机会

### N1. 自动滚动跟随 + 「回到底部」按钮

> **已实现（2026-11-05）**：滚动跟随已完成——距底 48px 以内算贴底，贴底时内容变化自动滚到底；上滚停止跟随并露出悬浮的「回到底部」圆钮（backToBottom 键）；切换会话时组件重挂载、贴底状态自然复位。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「滚动跟随与回到底部」。调研原文以 LayerFS 历史为准。

### N2. 多行输入框：textarea 自动增高，Enter 发送 / Shift+Enter 换行

> **已实现（2026-11-04）**：按本节方案实施（autoGrow 封顶、Enter 发送 / Shift+Enter 换行、isComposing 防输入法误发），见 `ChatMain.tsx`。本节保留作调研记录。

> 功能现状描述见 docs/CHAT_PAGE_BEHAVIOR.md「输入」一节；调研原文以 LayerFS 历史为准。

### N3. 草稿按会话分开存，刷新不丢

> **已完成（2026-11-06）**：按 `src/session/drafts.ts` 实施，与本节方案有两处出入——存储用 sessionStorage（不是 localStorage）、按键即写且刻意不防抖（同步写开销可忽略，省掉「切会话/卸载时何时 flush」的时序坑，依据注在代码注释里）。键名照本节：`h2bot-draft:{sessionId}`、新对话 `h2bot-draft:new`。恢复落点：切会话 showSession、开新对话 showNewChat、刷新/深层链接后 claimPath 的三个落点各读各的键；unsent 恢复优先于草稿。发送成功清对应键；主动退出 clearAllDrafts() 全清、被强制下线不清。旧 rememberDraft 单槽机制已删除。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「未发送内容缓存与按会话草稿」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/App.tsx` L82（全局单一 `draft` state）、L395 `rememberDraft`、L402 `showSession`（`setDraft('')`）、L411 `showNewChat`（`setDraft(readUnsent())`）；`/src/session/unsent.ts`（sessionStorage 单槽 `h2bot-unsent`）。
- **现状**：草稿是全局一份。切换会话时当前输入被存进 `h2bot-unsent` 单槽，但**切回的会话不恢复自己的草稿**（`showSession` 直接 `setDraft('')`），只有「新对话」会读回那个槽。两个会话各打一半的字，后存的覆盖先存的。整页刷新则全丢（`draft` 是内存 state，`unsent` 只在被强制下线/切换时写）。
- **影响**：学生写一半的长提问，切个会话或不小心刷新就没了；单槽覆盖会让「新对话」里出现别的会话的半截草稿，属于数据串味。
- **方案**：新增 `session/drafts.ts`，按会话 id 存 localStorage（`h2bot-draft:{sessionId}`，新对话用固定键 `h2bot-draft:new`），写入防抖 300ms；`showSession`/`showNewChat` 恢复对应草稿；发送成功后清除。`h2bot-unsent` 的既有语义（被强制下线存回、登录放回）保持不动，它管的是「已提交但没送达」，和草稿是两回事。

  ```ts
  // /src/session/drafts.ts
  const prefix = 'h2bot-draft:';
  export const NEW_CHAT_KEY = prefix + 'new';
  export function readDraft(key: string): string {
    try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
  }
  export function saveDraft(key: string, text: string): void {
    try {
      if (text.trim() === '') localStorage.removeItem(key);
      else localStorage.setItem(key, text);
    } catch { /* 存不下就算了 */ }
  }
  ```

  App.tsx：`showSession(id)` 里 `setDraft(readDraft(prefix + id))`；`onDraft` 包装一层防抖写入；`submitMessage`/`sendFirstMessage` 成功后 `saveDraft(key, '')`。
- **第三方库**：无。
- **风险**：低。localStorage 存草稿有轻微隐私面（共用电脑），可在退出登录时清空所有 `h2bot-draft:*` 键来对齐 `clearCachedProfile` 的做法。
- **工作量**：S。

### N4. 代码块复制按钮（可选：语法高亮）

> **2026-11-05**：高亮库已定并已安装 **react-syntax-highlighter 16.1.2**（本节二选一里选它）。注意：该包不带类型声明，`@types/react-syntax-highlighter` 也还没装——接入前需要维护者补装类型包；装好之前若先接入，要用临时本地声明文件过渡。（更新：2026-11-05 维护者已补装 15.5.13，垫片已删，tsconfig `types` 显式加载官方环境声明。）复制按钮不依赖高亮库，可先做。

> **已实现（2026-11-05）**：代码块复制按钮已完成（脚注 hover 区，代码块从 React 子树抽文本）；语法高亮按 react-syntax-highlighter 的 prism-light 按需路线接入——第一个命中语言的代码块触发动态 import，独立 chunk 约 45.5 kB，注册 python/javascript/typescript/java，没命中的语言保持纯文本；@types 未装期间用 src/types/react-syntax-highlighter.d.ts 垫片过渡；2026-11-05 维护者已补装 @types 15.5.13，垫片已删除，tsconfig 以 `"types": ["react-syntax-highlighter"]` 显式加载官方环境声明。功能描述见 docs/MESSAGE_ACTIONS.md（第四期注记）和 docs/TECH.md「代码高亮」条。调研原文以 LayerFS 历史为准。

### N5. 消息编辑重发（对齐 MESSAGE_ACTIONS.md，前端部分）

> **已实现（2026-11-04，MESSAGE_ACTIONS.md 第三期）**，其中一处决策与本节建议不同：编辑按钮只给**最后一轮**的用户提问（本节建议每个用户提问都给）；发送失败按 Gemini 式整轮回滚。本节的 `retryTurn(sessionId, turnId, editedText?)` 签名被采纳。现状以 [MESSAGE_ACTIONS.md](../MESSAGE_ACTIONS.md) 为准，本节保留作调研记录；下方「位置」行是历史快照——`ChatMain.tsx` L129-131 的 TODO 注释已随实现移除，行号也因重构变动。

> 功能现状描述见 docs/MESSAGE_ACTIONS.md；调研原文以 LayerFS 历史为准。

### N6. 助手回答整体复制

> **已实现（2026-11-05）**：复制按钮已放进脚注 hover 区：助手回答复制原始 Markdown（message.text，不序列化 DOM），用户提问复制纯文本；clipboard 不可用时静默失败；「复制/已复制」三语齐（copy/copied 键）。功能描述见 docs/MESSAGE_ACTIONS.md。调研原文以 LayerFS 历史为准。

### N7. 断线自动恢复：online 监听 + 回到前台补查

> **已实现（2026-11-05）**：window online 与 visibilitychange 回可见时，对每个还在等回答的会话挨个补查一次 refreshThread（里面带着续传逻辑），跳过本页正在流式的会话（让流自己收尾）；recoverReply 问不到服务器时不再删已收到的文字、保留现场（与 P3 联动完成）。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「轮询与断线补查」。调研原文以 LayerFS 历史为准。

### N8. 无障碍：aria-live 收窄、role="log"、流式状态通告

> **已实现（2026-11-05）**：滚动容器改 role="log"（不挂整容器 aria-live，带 aria-label 和 aria-busy）；独立的 sr-only status 区只报「正在思考」；等待气泡自身 role="status"，进度节点名 aria-hidden 不进读屏播报。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「读屏行为」。调研原文以 LayerFS 历史为准。

### N9. 流式期间允许继续打字

> **已完成（2026-11-06）**：流式期间输入框不再禁用（inputLocked 只算「新会话建立中」与会话过期后留在原页面的状态），发送仍锁到本轮结束（sendLocked）。实现比本节方案更细：pending 且输入为空显示停止按钮，有字（trim 后）换成禁用的发送按钮＋外壳悬停浮层「请等待 AI 回答完毕」（waitForReply 键三语；disabled 按钮不接收鼠标事件，浮层挂外壳、按钮 pointer-events-none；触屏点外壳弹同款 toast）；pending 期间 Enter 不发送、给同款提示；清空输入停止按钮回来。流式期间打的字随按随写进该会话草稿（N3）。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「输入」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/App.tsx` L152（`inputLocked = sendingNew || activePending`）→ `ChatMain.tsx` L165 input `disabled={inputLocked}`。
- **现状**：回答流式期间输入框整个禁用，学生想到追问只能干等。其实发送通路已经能优雅处理早发：服务器回 409 `busy`，前端把问题放回输入框并提示 `roundBusy`（use-turn-engine.ts L432-441）。
- **影响**：等待感放大；对「想到就赶紧记下来」的学习场景不友好。
- **方案**：把「能打字」和「能发送」分开：`disabled` 只留给 `sendingNew`（首条消息建会话中），流式期间输入可用、发送按钮维持禁用（`sendLocked` 已有这个区分位）；或者更激进一点——允许发送，落到既有 409 busy 流程（问题回输入框 + 提示），这条通路今天就是通的。建议先做保守版：

  ```tsx
  // App.tsx
  const inputLocked = sendingNew;                 // 打字不再被流式挡住
  const sendLocked = sendingNew || activePending || historyLocked; // 发送照旧等这轮结束
  ```

  ChatMain 的 input `disabled={inputLocked}` 不变。
- **第三方库**：无。
- **风险**：低。注意 N3 的按会话草稿和这里的交互：流式期间打的字在切会话时应存进该会话草稿。
- **工作量**：S。

### N10. 移动端输入细节：字号防缩放、safe-area、气泡宽度

> **已完成（2026-11-06）**：三处都完成——底部输入条 `pb-[max(1rem,env(safe-area-inset-bottom))]` ＋ index.html viewport meta 带 `viewport-fit=cover`；气泡窄屏 `max-w-[85%]`、md 断点起维持 600px 上限（message-class.ts）；输入框 `text-base`（16px，防 iOS 聚焦缩放）随 N2 多行输入完成时已带上。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「输入」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/components/chat/ChatMain.tsx` L157-186（输入条 `px-4 pt-3 pb-4`）、L161 input；`/src/components/chat/message-class.ts`（气泡 `max-w-[600px]` 固定值）。
- **现状**：输入框用 daisyUI `input` 默认字号（0.875rem，小于 16px）；底部输入条没有 `env(safe-area-inset-bottom)` 处理；气泡最大宽是固定 600px 而不是随容器百分比。
- **影响**：iOS Safari 对字号 <16px 的输入框聚焦时会自动放大整页（需要核实 daisyUI 5 当前主题的实际字号，若确为 14px 则必现）；iPhone 横屏/刘海屏下发送按钮贴到圆角里；窄屏上 600px 上限虽不会被超过，但和容器 padding 叠加后气泡几乎贴满，观感可以更好。
- **方案**：input/textarea 加 `text-base`（16px，N2 的草图已带）；输入条 `pb-4` 改 `pb-[max(1rem,env(safe-area-inset-bottom))]`；气泡 `max-w-[600px]` 改 `max-w-[85%] md:max-w-[600px]`。三处都是纯 class 改动。
- **第三方库**：无。
- **风险**：低。`env()` 需要 index.html 的 viewport meta 带 `viewport-fit=cover` 才生效，要一起核实。
- **工作量**：S。

---

## 二、优化点

### O1. 流式 chunk 节流合并批次（rAF），消掉 O(n²) 的 Markdown 重解析

> **2026-11-05 维护者决定：搁置至上游支持逐字输出**。上游永远整块返回（见 docs/CHAT_STREAM_PROTOCOL.md「上游整块返回答案」），渲染合并批次优化只在 30~40 帧齐发的十几毫秒里省几十次重渲染，其余时间空转。**2026-11-05 补记**：DSL 分析确认上游无法逐字（审查管线使然，见 docs/FASTGPT_API.md「流式行为」），「上游支持逐字」这个条件永远不会满足；前端「打字机」播放已按块输出＋节流完成（2026-11-06，见 docs/CHAT_PAGE_BEHAVIOR.md「打字机播放」）——本条继续不做。

- **位置**：`/src/hooks/use-turn-engine.ts` L420-428（`streamReply` 的 onDelta 每 chunk 直接 `applyStreamText`）→ L149（每 chunk 一次 `updateSession`，全量 map messages）；`/src/components/chat/MarkdownText.tsx` L49（memo 只救「没变的消息」，流式那条每个 chunk 都全量重解析整段 Markdown + KaTeX）。
- **现状**：一个 chunk 一次 setState、一次全树渲染、一次对**当前全部已收文本**的 remark→rehype→KaTeX 管线。回答长 5000 字、chunk 平均 20 字时，约 250 次渲染 × 平均半程长度 ≈ 60 万字规模的重复解析，中低端设备（学生用平板）会明显掉帧。
- **影响**：流式期间页面卡顿、滚动不跟手（N1 做了自动滚动后会更明显）；风扇/耗电。
- **方案**：onDelta 先攒进 ref，`requestAnimationFrame` 合并批次 flush——每帧最多一次 setState/重解析，帧率 60 时渲染次数从「chunk 数」降到「秒数 × 60」，且天然和屏幕刷新对齐：

  ```ts
  // sendQuestion 内
  let buffered = '';
  let frame = 0;
  const flush = () => {
    frame = 0;
    if (buffered === '') return;
    const text = buffered;
    buffered = '';
    applyStreamText(sessionId, assistantId, text);
  };
  const outcome = await streamReply(sessionId, question, depsRef.current.locale, turnId,
    (chunk) => {
      received += chunk;
      buffered += chunk;
      if (frame === 0) frame = requestAnimationFrame(flush);
    },
    controller.signal, retryOf);
  // outcome 处理前必须先落盘缓冲，否则最后一段丢字：
  cancelAnimationFrame(frame);
  flush();
  ```

  `finally` 里同样要 `cancelAnimationFrame(frame); flush();`（abort/interrupted 路径也要把已收文字上屏）。`received` 的语义不变（它按 chunk 累计，用于 abort 判空）。
- **第三方库**：无。
- **风险**：中低。唯一坑是「flush 时机」：所有会终结流的路径（completed/interrupted/aborted/busy/异常）都必须先 flush 再处理结局，否则最后 0-16ms 的字丢。建议把 flush 放在 `await streamReply` 之后第一行 + finally 双保险（flush 幂等）。
- **工作量**：S。

### O2. 消息条目级 memo + 流式文本与 sessions state 解耦

> **2026-11-05 维护者决定：搁置至上游支持逐字输出**。上游永远整块返回（见 docs/CHAT_STREAM_PROTOCOL.md「上游整块返回答案」），渲染合并批次优化只在 30~40 帧齐发的十几毫秒里省几十次重渲染，其余时间空转。**2026-11-05 补记**：DSL 分析确认上游无法逐字（审查管线使然，见 docs/FASTGPT_API.md「流式行为」），「上游支持逐字」这个条件永远不会满足；前端「打字机」播放已按块输出＋节流完成（2026-11-06，见 docs/CHAT_PAGE_BEHAVIOR.md「打字机播放」）——本条继续不做。

- **位置**：`/src/App.tsx` L82（`sessions` 是顶层 state）、L149 `updateSession`；`/src/components/chat/ChatMain.tsx` L68-146（每渲染 map 全部消息，气泡无 memo）；grep 确认全仓库只有 `MarkdownText` 一个 memo，Sidebar/SessionRow 都没有。
- **现状**：`applyStreamText` 改的是顶层 `sessions`，于是**每个 chunk 重渲染整个 ChatApp**：Sidebar 的几十行会话、SettingsModal、Toast 全部陪跑；ChatMain 里每条历史消息的 wrap/bubble DOM 结构也重建（MarkdownText 因 text 未变会跳过重解析，但 React 调和本身照做）。
- **影响**：和 O1 叠加是流式卡顿的主因；会话数多、历史长时打字（draft 也是顶层 state，每次击键同样全树渲染）也会钝。
- **方案**（分两步，第一步收益就很大）：
  1. **条目级 memo**：把 ChatMain 的消息 map 抽成 `MessageItem` 组件并 `memo`，props 只给 `message`、`entering`、几个稳定回调（`onAnimationEnd`、`onRetry` 用 useCallback + 传 id 而不是闭包）。这样流式期间只有最后一条气泡真正重渲染。

     ```tsx
     const MessageItem = memo(function MessageItem({message, entering, onRetry, onAnimationEnd, ...}: Props) {
       // 现在 ChatMain L69-146 的分支逻辑原样搬进来
     });
     // ChatMain 里：
     {active.messages.map((m) => (
       <MessageItem key={m.id} message={m} entering={enteringSet.has(m.id)} ... />
     ))}
     ```

  2. **流式文本单独放**：给正在流式的那条消息的文本另开一个 state（如 `streamingTexts: Map<messageId, string>`，由 use-turn-engine 的 applyStreamText 改写这里而不是 `sessions`），渲染时 `MessageItem` 对 streaming 的那条叠加显示；流落定（completed/failed/aborted）时一次性写回 `sessions`。`sessions` 不再每 chunk 变 → Sidebar 完全不陪跑。
  3. 顺手项：`enteringIds.includes`（ChatMain 四处）换成 `Set`（O4 一起改）；assistant 分支 L104 的 `textShown === '' ? null : ...` 是死代码（L70 已拦截），可删。
- **第三方库**：无。若做完后长会话（数百条）仍然重，再考虑虚拟化，点名 `@tanstack/react-virtual` ^3（动态高度用 `estimateSize` + `measureElement`），但那一步要处理「贴底滚动」与虚拟列表的配合，建议单独立项。
- **风险**：中。第 2 步动了 use-turn-engine 的状态归属，`applyPartialText`/`recoverReply` 等所有写文本的路径都要同步改；没有自动化测试，需要按原 INTERRUPTED_REPLY.md（已退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md）的场景清单手测（刷新续传、停止、重试、busy）。可以先只做第 1 步观察收益。
- **工作量**：第 1 步 S~M；第 2 步 M~L。

### O3. partial 轮询在后台标签页暂停

> **已实现（2026-11-05）**：轮询循环在 document.hidden 时不发请求、光等；visibilitychange 回可见立刻提前结束等待、补查一次；500 毫秒节奏和 401/404 终止语义不变。指数退避没有做（500ms 是「刷新后接上」体验的一部分）。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「轮询与断线补查」。调研原文以 LayerFS 历史为准。

### O4. enteringIds 泄漏：消息在动画结束前被移除时 id 永远留下

> **2026-11-04 注**：`removeFailedNotice` 已随 `role:'error'` 退役删除，泄漏路径收窄为 `removeTurnAnswer` / `removeTurn`（not-started 与重试分支仍会在进场动画期间删气泡，`use-turn-engine.ts` L493/L498）；`enteringIds` 仍是数组 + `includes`（App.tsx L81、L664，ChatMain.tsx L23/L40/L115）。本条仍然成立，位置行号已变动，引用时以符号名定位。

> **已实现（2026-11-05）**：enteringIds 改 Set（查询 O(1)）；markEntering 同时挂 500 毫秒的幂等保底清理——气泡在动画结束前被删掉时（重发去掉旧回答、发送没成功整轮回滚）onAnimationEnd 不会再来，超时清理保证 id 不漏；prefers-reduced-motion 的用户不加 id。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「进场动画的 id 集合」。调研原文以 LayerFS 历史为准。

### O5. withConnectionRetry 对非幂等 POST 也盲目重试

> **已实现（2026-11-05）**：只有 GET 默认自动重试（4 次、间隔 300 毫秒）；非幂等请求（POST/PATCH/DELETE）默认只跑一次，调用方明确知道能重发时才传 retry:true 打开；对话流有自己的轮次幂等通路，不走这里。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「超时与重试」。调研原文以 LayerFS 历史为准。

### O6. SSE 解析器对规范的偏差（健壮性）

> **已实现（2026-11-05）**：解析器按 SSE 规范重写——事件边界同时认 \n\n 和 \r\n\r\n；同一事件多条 data 行先按规范用 \n 连接整体解析，解不出再退回逐行认（坏行丢掉、其余照常，一帧坏 JSON 只拖累它自己）；命名事件按名处理（progress/done），未知命名事件的 data 整帧忽略。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「SSE 解析器（前端）」，帧语义见 docs/CHAT_STREAM_PROTOCOL.md。调研原文以 LayerFS 历史为准。

---

## 三、未完善与潜在问题

### P1. 重试遇到「连不上」后，这一轮悬空：问题留着，却永远没有重试按钮

> **已随 MESSAGE_ACTIONS.md 第一期解决（2026-11-04），形态有变**：`FailedReply.tsx` 与 `role:'error'` 合成消息已退役。重试场景下 `onRollback` 会把旧轮连同常驻脚注（状态提示 + 重试按钮）恢复回原位（`use-turn-engine.ts` L497-511），不再悬空；首发「连不上」按新设计统一在横幅里报错（L491 注释「连不上归横幅报」、L513「不再往消息流里插错误消息」），不提供轮次级重试入口。下文的 `addErrorMessage` 方案已过时，保留作调研记录。

> 功能现状描述见 docs/MESSAGE_ACTIONS.md；调研原文以 LayerFS 历史为准。

> **已完成（2026-11-06），取代上方 2026-11-04 注记**：重试死胡同已堵——首发失败不再删空气泡、只在横幅里报错，改为气泡留下、标 failed 且带 turnId，脚注给状态提示＋重试按钮（零文字也渲染脚注，落在用户提问下方）。重试失败（连不上、没送达、繁忙）走 onRollback 恢复旧轮脚注；401 分支维持原样。上方注记里「首发『连不上』按新设计统一在横幅里报错，不提供轮次级重试入口」一句由此取代（维护者 2026-11-06 决定：任何失败形态都要留重试路）。功能描述见 docs/MESSAGE_ACTIONS.md「行为规范」一节的 2026-11-06 补充。调研原文以 LayerFS 历史为准。

### P2. `not-started` 的错误气泡不带 turnId，明明可以重试却给不出按钮

> **已随 MESSAGE_ACTIONS.md 第一期解决（2026-11-04）**：错误气泡这一形态已不存在——`not-started` 现在走 `removeTurnAnswer` + 横幅提示 + 重试场景 `onRollback` 恢复旧轮的脚注重试入口（`use-turn-engine.ts` L490-496），`FailedReply.tsx` 已删除。本条的一行修复随架构更新失去意义，保留作调研记录。

> 功能现状描述见 docs/MESSAGE_ACTIONS.md；调研原文以 LayerFS 历史为准。

> **已完成（2026-11-06），取代上方 2026-11-04 注记**：`not-started`（请求没送达）不再走「删空气泡、只在横幅里报错」——首发时空气泡留下并标 failed（气泡带着 turnId，脚注给得出重试按钮）；重试/编辑重发没送达时去掉新空气泡、onRollback 把旧轮原位放回（状态提示和重试按钮跟着回来）；401 分支维持原样。功能描述见 docs/MESSAGE_ACTIONS.md「行为规范」一节的 2026-11-06 补充。调研原文以 LayerFS 历史为准。

### P3. `recoverReply` 问不到服务器时，把已经收到的半截回答删了

> **已实现（2026-11-05）**：recoverReply 按 probePartial 三态分支——问不到服务器（unreachable）保留现场、不删已收到的文字，归常驻连接警示横幅，不替服务器下结论；服务器明确说没在写（idle，404）走 refreshThread 以数据库为准核对；还在写补上半截文字接着轮询。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md 和 docs/CHAT_STREAM_PROTOCOL.md「刷新续传与断流恢复」。调研原文以 LayerFS 历史为准。

### P4. 新会话首条消息发送失败时，问题文本丢失

> **已完成（2026-11-05）**：漏洞已堵上，做法与本节方案不同——不是在 catch 里放回输入框，而是把「清空输入框」的时机整体挪到了会话建成之后（clearUnsent/setDraft 在 createSession 成功后才执行）：建会话失败时打的字原样留在输入框；401（会话过期）路径走 saveUnsent 暂存、重新登录后放回输入框；建成之后才断线时，提问已显示在线程里、文本不丢——那一轮缺重试按钮的问题归本文 P1，仍未修。调研原文以 LayerFS 历史为准。

- **位置**：`/src/App.tsx` `submitMessage` L530 附近（发送前 `clearUnsent(); setDraft('')`）→ `sendFirstMessage` L468 的 catch：L505-508 只有 401 分支 `saveUnsent(question)`；L511-513 `connectionFailure` 分支 showConnectionWarning 后直接 return；L514-516 其他错误且 `sessionId === ''` 时只 setNotice。
- **现状**：用户在「新对话」里打了字点发送，`submitMessage` 立刻清空输入框和 unsent 缓存；如果 `createSession` 或首问因网络类错误失败，question 哪儿都没存——界面上没有（会话都没建出来）、unsent 没有、服务器没有。原 CHAT_STREAM_KNOWN_ISSUES.md 第 10 条（已退役，内容并入 docs/CHAT_PAGE_BEHAVIOR.md）修的是「被强制下线」路径，这条 connectionFailure 路径是同一个漏洞的另一半，还没堵。
- **影响**：弱网下新对话首发失败 = 用户输入直接丢失，和已修的第 10 条同等严重。
- **方案**：catch 的 connectionFailure 和保底分支都补 `saveUnsent(question); setDraft(question);`（此时还没有会话，放回输入框即可，`composingNew` 仍为 true）：

  ```ts
  if (connectionFailure(error)) {
    saveUnsent(question);
    setDraft(question);
    service.showConnectionWarning();
    return;
  }
  if (sessionId === '') {
    saveUnsent(question);
    setDraft(question);
    setNotice(explain(error, text.connectionError));
  }
  ```

  注意 `sendFirstMessage` 在 `createSession` 成功后有一段 `setComposingNew(false)` 之前的窗口：若失败发生在建会话之后（question 已进线程），不该往输入框放回，判据就用现成的 `sessionId === ''`。
- **第三方库**：无。
- **风险**：低。
- **工作量**：S。

### P5. turnId 缺失时，续传轮询空转：文字永远不更新

> **已实现（2026-11-05）**：waiting 消息没有轮次编号时用 message.id 当保底定位键（startPolling 第三参、applyPartialText 的 fallbackKey 分支，只认还在等待中的那条），续传轮询不再静默失效。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「轮询与断线补查」。调研原文以 LayerFS 历史为准。

### P6. 没有错误边界：一条消息渲染炸了，整个应用白屏

> **已实现（2026-11-05）**：BubbleBoundary 包住每条消息——一条渲染炸了降级成纯文本气泡（原文照显），其余照常；PageBoundary 包住 App 根部——整页降级给「页面出了点问题」加「刷新页面」按钮（pageError/refreshPage 键，三语齐）。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「错误边界与降级」。调研原文以 LayerFS 历史为准。

### P7. 首问自动命名失败时静默回退，用户不知道标题没存上

> **已关闭（2026-11-06，维护者裁决）**：不加提示、不改行为——标题存不上时列表本就回退显示当前语言的「新对话」，这就是预期表现；下次发消息补写标题、自动恢复的路径保留。本节两个方案（Toast 提示 / 保留乐观标题）都不采纳。调研原文以 LayerFS 历史为准。

- **位置**：`/src/App.tsx` `submitMessage` 内 `missingTitle` 分支（L570 附近）：`saveTitle` 失败 → `updateSession` 把 title 设回 null，无任何提示。
- **现状**：FINDINGS.md「会话标题」条目记录了这个设计：标题为 NULL 的会话下次发消息会再补写一次。所以有自动补写的恢复路径，但当下用户看着侧栏标题从「首问原文」跳回「新对话」，没有任何解释。
- **影响**：轻微困惑；标题反复写不上时（比如后端 500）用户完全无从知晓。自动补写机制降低了严重度。
- **方案**：失败时弹已有的 Toast（`showToast(text.actionFailed)`）或干脆保持乐观标题不动、等下次补写——后者更符合「能自动补写」的现实：把 `updateSession(...title: null)` 的回退删掉，本地留着乐观标题，服务器没存上就下次再试。两种都是一行级改动，建议选后者（少一个提示、行为更符合直觉）。
- **第三方库**：无。
- **风险**：低。选「保留乐观标题」后，刷新页面标题会退回「新对话」，与 FINDINGS 记录的「不出现看着有标题数据库里没有」原则相抵——维护者若坚持该原则，就用 Toast 方案。
- **工作量**：S。

### P8. 重试按钮无加载态，慢网络下像没点上

> **已完成（2026-11-06）**：按 MessageActions 脚注的本地加载态完成——被点的重试按钮立即转圈（loading spinner）并禁用，防连点被 sendingRef 的防重复检查悄悄丢弃；引擎没接下（如找不到提问原文直接拒绝）时 2 秒后保底还原。另加一条本节没提的：会话有轮次正在进行（pending）时全部重试按钮一律禁用（retryBusy——服务器同一场会话只跑一轮，再点只会碰到 409）。FailedReply.tsx 已随第一期退役，本节位置行是历史快照。功能描述见 docs/MESSAGE_ACTIONS.md「行为规范」一节的 2026-11-06 补充。调研原文以 LayerFS 历史为准。

- **位置**：`/src/components/chat/FailedReply.tsx` L28-31（按钮无 disabled/loading）；`/src/hooks/use-turn-engine.ts` `retryTurn` L227（`sendingRef` 挡重复，但 UI 无反馈）。
- **现状**：点重试后旧气泡立刻消失（removeTurnAnswer/removeFailedNotice），新 waiting 气泡出现——正常情况有「正在思考」当反馈。但如果 `sendQuestion` 的 fetch 卡在连接阶段（弱网），waiting 气泡其实已经加了（L417 在 streamReply 之前），所以严格说有反馈；真正的空窗是「连点两次」：第二次被 sendingRef 悄悄丢弃，用户不知道第一次已生效。
- **影响**：小。主要是连点时的困惑，以及重试请求本身没有可视的 in-flight 状态。
- **方案**：给 FailedReply 加 `busy` prop（`pending && 该 turnId 的重试正在进行`，engine 已有 pendingIds 可推导），busy 时按钮 `disabled` + daisyUI `loading loading-spinner` 类。或者最简化：点击后立即在本地把按钮 disabled（组件内 state），等这条气泡被移除时自然消失。
- **第三方库**：无。
- **风险**：低。
- **工作量**：S。

### P9. `applyPartialText` 的 startsWith 防护会静默丢弃服务器更新（记录性提醒）

> **已随 done 事件批演化（2026-11-05）**：/partial 收窄成只回 streaming，这条防护的输入情况随之变化——applyPartialText 加了 fallbackKey 定位分支（P5 完成），startsWith 防护保留（仍防「页面文字倒退/不同源」）。本条的记录性提醒性质不变：改续传逻辑时别顺手拆掉这个防护。功能描述见 docs/CHAT_STREAM_PROTOCOL.md。调研原文以 LayerFS 历史为准。

---

## 建议的实施顺序

1. **先做一组 S 级、纯前端、互相独立的**：N1（自动滚动）、O1（rAF 节流）、P1/P2/P4（重试通路补全）、O4（enteringIds 泄漏）、N8（aria-live 收窄）。这一组把「日常最疼」和「弱网数据丢失」都堵上，且都不动状态归属。
2. **再做交互升级**：N2（多行输入）→ N3（按会话草稿）→ N9（流式可打字）→ N6/N4（复制按钮）。N2 是 N5（编辑重发）的前置。
3. **单独立项**：O2 第 2 步（流式文本与 sessions 解耦）、N5（编辑重发，跨前后端）、N7+P3（断线恢复，要按原 INTERRUPTED_REPLY.md——已退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md——的场景清单手测）、高亮库/虚拟化等依赖引入（维护者决策）。

所有涉及新界面文案的条目（N1 的「回到底部」、N6 的「复制」、N5 的「编辑/取消/发送」等）都要在 `/src/i18n.ts` 三种语言各补一条键，这是仓库惯例（MESSAGE_ACTIONS.md 也特别点了这一条）。

所有方案均不引入测试框架、不新增未被点名的依赖、密钥不进前端；UI 全部使用 daisyUI 5 组件类；气泡保持 `.chat` + `.chat-bubble` 双层结构；未触碰会话行/语言菜单浮层的 createPortal 约束。
