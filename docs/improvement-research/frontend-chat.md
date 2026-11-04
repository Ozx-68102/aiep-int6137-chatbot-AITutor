# 前端聊天主链路改进调研

调研日期：2026-11-04。只读调研，全部论断基于 `main@1eadc4e8c042` 的代码原文，关键处都标了文件和行号。

## 概览

### 读了哪些文件

- `/src/api/chat.ts`、`/src/api/messages.ts`、`/src/api/partial.ts`、`/src/api/http.ts`、`/src/api/failure.ts`、`/src/api/session.ts`
- `/src/hooks/use-turn-engine.ts`
- `/src/components/chat/` 全部七个文件（ChatMain.tsx、FailedReply.tsx、MarkdownText.tsx、ThinkingBubble.tsx、WarningBox.tsx、markdown.css、message-class.ts）
- `/src/session/` 全部八个文件（thread.ts、poll.ts、unsent.ts、text.ts、title.ts、pin-order.ts、empty.ts、profile-cache.ts）
- `/src/type/chat.ts`、`/src/App.tsx`（集成层，用于确认滚动/草稿/提交的实际行为）、`/src/i18n.ts`（文案键）、`/package.json`（依赖版本）
- 文档：`/docs/CHAT_STREAM_KNOWN_ISSUES.md`、`/docs/INTERRUPTED_REPLY.md`、`/docs/MESSAGE_ACTIONS.md`、`/docs/FINDINGS.md`

文档里已记录且已修好的事（轮询 401 死循环、被踢时输入丢失、422 detail 数组）不再重复报告；`remark-math` 吃 `$`、流式公式跳变、会话行浮层必须走 portal 这些已有记录的固有行为也不再当新问题提。

### 聊天主链路现状（数据流）

1. **输入**：`ChatMain.tsx` L161 是一个单行 `<input>`，值由 `App.tsx` 的顶层 `draft` state 控制。提交走原生 form submit（`submitMessage`，App.tsx L530 附近）。
2. **发送**：`submitMessage` 先本地追加一条 user 消息（带 `turnId = crypto.randomUUID()`），然后调 `use-turn-engine.ts` 的 `sendQuestion`（L404）；新会话首条走 `sendFirstMessage`（App.tsx L468），先 `POST /api/sessions` 建会话再发问。
3. **流式**：`sendQuestion` 调 `api/chat.ts` 的 `streamReply`（L16）→ `POST /api/chat`，SSE 逐帧解析（`readStream` L103、`pieceFromEvent` L142），每个文本块回调 `onDelta`。结局有五种：`completed` / `interrupted` / `not-started` / `aborted` / `busy`；`not-started` 会自动重发一次（L27-30）。
4. **渲染**：`onDelta` 每块都调 `applyStreamText`（use-turn-engine.ts L149）→ `updateSession` 全量替换 messages 数组 → `App.tsx` 顶层 `sessions` state 更新 → 整棵树（含 Sidebar）重渲染 → `MarkdownText`（memo，按 text 比较）对流式那条全量重解析 Markdown + KaTeX。
5. **断流恢复**：流断且无 `[DONE]` → `recoverReply`（L348）读 `GET /partial` 对账；服务器还在写就 `startPolling`（L295，500ms 固定间隔轮询 `/partial`，`session/poll.ts`）。刷新页面后由线程加载效果（L64-124）拉 `/messages` + `/partial`，`resumePartial`（L339）接上正在写的一轮。
6. **停止**：`stopSending`（L555）先本地 `abort()`，再由 `finishStop`（L512）调 `POST /abort` 并读 `/partial` 按服务器说的收尾。
7. **存储**：前端不存消息，历史全部来自服务器（自有 `message` 表 + FastGPT 回填）；本地只有 `h2bot-unsent`（sessionStorage 单槽，被踢/切会话时暂存未发送文本）和 `h2bot-profile`（localStorage，用户名+语言）。

整体评价：断流对账、轮次编号幂等、停止语义这些"难而正确"的部分做得扎实（与 INTERRUPTED_REPLY.md 的记录一致）。短板集中在**渲染与交互层**：没有任何滚动管理、单行输入框、草稿不分会话、流式期间全树重渲染，以及若干错误分支把"可重试"做成了"不可重试"。

---

## 一、新功能机会

### N1. 自动滚动跟随 + 「回到底部」按钮

- **位置**：`/src/components/chat/ChatMain.tsx` L67（滚动容器 `<div className="min-h-0 flex-1 overflow-auto p-4">`）。全仓库 grep `scrollIntoView` / `scrollTop` 在聊天区为零命中。
- **现状**：消息容器完全没有滚动管理。历史加载后停在顶部；流式回答往下长时视口不动，新文字长在屏幕外。
- **影响**：这是聊天产品的基础体验，现在用户必须手动拖着滚动条追回答；长回答时体验最差。也是本次调研里对日常使用影响最大的一条。
- **方案**：给容器加 ref，维护「贴底」状态：用户没主动上滚时，每次内容变化就滚到底；上滚后停止跟随并显示悬浮的「回到底部」按钮（daisyUI `btn btn-circle btn-ghost` + lucide `ArrowDown`，符合 UI 约束）。

  ```tsx
  // ChatMain.tsx
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const lastText = active?.messages.at(-1)?.text ?? '';

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [active?.id, active?.messages.length, lastText]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = atBottom;
    setShowJump(!atBottom);
  }
  // 容器：<div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto p-4">
  // 切换会话时重置：useEffect(() => { stick.current = true; setShowJump(false); }, [active?.id]);
  ```

  注意流式期间 `lastText` 每个 chunk 都变，配合 O1 的节流后此效果每帧最多跑一次，开销可忽略。
- **第三方库**：无。
- **风险**：低。「距底 48px 内算贴底」的阈值需要在真机上试一下；键盘弹起（移动端）会改变 clientHeight，贴底判断天然兼容。
- **工作量**：S。

### N2. 多行输入框：textarea 自动增高，Enter 发送 / Shift+Enter 换行

> **已实现（2026-11-04）**：按本节方案落地（autoGrow 封顶、Enter 发送 / Shift+Enter 换行、isComposing 防输入法误发），见 `ChatMain.tsx`。本节保留作调研记录。

- **位置**：`/src/components/chat/ChatMain.tsx` L161（`<input className="input min-w-0 flex-1">`）。grep 全仓库无 `textarea`。
- **现状**：单行 input，只能靠原生 form 行为回车提交。打不了换行，长问题看不全（只能横向滚动一小窗）。`/docs/MESSAGE_ACTIONS.md`「待定的问题」里也已经预见到多行输入的发送键问题。
- **影响**：AI 辅导场景里学生经常要贴多行的题目/代码，单行输入是硬伤；也是编辑重发功能（N5）的前置。
- **方案**：换成 daisyUI `textarea`，行数随内容自动增高（封顶约 160px 后内部滚动）；`Enter` 提交、`Shift+Enter` 换行；用 `e.nativeEvent.isComposing` 避开中文输入法组合期的回车误发。

  ```tsx
  const formRef = useRef<HTMLFormElement>(null);
  <form ref={formRef} className="flex items-end gap-2" onSubmit={onSubmit}>
    <textarea
      className="textarea min-h-10 max-h-40 flex-1 resize-none text-base"
      rows={1}
      value={draft}
      placeholder={text.placeholder}
      aria-label={text.placeholder}
      disabled={inputLocked}
      onChange={(event) => {
        onDraft(event.target.value);
        const el = event.currentTarget;
        el.style.height = '0px';
        el.style.height = `${el.scrollHeight}px`;   // max-h-40 之后由 CSS 接管滚动
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          formRef.current?.requestSubmit();
        }
      }}
    />
    {/* 发送/停止按钮不变，外层 items-center 改 items-end */}
  </form>
  ```

  草稿被程序性清空/恢复时（`setDraft`）高度要同步重置：把 autoGrow 抽成一个对 `draft` 的 effect，用 ref 拿 textarea 节点。
- **第三方库**：无。
- **风险**：中低。`isComposing` 在 Safari 的 keydown 上历史上有差异，需真机验证中文/日文输入法；表单从 `items-center` 改 `items-end` 后按钮对齐要过一眼。
- **工作量**：S~M（含三种语言的占位文案不变，无新文案）。

### N3. 草稿按会话分开存，刷新不丢

- **位置**：`/src/App.tsx` L82（全局单一 `draft` state）、L395 `rememberDraft`、L402 `showSession`（`setDraft('')`）、L411 `showNewChat`（`setDraft(readUnsent())`）；`/src/session/unsent.ts`（sessionStorage 单槽 `h2bot-unsent`）。
- **现状**：草稿是全局一份。切换会话时当前输入被存进 `h2bot-unsent` 单槽，但**切回的会话不恢复自己的草稿**（`showSession` 直接 `setDraft('')`），只有「新对话」会读回那个槽。两个会话各打一半的字，后存的覆盖先存的。整页刷新则全丢（`draft` 是内存 state，`unsent` 只在被踢/切换时写）。
- **影响**：学生写一半的长提问，切个会话或不小心刷新就没了；单槽覆盖会让「新对话」里出现别的会话的半截草稿，属于数据串味。
- **方案**：新增 `session/drafts.ts`，按会话 id 存 localStorage（`h2bot-draft:{sessionId}`，新对话用固定键 `h2bot-draft:new`），写入防抖 300ms；`showSession`/`showNewChat` 恢复对应草稿；发送成功后清除。`h2bot-unsent` 的既有语义（被踢存回、登录放回）保持不动，它管的是「已提交但没送达」，和草稿是两回事。

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

> **2026-11-05**：高亮库已定并已安装 **react-syntax-highlighter 16.1.2**（本节二选一里选它）。注意：该包不带类型声明，`@types/react-syntax-highlighter` 也还没装——接入前需要维护者补装类型包；装好之前若先接入，要用临时本地声明文件过渡。复制按钮不依赖高亮库，可先做。

- **位置**：`/src/components/chat/MarkdownText.tsx` L9-36（`components` 表只定制了 `a`/`img`/`table`，没有 `pre`/`code`）；`/src/components/chat/markdown.css` L107-124（`pre` 只有底色样式）。
- **现状**：助手回答里的代码块没有任何交互：不能复制，没有高亮（深色底 + 单色文字）。
- **影响**：AI 辅导回答经常带示例代码/公式推导代码，学生要手选深底文字复制，移动端几乎不可用。
- **方案**：在 `components` 表加 `pre` 定制，包一层带复制按钮的容器（lucide `Copy`/`Check` 图标，daisyUI `btn btn-ghost btn-xs`）。复制内容从 React 子树里递归抽字符串即可，不需要新依赖：

  ```tsx
  // MarkdownText.tsx
  pre({children}) {
    return <CodeBlock>{children}</CodeBlock>;
  }

  function nodeText(node: ReactNode): string {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(nodeText).join('');
    if (isValidElement(node)) return nodeText((node.props as {children?: ReactNode}).children);
    return '';
  }

  function CodeBlock({children}: {children: ReactNode}) {
    const [copied, setCopied] = useState(false);
    return (
      <div className="relative">
        <pre>{children}</pre>
        <button
          type="button"
          className="btn btn-ghost btn-xs absolute right-1.5 top-1.5 text-stone-300 hover:text-white"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={() => {
            void navigator.clipboard.writeText(nodeText(children)).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    );
  }
  ```

  流式期间代码块没闭合时 react-markdown 也会渲染出 `pre`，按钮出现得早但没有害处。语法高亮见「第三方库」，建议作为独立的后续决定，不和复制按钮绑在一起。
- **第三方库**（只做高亮时才需要，点名供维护者决定，二选一）：
  - `react-syntax-highlighter` ^15.6：用 `dist/esm/light` + 按需注册语言（`prism-light` build），只引 `tsx/python/java` 等课程常用语言可控制在 ~40-80 kB gzip；接入方式是 `components.code` 里按 `className="language-xxx"` 分发。
  - `lowlight` ^3 + `hast-util-to-jsx-runtime` 已有生态：更轻（core ~15 kB gzip + 每语言 1-3 kB），但要自己写 `code` 组件对接，工作量大一点。
  - 注意：FINDINGS.md 记录当前 js 产物已 716 kB（gzip 217 kB），加高亮前建议先做按语言动态 import（像 zxcvbn 字典那样只在遇到代码块时加载）。
- **风险**：复制按钮本身低（`navigator.clipboard` 在 http 非安全上下文不可用，本部署走 https/localhost 没问题，失败时静默即可）。高亮库引入是包体决策，中。
- **工作量**：复制按钮 S；加高亮 M。

### N5. 消息编辑重发（对齐 MESSAGE_ACTIONS.md，前端部分）

> **已实现（2026-11-04，MESSAGE_ACTIONS.md 第三期）**，其中一处决策与本节建议不同：编辑按钮只给**最后一轮**的用户提问（本节建议每个用户提问都给）；发送失败按 Gemini 式整轮回滚。本节的 `retryTurn(sessionId, turnId, editedText?)` 签名被采纳。现状以 [MESSAGE_ACTIONS.md](../MESSAGE_ACTIONS.md) 为准，本节保留作调研记录；下方「位置」行是历史快照——`ChatMain.tsx` L129-131 的 TODO 注释已随实现移除，行号也因重构漂移。

- **位置**：`/src/components/chat/ChatMain.tsx` L129-131 已有 TODO 注释指向 `/docs/MESSAGE_ACTIONS.md`；重试通路在 `/src/hooks/use-turn-engine.ts` `retryTurn` L226。
- **现状**：设计文档已写清产品形态（每轮下方小编辑按钮 → 展开修改框 → 右下角取消/发送，用户视角等同重试），并明确不做版本历史/分支；后端接口字段未定（`retryOf` 之外要带新提问文本）。前端没有任何实现。
- **影响**：问错字、想换问法时只能原句重试；另外 MESSAGE_ACTIONS.md 指出编辑重发顺带能清掉「被停止轮次在上游留下的悬空提问」。
- **方案**（前端侧，依赖后端加字段后才联调）：
  1. user 消息气泡下加 `chat-footer` 小编辑按钮（ghost/xs，lucide `Pencil`），点击进入编辑态：气泡原地换成 textarea（复用 N2 的 autoGrow）+ 取消/发送。
  2. 发送走 `retryTurn` 的变体：`engine.retryTurn(sessionId, turnId, newText)`；`retryTurn` 内部把本地 user 消息文本替换成 `newText` 再走既有流程（removeTurnAnswer → removeFailedNotice → 新 turnId → `sendQuestion(..., retryOf)`）。
  3. `api/chat.ts` 的请求体加 `editedText`（名字以后端为准）；`questionOfTurn` 不再需要按位置猜——编辑发送时文本是现成的。

  ```ts
  // use-turn-engine.ts
  async function retryTurn(sessionId: string, turnId: string, editedText?: string) {
    if (sendingRef.current.has(sessionId)) return;
    const question = (editedText ?? questionOfTurn(sessionId, turnId) ?? '').trim();
    if (question === '') { depsRef.current.setNotice(textRef.current.actionFailed); return; }
    if (editedText !== undefined) {
      depsRef.current.updateSession(sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.role === 'user' && isQuestionOfTurn(m, s.messages, turnId) ? {...m, text: editedText} : m),
      }));
    }
    // 其余与现有 retryTurn 相同
  }
  ```

  MESSAGE_ACTIONS.md 的待定项（哪些轮次给按钮、停止轮要不要给）建议按文档倾向落：只给用户自己的提问、被停止的轮次也给（正好清悬空记录）。
- **第三方库**：无。
- **风险**：中。跨前后端；「改前面某一轮，后面轮次留着」的语义要和后端删记录的范围对齐（文档倾向只动这一轮）。
- **工作量**：L（前端 M + 后端接口 + 联调，建议单独排期）。

### N6. 助手回答整体复制

- **位置**：`/src/components/chat/ChatMain.tsx` L98-137（assistant 分支只有气泡和「对话已停止」尾注，无任何操作区）。
- **现状**：回答只能手选复制。Markdown 渲染后手选会把表格、公式的排版一起带走，粘出来是乱的。
- **影响**：学生把回答粘进笔记是高频动作；复制原始 Markdown 比复制渲染结果有用得多。
- **方案**：在 assistant 气泡下加 `chat-footer`，hover/聚焦时显现一个复制小按钮，复制 `message.text`（原始 Markdown，不用序列化 DOM）。文案键三种语言各加一条（如 `copy` / `copied`）。结构上正好和 FailedReply 的 `chat-footer` 一致，样式已有先例。
- **第三方库**：无。
- **风险**：低。
- **工作量**：S。

### N7. 断线自动恢复：online 监听 + 回到前台补查

- **位置**：`/src/hooks/use-turn-engine.ts`（无任何网络状态监听）；grep 全仓库无 `'online'` 事件、无 `navigator.onLine`；`/src/session/poll.ts` 轮询失败一律 `continue`（L33-36）。`use-service-status.ts` 已有 visibilitychange 补查 `/api/status` 的先例（L140），但那只管服务横幅，不管正在写的回答。
- **现状**：网络闪断时流式请求断掉 → `recoverReply` 去读 `/partial` 也失败 → 走 catch（L352-356）：删掉半截回答、报「无法连接到服务器」（无 turnId，不可重试）。网络恢复后页面**不会**自动接上，用户只能手动刷新。
- **影响**：教室 Wi-Fi 抖动是常态场景；现在的行为把可恢复的瞬断放大成「回答消失 + 无法重试」。
- **方案**：
  1. 在 use-turn-engine 加 `window.addEventListener('online', ...)`：对每个仍在 `pendingIds` 的会话跑一次 `refreshThread(sessionId)`（已有，L489），它会自动 `resumePartial` 接上轮询。
  2. `visibilitychange` 变回可见时做同样的事（手机切后台常伴随断流）。
  3. 配合 P3：`recoverReply` 的 catch 不再删已收到的文本，改成保留 + 给带 turnId 的错误提示，网络回来后 `refreshThread` 会用服务器权威版本覆盖。

  ```ts
  useEffect(() => {
    const resume = () => {
      for (const id of Array.from(pendingIdsRef.current)) {
        void refreshThread(id);
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') resume(); };
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  ```

  （`pendingIdsRef` 是 pendingIds 的镜像 ref，套现有 depsRef 的写法。）
- **第三方库**：无。
- **风险**：低。`refreshThread` 失败已有静默兜底；重复触发只是多读一次线程。
- **工作量**：M。

### N8. 无障碍：aria-live 收窄、role="log"、流式状态通告

- **位置**：`/src/components/chat/ChatMain.tsx` L67：整个消息滚动容器挂着 `aria-live="polite"` + `aria-busy`；`ThinkingBubble.tsx` 有 `role="status"`（这个是对的）。
- **现状**：`aria-live` 挂在包含全部历史消息的大容器上。流式期间容器子树每个 chunk 都变，屏幕阅读器会反复播报变化区域——实际效果是把整条回答（甚至邻近消息）念个不停。
- **影响**：读屏用户基本没法用流式回答；普通用户无感知，但这属于正确性问题而不只是优化。
- **方案**：
  1. 滚动容器去掉 `aria-live`，保留 `aria-busy`，加 `role="log"` + `aria-label={会话标题}`（log 语义即「追加式消息记录」，浏览器对新增内容有默认的 polite 处理，且只针对追加节点）。
  2. 流式状态用独立的视觉隐藏 live region 通告里程碑，而不是每个字：

  ```tsx
  <span className="sr-only" role="status" aria-live="polite">
    {pending ? text.thinking : ''}
  </span>
  ```

  （`sr-only` 是 Tailwind 内置类。）pending 从 true 变 false 时读屏会播「空」，可改为播报 `replyDone` 之类的新文案键，或干脆只在开始时报「正在思考」、结束时静默。
  3. FailedReply / WarningBox 已有 role 处理，不动。
- **第三方库**：无。
- **风险**：低。需要一次 VoiceOver/NVDA 手测。
- **工作量**：S。

### N9. 流式期间允许继续打字

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

- **位置**：`/src/components/chat/ChatMain.tsx` L157-186（输入条 `px-4 pt-3 pb-4`）、L161 input；`/src/components/chat/message-class.ts`（气泡 `max-w-[600px]` 固定值）。
- **现状**：输入框用 daisyUI `input` 默认字号（0.875rem，小于 16px）；底部输入条没有 `env(safe-area-inset-bottom)` 处理；气泡最大宽是固定 600px 而不是随容器百分比。
- **影响**：iOS Safari 对字号 <16px 的输入框聚焦时会自动放大整页（需要核实 daisyUI 5 当前主题的实际字号，若确为 14px 则必现）；iPhone 横屏/刘海屏下发送按钮贴到圆角里；窄屏上 600px 上限虽不会被超过，但和容器 padding 叠加后气泡几乎贴满，观感可以更好。
- **方案**：input/textarea 加 `text-base`（16px，N2 的草图已带）；输入条 `pb-4` 改 `pb-[max(1rem,env(safe-area-inset-bottom))]`；气泡 `max-w-[600px]` 改 `max-w-[85%] md:max-w-[600px]`。三处都是纯 class 改动。
- **第三方库**：无。
- **风险**：低。`env()` 需要 index.html 的 viewport meta 带 `viewport-fit=cover` 才生效，要一起核实。
- **工作量**：S。

---

## 二、优化点

### O1. 流式 chunk 节流合批（rAF），消掉 O(n²) 的 Markdown 重解析

- **位置**：`/src/hooks/use-turn-engine.ts` L420-428（`streamReply` 的 onDelta 每 chunk 直接 `applyStreamText`）→ L149（每 chunk 一次 `updateSession`，全量 map messages）；`/src/components/chat/MarkdownText.tsx` L49（memo 只救「没变的消息」，流式那条每个 chunk 都全量重解析整段 Markdown + KaTeX）。
- **现状**：一个 chunk 一次 setState、一次全树渲染、一次对**当前全部已收文本**的 remark→rehype→KaTeX 管线。回答长 5000 字、chunk 平均 20 字时，约 250 次渲染 × 平均半程长度 ≈ 60 万字规模的重复解析，中低端设备（学生用平板）会明显掉帧。
- **影响**：流式期间页面卡顿、滚动不跟手（N1 做了自动滚动后会更明显）；风扇/耗电。
- **方案**：onDelta 先攒进 ref，`requestAnimationFrame` 合批 flush——每帧最多一次 setState/重解析，帧率 60 时渲染次数从「chunk 数」降到「秒数 × 60」，且天然和屏幕刷新对齐：

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
- **风险**：中。第 2 步动了 use-turn-engine 的状态归属，`applyPartialText`/`recoverReply` 等所有写文本的路径都要同步改；没有自动化测试，需要按 INTERRUPTED_REPLY.md 的场景清单手测（刷新续传、停止、重试、busy）。可以先只做第 1 步观察收益。
- **工作量**：第 1 步 S~M；第 2 步 M~L。

### O3. partial 轮询在后台标签页暂停

- **位置**：`/src/session/poll.ts` L5（`intervalMs = 500` 固定）、L19-41（while 循环，无 visibility 感知）。
- **现状**：只要有一轮在续传，标签页切到后台也每 500ms 打一次 `/api/sessions/{id}/partial`，直到落定。手机切出去、学生开了第二个标签页时全是无效请求。
- **影响**：服务器无谓负载（每个等待中的会话 2 req/s）、移动端耗电；对用户体验无损（回到前台才需要新数据）。
- **方案**：循环里加一个判断，隐藏时跳过 fetch 只等待；`visibilitychange` 回可见时立即补查一次：

  ```ts
  export function startPartialPolling(sessionId, onPartial, onEnd): () => void {
    let stopped = false;
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    async function tick() { /* 现在 poll() 循环体里的一次 fetch + 分发 */ }
    async function poll() {
      while (!stopped) {
        await wait(intervalMs);
        if (stopped) return;
        if (document.hidden) continue;   // 后台不发请求
        const done = await tick();
        if (done) return;
      }
    }
    void poll();
    return () => { stopped = true; document.removeEventListener('visibilitychange', onVisible); };
  }
  ```

  可再加指数退避（500ms 起、封顶 5s）进一步压请求量，但 500ms 是「刷新后接上」体验的一部分（INTERRUPTED_REPLY.md），退避要保守。
- **第三方库**：无。
- **风险**：低。注意停止函数里移除监听，避免泄漏。
- **工作量**：S。

### O4. enteringIds 泄漏：消息在动画结束前被移除时 id 永远留下

> **2026-11-04 注**：`removeFailedNotice` 已随 `role:'error'` 退役删除，泄漏路径收窄为 `removeTurnAnswer` / `removeTurn`（not-started 与重试分支仍会在进场动画期间删气泡，`use-turn-engine.ts` L493/L498）；`enteringIds` 仍是数组 + `includes`（App.tsx L81、L664，ChatMain.tsx L23/L40/L115）。本条仍然成立，位置行号已漂移，引用时以符号名定位。

- **位置**：`/src/App.tsx` L87（`enteringIds` 数组 state）、L331 `markEntering`、L672-674 `onAnimationEnd` 移除；移除消息的路径在 `use-turn-engine.ts`：`removeTurnAnswer` L193、`removeFailedNotice` L213、`removeTurn` L202。
- **现状**：id 靠气泡元素的 `animationend` 事件弹出。但重试路径会**在动画期间删元素**：`retryTurn`（L226）先 `removeTurnAnswer` + `removeFailedNotice`——如果失败气泡的 200ms 进场动画还没跑完（快速点重试、或低性能设备），它的 id 就永远留在 `enteringIds` 里。同理被 abort 清掉的 waiting 气泡。
- **影响**：慢性内存泄漏（每条几个十字节，量小但只增不减）；`enteringIds.includes` 在每条消息渲染时扫这个数组，泄漏越多渲染越慢（O(n×m)）；`prefers-reduced-motion` 用户不加 id，无此问题。
- **方案**：两个都便宜，建议一起做：
  1. `enteringIds` 改 `Set<string>`（state 里存 Set，替换时 new Set），查询 O(1)。
  2. 在三个 remove 函数里顺手清 id：App 传入一个 `forgetEntering(ids: string[])`（或 engine 的 deps 加一个 `removeEntering`），remove 前把被删消息的 id 交出去。更省事的兜底：`markEntering` 时同时 `setTimeout(() => setEnteringIds(cur => 删掉 id), 500)`，动画正常结束时 onAnimationEnd 先删、超时删是幂等的。
- **第三方库**：无。
- **风险**：低。
- **工作量**：S。

### O5. withConnectionRetry 对非幂等 POST 也盲目重试

- **位置**：`/src/api/http.ts` L26-42（`withConnectionRetry`：网络类错误重试 4 次、间隔 300ms）、L46/L61（`requestEmpty`/`requestJson` 全部走它）。
- **现状**：所有请求一视同仁地重试，包括 `POST /api/sessions`（建会话）、`POST /api/login`、`POST /abort`、`PATCH` 重命名/置顶。「网络错误」包含「请求已送达、响应在回程丢了」——这时重试建会话就会**建出两个会话**（第二个请求是全新请求，服务器没有理由拒绝）。
- **影响**：弱网下偶发重复会话/重复改名请求；`POST /api/chat` 不走这条路（它有自己的 turnId 幂等 + not-started 单次重发，设计正确），所以主要风险面是 createSession。
- **方案**：给 `requestEmpty`/`requestJson` 的 init 加 `retry?: boolean`（默认对 GET true、对非 GET false），或最小改动——只在 `createSession` 调用处关掉重试：

  ```ts
  // http.ts
  export async function requestJson(path: string, init?: {method?: string; body?: string | FormData; retry?: boolean}) {
    const run = async () => { /* 现有实现 */ };
    return init?.retry === false || (init?.method && init.method !== 'GET' && init?.retry !== true)
      ? run()
      : withConnectionRetry(run);
  }
  ```

  更彻底的做法是给建会话带客户端生成的幂等键，但要后端配合，先不做。
- **第三方库**：无。
- **风险**：低。非幂等请求不重试后，弱网下这些操作的失败率会从「几乎必成」变成「一次网络抖动就报错」，但配合现有 warning 横幅是可接受的，且比静默重复副作用好。
- **工作量**：S。

### O6. SSE 解析器对规范的偏差（健壮性）

- **位置**：`/src/api/chat.ts` L142-160 `pieceFromEvent`、L103-137 `readStream`。
- **现状**：三个偏差点：
  1. 一个事件里有多条 `data:` 行时，只处理第一条命中内容的行就 `return`，其余行被丢（SSE 规范：同事件多条 data 应以 `\n` 连接成一条）。
  2. 某条 `data:` 的 JSON 解析失败时直接 `return null`，同事件里后面的行（可能正是 `[DONE]`）不再看。
  3. 事件边界只认 `\n\n`，不认 CRLF 的 `\r\n\r\n`（`split('\n\n')` 对它切不开，整段滞留 buffer 直到流结束才可能被处理——好在 `done` 分支会把残余 buffer 当最后一个事件处理，L114-116）。
- **影响**：当前后端按 INTERRUPTED_REPLY.md 的约定原样中继 FastGPT 帧（每事件一条 data、`\n\n` 分隔），所以**今天不出错**；但解析器与后端实现细节强耦合，后端哪天换 SSE 库（或代理层改写换行）就会静默丢字/丢 DONE，且这种 bug 极难排查。
- **方案**：把 `pieceFromEvent` 改成按规范聚合：

  ```ts
  function pieceFromEvent(event: string): {kind: 'text'; text: string} | {kind: 'done'} | null {
    const dataLines: string[] = [];
    for (const rawLine of event.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return null;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return {kind: 'done'};
    try {
      const content = contentFromPayload(JSON.parse(data));
      return content ? {kind: 'text', text: content} : null;
    } catch {
      return null;   // 坏帧只丢这一帧
    }
  }
  ```

  `readStream` 的 `split('\n\n')` 同步改 `split(/\r?\n\r?\n/)`。
- **第三方库**：无（也不必引 eventsource-parser 这类库，二十行自己写清楚）。
- **风险**：低。行为对当前后端完全兼容。
- **工作量**：S。

---

## 三、未完善与潜在问题

### P1. 重试遇到「连不上」后，这一轮悬空：问题留着，却永远没有重试按钮

> **已随 MESSAGE_ACTIONS.md 第一期解决（2026-11-04），形态有变**：`FailedReply.tsx` 与 `role:'error'` 合成消息已退役。重试场景下 `onRollback` 会把旧轮连同常驻脚注（状态提示 + 重试按钮）恢复回原位（`use-turn-engine.ts` L497-511），不再悬空；首发「连不上」按新设计统一归横幅报（L491 注释「连不上归横幅报」、L513「不再往消息流里插错误消息」），不提供轮次级重试入口。下文的 `addErrorMessage` 方案已过时，保留作调研记录。

- **位置**：`/src/hooks/use-turn-engine.ts` `retryTurn` L226 → `sendQuestion` 的 catch：L464 先 `removeTurnAnswer`，L472-475 `connectionFailure` 分支只调 `onConnectionWarning()` 就 `return`，**不 addErrorMessage**。
- **现状**：点重试后如果这次请求属于「连接类失败」（断网、服务不可达），旧的失败气泡和半截回答已被 `retryTurn` 删掉，新的错误气泡又不生成——线程里只剩那条提问，没有任何错误提示、没有重试按钮。`sendingRef` 在 finally 里清了，输入框能用，但这一轮就悬在那儿：想重问只能手动重新输入同样的话（而服务器上游那轮的记录也没人清理）。
- **影响**：弱网下「点重试 → 提示都没了 → 无法再重试」，用户视角是功能坏了。首次发送走同一 catch，但首发场景 connectionFailure 分支同样不 addErrorMessage——首发的提问是本地追加的，留在线程里同样悬空（只是首次发送时 App 层还有 showConnectionWarning 的横幅，稍微好一点）。
- **方案**：connectionFailure 分支也放一条**带 turnId** 的错误消息，让 FailedReply 出来：

  ```ts
  if (connectionFailure(error)) {
    addErrorMessage(sessionId, textRef.current.connectionError, depsRef.current.locale, turnId);
    depsRef.current.onConnectionWarning();
    return;
  }
  ```

  横幅和气泡会同时出现，语义不重复（横幅说服务状态，气泡给这一轮的重试入口）；如果嫌重复，可只在会话级横幅不可用时加气泡。重试的新 turnId 已经通过 `retryOf` 报给服务器，再点重试依旧走幂等路径，安全。
- **第三方库**：无。
- **风险**：低。注意 `questionOfTurn` 按「错误气泡前最近一条提问」找问题，这个新气泡的位置满足该假设（它总在提问之后追加）。
- **工作量**：S。

### P2. `not-started` 的错误气泡不带 turnId，明明可以重试却给不出按钮

> **已随 MESSAGE_ACTIONS.md 第一期解决（2026-11-04）**：错误气泡这一形态已不存在——`not-started` 现在走 `removeTurnAnswer` + 横幅提示 + 重试场景 `onRollback` 恢复旧轮的脚注重试入口（`use-turn-engine.ts` L490-496），`FailedReply.tsx` 已删除。本条的一行修复随架构更新失去意义，保留作调研记录。

- **位置**：`/src/hooks/use-turn-engine.ts` L458-461：`outcome === 'not-started'` 时 `addErrorMessage(sessionId, connectionError, locale)`——第四个参数 `turnId` 没传；对照 `ChatMain.tsx` L86：`role === 'error' && turnId !== undefined` 才渲染带重试按钮的 FailedReply。
- **现状**：`not-started` 的语义恰恰是「请求没落地、服务器根本没有这一轮、重发安全」（chat.ts L9-10 的注释原文），而且 `streamReply` 已经自动重发过一次仍失败才走到这里。这时页面显示的是一条普通红色气泡，没有重试按钮。
- **影响**：最该给重试入口的分支反而没有；用户只能重新打字发送。同轮上下文（FastGPT 侧）没有污染，重试完全安全。
- **方案**：一行改动：`addErrorMessage(sessionId, textRef.current.connectionError, depsRef.current.locale, turnId)`。重试路径 `retryTurn` 会把这条气泡清掉重发，`questionOfTurn` 也能按位置找回提问。
- **第三方库**：无。
- **风险**：低。
- **工作量**：S。

### P3. `recoverReply` 问不到服务器时，把已经收到的半截回答删了

- **位置**：`/src/hooks/use-turn-engine.ts` L348-357：`readPartial` 抛错 → `removeTurnAnswer(sessionId, turnId)` + 无 turnId 的 connectionError 气泡；L358-363 的「Redis 里是别的轮次」分支同样删。
- **现状**：流断时页面上往往已经渲染了几百字（`delivered === true` 才返回 interrupted，chat.ts L76-82）。恢复对账只是问不到服务器（比如网络瞬断），就把用户眼前的文字整段删掉。
- **影响**：网络抖一下 = 回答凭空消失且不可重试（错误气泡没 turnId，见 P2 同款问题）；服务器那边这一轮很可能还在写、几秒后就能对上账。这是弱网下最伤用户信任的行为。
- **方案**：对账失败时**保留已收文本**，把气泡标成「疑似中断」而不是删除；错误消息带 turnId 给重试入口；配合 N7 的 online 监听，网络回来后 `refreshThread` 会用服务器版本覆盖本地（`applyPartialText` 的 startsWith 防护正好保证只前进不后退）。

  ```ts
  try {
    partial = await readPartial(sessionId);
  } catch {
    // 问不到服务器：文字留在页面上，给可重试的提示，等网络回来再对账。
    addErrorMessage(sessionId, textRef.current.connectionError, depsRef.current.locale, turnId);
    return;
  }
  ```

  「Redis 里是别的轮次」分支（L358）保留删除是合理的（那些文字确实不属于这一轮），但同样应带上 turnId 让可重试性一致。
- **第三方库**：无。
- **风险**：中低。保留的文字可能不是服务器最终版（少了尾部），刷新后会被 `/messages` 的权威版替换；要在手测清单里加「瞬断→保留→恢复→刷新对账」一条。
- **工作量**：M（含 N7 联动测试）。

### P4. 新会话首条消息发送失败时，问题文本丢失

- **位置**：`/src/App.tsx` `submitMessage` L530 附近（发送前 `clearUnsent(); setDraft('')`）→ `sendFirstMessage` L468 的 catch：L505-508 只有 401 分支 `saveUnsent(question)`；L511-513 `connectionFailure` 分支 showConnectionWarning 后直接 return；L514-516 其他错误且 `sessionId === ''` 时只 setNotice。
- **现状**：用户在「新对话」里打了字点发送，`submitMessage` 立刻清空输入框和 unsent 缓存；如果 `createSession` 或首问因网络类错误失败，question 哪儿都没存——界面上没有（会话都没建出来）、unsent 没有、服务器没有。CHAT_STREAM_KNOWN_ISSUES.md 第 10 条修的是「被踢」路径，这条 connectionFailure 路径是同一个洞的另一半，还没堵。
- **影响**：弱网下新对话首发失败 = 用户输入直接蒸发，和已修的第 10 条同等严重。
- **方案**：catch 的 connectionFailure 和兜底分支都补 `saveUnsent(question); setDraft(question);`（此时还没有会话，放回输入框即可，`composingNew` 仍为 true）：

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

- **位置**：`/src/hooks/use-turn-engine.ts` `applyPartialText` L163-165（`turnId === ''` 直接 return）、`resumePartial` L339-345（`waiting.turnId ?? ''`）、`stopSending` L556（`entry?.turnId ?? ''`）。
- **现状**：历史消息的 `turn_id` 允许为 null（messages.ts L9，来自上游回填的老记录没有编号）。刷新后如果 waiting 气泡恰好没有 turnId，`resumePartial` 用 `''` 起轮询：`applyPartialText` 每次都早退，轮询会一直跑到状态落定、清 pending，但**半截文字一个都不会应用到页面**——用户看着「正在思考」直到突然结束，回答内容要等下一次手动刷新才出现。`finishStop` 走到 `startPolling(sessionId, turnId='')` 的分支（L536）同理。
- **影响**：边界场景（服务器把无编号的 waiting 行拼进历史时）续传静默失效；按 INTERRUPTED_REPLY.md，当前服务器拼当前轮时带 Redis 里的编号，正常路径 turnId 都在——所以是低概率但完全静默的失效，出了也难查。
- **方案**：turnId 缺失时退化为按「waiting 消息的 id」定位：`applyPartialText` 加一个 fallback 参数，或 `resumePartial` 在 `waiting.turnId` 为空时把 `waiting.id` 当定位键传下去，`applyPartialText` 改成「先按 turnId 找，找不到且定位键非空就按 message.id 找」。同时 `startPolling` 的 onPartial 闭包同步带上这个键。

  ```ts
  function resumePartial(sessionId: string, messages: Message[]) {
    const waiting = messages.find((m) => m.waiting === true);
    if (waiting === undefined) return;
    setPendingIds((current) => new Set(current).add(sessionId));
    startPolling(sessionId, waiting.turnId ?? '', waiting.id); // 第三参：兜底定位键
  }
  ```
- **第三方库**：无。
- **风险**：低。要小心「按 id 定位」时别把已完成的旧消息当成续传目标——限定只在 `waiting === true` 的消息上兜底。
- **工作量**：S。

### P6. 没有错误边界：一条消息渲染炸了，整个应用白屏

- **位置**：`/src/App.tsx`、`/src/components/chat/ChatMain.tsx`——全仓库无 ErrorBoundary（grep `componentDidCatch`/`getDerivedStateFromError` 零命中）。
- **现状**：Markdown/KaTeX 管线（remark-math、rehype-katex）对畸形输入大多有兜底（FINDINGS.md 记录过 KaTeX 出错显示原文），但 react-markdown 的 components 定制、`nodeText` 之类的递归、未来任何人加的渲染逻辑一旦抛错，React 19 会卸载整棵树——用户看到白屏，正在流式的回答也断了。
- **影响**：低概率、高杀伤。聊天应用的正确姿势是「坏的那条降级显示，其余照常」。
- **方案**：加一个类组件 ErrorBoundary（React 19 没有函数式等价物），包在 `MessageItem`（O2 抽出来后）或至少包在消息列表 map 的每一项外面；出错时降级为 `<p className="chat-bubble">{原始文本}</p>` 并给一条 console.error：

  ```tsx
  class BubbleBoundary extends Component<{fallback: string; children: ReactNode}, {failed: boolean}> {
    state = {failed: false};
    static getDerivedStateFromError() { return {failed: true}; }
    componentDidCatch(error: unknown) { console.error('message render failed', error); }
    render() {
      return this.state.failed ? <p className="chat-bubble whitespace-pre-wrap">{this.props.fallback}</p> : this.props.children;
    }
  }
  ```

  另外在 App 根部再包一层整页 boundary（给「刷新页面」按钮），防 Sidebar 等非消息区域。
- **第三方库**：无（不必引 react-error-boundary，二十行自己写）。
- **风险**：低。
- **工作量**：S。

### P7. 首问自动命名失败时静默回退，用户不知道标题没存上

- **位置**：`/src/App.tsx` `submitMessage` 内 `missingTitle` 分支（L570 附近）：`saveTitle` 失败 → `updateSession` 把 title 设回 null，无任何提示。
- **现状**：FINDINGS.md「会话标题」条目记录了这个设计：标题为 NULL 的会话下次发消息会再补写一次。所以有自愈路径，但当下用户看着侧栏标题从「首问原文」跳回「新对话」，没有任何解释。
- **影响**：轻微困惑；标题反复写不上时（比如后端 500）用户完全无从知晓。自愈机制降低了严重度。
- **方案**：失败时弹已有的 Toast（`showToast(text.actionFailed)`）或干脆保持乐观标题不动、等下次补写——后者更符合「有自愈」的现实：把 `updateSession(...title: null)` 的回退删掉，本地留着乐观标题，服务器没存上就下次再试。两种都是一行级改动，建议选后者（少一个提示、行为更符合直觉）。
- **第三方库**：无。
- **风险**：低。选「保留乐观标题」后，刷新页面标题会退回「新对话」，与 FINDINGS 记录的「不出现看着有标题库里没有」原则相抵——维护者若坚持该原则，就用 Toast 方案。
- **工作量**：S。

### P8. 重试按钮无加载态，慢网络下像没点上

- **位置**：`/src/components/chat/FailedReply.tsx` L28-31（按钮无 disabled/loading）；`/src/hooks/use-turn-engine.ts` `retryTurn` L227（`sendingRef` 挡重复，但 UI 无反馈）。
- **现状**：点重试后旧气泡立刻消失（removeTurnAnswer/removeFailedNotice），新 waiting 气泡出现——正常情况有「正在思考」当反馈。但如果 `sendQuestion` 的 fetch 卡在连接阶段（弱网），waiting 气泡其实已经加了（L417 在 streamReply 之前），所以严格说有反馈；真正的空窗是「连点两次」：第二次被 sendingRef 静默吞掉，用户不知道第一次已生效。
- **影响**：小。主要是连点时的困惑，以及重试请求本身没有可视的 in-flight 状态。
- **方案**：给 FailedReply 加 `busy` prop（`pending && 该 turnId 的重试在飞`，engine 已有 pendingIds 可推导），busy 时按钮 `disabled` + daisyUI `loading loading-spinner` 类。或者最简化：点击后立即在本地把按钮 disabled（组件内 state），等这条气泡被移除时自然消失。
- **第三方库**：无。
- **风险**：低。
- **工作量**：S。

### P9. `applyPartialText` 的 startsWith 防护会静默丢弃服务器更新（记录性提醒）

- **位置**：`/src/hooks/use-turn-engine.ts` L177-179：`if (!partial.text.startsWith(message.text)) return session;`。
- **现状**：这是防「Redis 半截文本比页面已收文本短/不同源」的正确防护（FINDINGS.md 2026-10-30 那条事故的教训）。但如果服务器侧 Redis 文本被重置（`begin_reply` 清 key 重来，INTERRUPTED_REPLY.md 有记录）而页面还留着旧文本，轮询更新会被永久静默丢弃，页面停在旧文本直到刷新。
- **影响**：极低概率（要求同一会话在页面不刷新的情况下开新一轮且新轮编号与旧气泡相同——正常情况下新轮是新 turnId，走 L167 的「补气泡」分支），列出来是为了在改 O2/P3/P5 时别顺手把这个防护拆了。
- **方案**：不改行为；建议加一行 `console.warn`（带 sessionId/turnId/两个长度），真发生时日志里有迹可循。若 P5 的兜底定位实装，这里同步检查即可。
- **第三方库**：无。
- **风险**：无。
- **工作量**：S。

---

## 建议的落地顺序

1. **先做一组 S 级、纯前端、互相独立的**：N1（自动滚动）、O1（rAF 节流）、P1/P2/P4（重试通路补全）、O4（enteringIds 泄漏）、N8（aria-live 收窄）。这一组把「日常最疼」和「弱网数据丢失」都堵上，且都不动状态归属。
2. **再做交互升级**：N2（多行输入）→ N3（按会话草稿）→ N9（流式可打字）→ N6/N4（复制按钮）。N2 是 N5（编辑重发）的前置。
3. **单独立项**：O2 第 2 步（流式文本与 sessions 解耦）、N5（编辑重发，跨前后端）、N7+P3（断线恢复，要按 INTERRUPTED_REPLY.md 场景清单手测）、高亮库/虚拟化等依赖引入（维护者决策）。

所有涉及新界面文案的条目（N1 的「回到底部」、N6 的「复制」、N5 的「编辑/取消/发送」等）都要在 `/src/i18n.ts` 三种语言各补一条键，这是仓库惯例（MESSAGE_ACTIONS.md 也特别点了这一条）。

所有方案均不引入测试框架、不新增未被点名的依赖、密钥不进前端；UI 全部使用 daisyUI 5 组件类；气泡保持 `.chat` + `.chat-bubble` 双层结构；未触碰会话行/语言菜单浮层的 createPortal 约束。
