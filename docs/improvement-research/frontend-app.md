# 前端应用外壳改进调研

调研对象：H^2 Bot 前端应用外壳（`/src` 下除 `components/chat`、`api/chat.ts`、`api/messages.ts`、`api/partial.ts`、`hooks/use-turn-engine.ts` 之外的全部，以及配套文档）。基线：`main@1eadc4e8c042`。

## 概览

### 读过的文件

- 入口与接线：`/src/App.tsx`（739 行）、`/src/main.tsx`、`/src/index.css`、`/src/i18n.ts`（201 行，三语全部读完）、`/src/type/locale.ts`、`/src/type/chat.ts`、`/index.html`、`/vite.config.ts`、`/package.json`
- hooks：`use-path-routing.ts`、`use-narrow-screen.ts`、`use-password-change.ts`、`use-profile-actions.ts`、`use-service-status.ts`、`use-session-actions.ts`（`use-turn-engine.ts` 属聊天侧，不在本次范围）
- 组件：`sidebar/`（Sidebar、SessionRow、RenameSession、ConfirmDelete、class）、`settings/`（SettingsModal、ChangePasswordPage、ConfirmLogout、AvatarPicker、PasswordStrength、password-strength）、`login/LoginScreen`、`language/LanguageMenu`、`admin/`（AdminConsole、AdminLoginForm、ConfirmAdminLogout、ConfirmResetPassword、NewPasswordPanel）、`shell/`（Modal、frame-class）、`toast/Toast`、`avatar/AvatarImage`、`close-button/CloseButton`
- API 层：`http.ts`、`session.ts`、`profile.ts`、`status.ts`、`admin.ts`、`failure.ts`
- session 辅助：`profile-cache.ts`、`unsent.ts`、`pin-order.ts`、`title.ts`、`empty.ts`、`text.ts`、`thread.ts`（只读了与外壳相关的部分）
- 文档：`/docs/ACCOUNT_MANAGEMENT.md`、`/docs/PARENT_PORTAL_PRIVACY.md`、`/docs/UI_WARNINGS.md`、`/README.md`、`/AGENTS.md`

### 应用外壳结构简述

**路由**：`App.tsx` 顶层是 `BrowserRouter`，只有两条路由——`/admin` 整页渲染 `AdminConsole`（聊天侧引导完全不挂载），`/*` 交给 `ChatApp`。`ChatApp` 内部再由 `usePathRouting` 认四类地址：`/`（新建对话）、`/chat/:id`（会话）、`/password`（改密独立页）、`/login`（登录）。不带 id 的 `/chat` 和未知路径由归位效果 `navigate('/', {replace: true})` 送回根路径；已登录站在 `/login` 由 `claimPath` 送回根路径。深层链接（直接打开分享地址）可用：刷新 `/chat/:id` 时启动效果拉完会话列表后 `claimPath` 认领对应会话；直接打开 `/password` 记为 `direct` 进入方式，取消时就地替换路径。

**状态放哪**：没有全局状态库。约 20 个 `useState` 全部集中在 `ChatApp` 组件里（auth、locale、sessions、activeId、draft、notice、view、toast、sidebarOpen 等），按职责拆出六个 hook（路由、窄屏、改密、资料、服务状态、会话动作），hook 依赖以回调形式传入、在效果里镜像进 ref（`depsRef` 模式）以避免响应式依赖。`AdminConsole` 是完全独立的一棵状态树。持久化只有两处：localStorage 的 `h2bot-profile`（用户名 + 语言，离线时保底，退出清掉，刻意设计）和 sessionStorage 的 `h2bot-unsent`（被强制下线时保住没发出去的那句话）。

**API 层分工**：`http.ts` 是唯一的 fetch 封装（`credentials: 'include'`、`withConnectionRetry` 4 次 × 300ms 连接重试、`ApiError(status, detail)`）；`session.ts` / `profile.ts` / `status.ts` / `admin.ts` 各管一组端点，响应全部经手写 `isXxx` 运行时校验，形状不对抛 `ApiError(0, null)`；`failure.ts` 两个函数：`explain`（有 detail 用 detail，否则用「无法连接到服务器」）和 `connectionFailure`（非 ApiError 或 detail 为 null 就算连接类失败）。错误呈现遵守 `/docs/UI_WARNINGS.md` 的三种位置：会话相关进输入区上方 WarningBox、弹窗表单错误行内红字、成功用 Toast。

**主题与 i18n**：`index.css` 关掉 daisyUI 内置主题，只注册自定义 `aiep` 亮色主题（stone/emerald 色板的 oklch 值），另挂了 `tailwind-bootstrap-grid` 插件。i18n 是单文件平铺 key 的三语对象（zh-CN / zh-TW / en，各约 65 个 key），`satisfies Record<Locale, Record<string, string>>`。

**打包现状**：`dist/assets` 只有单个 `index-*.js` 主包（grep 证实 admin 控制台代码、SSE 解析全在里面）；zxcvbn 字典已经是动态 import 懒加载；katex CSS 全局引入。无 manualChunks、无路由级拆包。

下面三节共 33 条。每条的工作量：S ≈ 半天内，M ≈ 一到三天，L ≈ 一周上下。所有方案都遵守硬约束：不引入测试框架、UI 用 daisyUI 5 组件类、第三方库只点名推荐、`Modal.tsx` 的 `opacity-100 scale-100` 不动、浮层保持 createPortal、提示文案归置遵守 UI_WARNINGS.md。

---

## 一、新功能机会

### N1. 会话状态通道（SSE）：expired / disabled 状态与在原页面重新登录

> **部分实现（2026-11-05）**：最小 HTTP 版已完成——会话类 401 的响应体带 reason 字段（词表 expired/disabled；disabled 因停用列未建暂时发不出），前端 auth 为 ready 时收到带 reason 的 401 进「会话过期后留在原页面的状态」：会话、消息、草稿、profile 缓存全保留，输入区禁用、常驻警示条，expired 给「重新登录」直接在当前页面弹出 Modal 内嵌 LoginScreen，成功走 openAccount + resetForLogin + bumpThreadRetry 原地恢复；不带 reason 的 401 回退旧的整页登录路径。GET /api/events 推送通道未做，仍是 backlog（设计见 docs/ACCOUNT_MANAGEMENT.md「会话状态通道」）。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「会话过期后留在原页面的状态」和 docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md「401 带原因」。调研原文以 LayerFS 历史为准。

### N2. 会话列表搜索框

> **暂缓（2026-11-05 决定）**：随后端「会话规模化」（backend-api N2/N3/O10）同批暂缓，触发条件见那边的注记。

- **位置**：`/src/components/sidebar/Sidebar.tsx`；`/src/i18n.ts` 加一个 key。
- **现状**：侧栏只有「新建」按钮 + 全量平铺列表，会话一多只能滚动找。
- **影响**：学生用了一个学期后列表几十条，找旧会话费时；这是聊天产品侧栏的标配能力。
- **方案**：纯客户端过滤，加在「创建新对话」按钮下面：

  ```tsx
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const visible =
    needle === ''
      ? ordered
      : ordered.filter((session) =>
          sessionTitle(session, text.newChat).toLowerCase().includes(needle),
        );
  // …
  <label className="fieldset">
    <span className="fieldset-label sr-only">{text.searchSessions}</span>
    <input
      className="input input-sm w-full"
      type="search"
      value={query}
      lang={htmlLang[locale]}
      placeholder={text.searchSessions}
      onChange={(event) => setQuery(event.target.value)}
    />
  </label>
  ```

  注意 FLIP 重排动画（`useLayoutEffect` 里那套）会对过滤后的顺序变化生效，行为正确但搜索时每敲一个字都重排；搜索态可以跳过动画（`needle !== ''` 时不记录 rowTops）。空结果给一行 `text.searchNoMatch`（新 key，三语）。
- **第三方库**：无。
- **风险**：低。列表未虚拟化，过滤本身是 O(n)，几百条内无感。
- **工作量**：S。

### N3. 会话列表按日期分组、显示时间

> **暂缓（2026-11-05 决定）**：随后端「会话规模化」（backend-api N2/N3/O10）同批暂缓，触发条件见那边的注记。

- **位置**：`/src/api/session.ts`（`sessionFromItem`）、`/src/type/chat.ts`（`Session` 类型）、`/src/components/sidebar/Sidebar.tsx`、`/src/i18n.ts`。
- **现状**：`SessionItem.created_at` 已经被运行时校验（`isSessionItem` 里 `typeof value.created_at === 'string'`），但 `sessionFromItem` 直接把它丢掉了——数据到手却没带上界面。列表只有「置顶在前、其余按创建时间倒序」，没有任何时间信息。
- **影响**：用户分不清哪条是今天的、哪条是上个月的；分组（今天 / 昨天 / 最近 7 天 / 更早）是低成本高感知的整理手段。
- **方案**：`Session` 加 `createdAt: string`，`sessionFromItem` 带上 `createdAt: item.created_at`；`Sidebar.tsx` 在 `orderSessions` 之后按天分组渲染 `<li>` 小标题（sticky 的分组头，daisyUI 无现成组件，用 `text-xs text-stone-500` 一行即可，或 `menu-title`）：

  ```ts
  // src/session/pin-order.ts 追加
  export function groupByRecency(sessions: Session[], now: Date): {label: GroupLabel; items: Session[]}[] {
    // GroupLabel = 'pinned' | 'today' | 'yesterday' | 'week' | 'older'
    // 按 createdAt 的本地日期与 now 比较分桶；pinned 桶保持在最前。
  }
  ```

  分组标题的日期比较用本地时区（`new Date(item.createdAt)` 后比 `toDateString()`），不要按 UTC 切天。五条新 i18n key（今天/昨天/最近7天/更早/已置顶）。
- **第三方库**：无（不要为这个引 date-fns/dayjs）。
- **风险**：改动 `Session` 类型会波及 chat 目录里构造 Session 的地方（`emptySession`、turn-engine），要一起过一遍 `tsc --noEmit`。
- **工作量**：M。

### N4. 控制台里管理员改自己密码的入口

- **位置**：`/src/components/admin/AdminConsole.tsx`；复用 `/src/components/settings/ChangePasswordPage.tsx` 与 `/src/hooks/use-password-change.ts`。
- **现状**：后端 `/api/password` 已经认 `admin_login` cookie（ACCOUNT_MANAGEMENT.md：「管理员改自己的密码也走这个端点……控制台里的界面入口是后续批次」），前端控制台只有账号表 + 重置 + 退出，管理员想改自己密码只能去学生端？不行——`/admin` 整页渲染，聊天侧的 `/password` 路由根本不挂载，管理员在控制台里没有任何入口。
- **影响**：预设账号 `admin`/`admin` 文档要求「登录后应尽快改密码」，但界面上无处可改，只能靠重置别人顺带重置自己（体验绕远）。
- **方案**：`AdminConsole` 加一个 `view: 'accounts' | 'password'` 状态，header 里加按钮切到 password 视图，直接复用现成组件：

  ```tsx
  const password = usePasswordChange({
    locale,
    onPasswordChanged: () => {
      // 服务端已吊销所有设备登录：回登录表单并带提示。
      enterLoginForm(text.passwordChanged);
    },
    onEnterLogin: (detail) => enterLoginForm(detail),
    onConnectionWarning: () => setLoginError(text.connectionRetry),
  });
  // view === 'password' 时：
  <ChangePasswordPage
    locale={locale}
    username={adminUsername}
    error={password.error}
    busy={password.busy}
    onSubmit={password.submit}
    onCancel={() => setView('accounts')}
  />
  ```

  `ChangePasswordPage` 目前唯一的学生端假设是密码最小长度 6（`newPasswordRejected` 硬编码为 6，admin 角色后端门槛是 8）——加一个 `minLength?: 6 | 8` prop，admin 侧传 8，门槛消息同步（见 P5 的 i18n 化一起做）。控制台自己的密码改了之后本机也会被强制下线，`enterLoginForm(text.passwordChanged)` 正好接住。
- **第三方库**：无。
- **风险**：`usePasswordChange` 的 `onEnterLogin(null)` 语义在聊天侧会导航 `/login`，控制台侧要用 `enterLoginForm` 接，不能把 hook 里的导航假设带过来——检查后确认 hook 本身不碰路由，安全。
- **工作量**：M。

### N5. 重置密码面板精修：复制按钮 + 点背景不能关

> **已完成（2026-11-06）**：复制按钮已完成（密码行右侧；clipboard 失败静默——面板 `select-all` 仍可手动选中复制；「已复制」2 秒复位，`copy`/`copied` 键复用）。点背景、按 Esc 都不能关——实现没给 Modal 加 `closeOnBackdrop` prop，而是给 Modal 传 no-op `onClose` 占位、面板的显式关闭按钮直接调用真 `onClose`（Modal 自身行为零改动，其余弹窗不受影响）。功能描述见 docs/ACCOUNT_MANAGEMENT.md「控制台」一节。调研原文以 LayerFS 历史为准。

- **位置**：`/src/components/admin/NewPasswordPanel.tsx`、`/src/components/shell/Modal.tsx`；ACCOUNT_MANAGEMENT.md「后续批次」已列此待办（「三行大字、右侧复制按钮、点背景不能关」）。
- **现状**：`Modal.tsx` 背景 `onClick={onClose}` 是硬编码的，一次性密码面板点一下背景就没了，而密码「只显示这一次，关掉之后就再也拿不到」——误点背景的代价是必须再重置一次。密码文字有 `select-all` 但没有复制按钮。
- **影响**：管理员手滑丢密码，得重走一遍重置流程；移动端没有鼠标选择，`select-all` 基本不可用，复制按钮是刚需。
- **方案**：给 `Modal` 加可选 prop（默认值保持现状，全部现有弹窗不受影响；面板上的 `opacity-100 scale-100` 反制类原样保留）：

  ```tsx
  export function Modal({
    open, titleId, panelClass, onClose,
    closeOnBackdrop = true,
    children,
  }: {
    open: boolean; titleId: string; panelClass: string;
    onClose: () => void;
    /** 一次性密码这类「关掉就没了」的面板传 false。Esc 也一并禁掉。 */
    closeOnBackdrop?: boolean;
    children: ReactNode;
  }) {
    // 背景层：onClick={closeOnBackdrop ? onClose : undefined}
    // Esc 效果里：if (!closeOnBackdrop) return;
  }
  ```

  `NewPasswordPanel` 传 `closeOnBackdrop={false}`，密码行右侧加复制按钮：

  ```tsx
  const [copied, setCopied] = useState(false);
  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(shown?.password ?? '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板 API 不可用（非安全上下文等）：退回 select-all，用户手动复制。
    }
  }
  // <button type="button" className="btn btn-sm btn-outline" onClick={() => void copyPassword()}>
  //   {copied ? text.copied : text.copy}</button>
  ```

  两个新 i18n key（copy / copied），三语。
- **第三方库**：无。
- **风险**：低。`closeOnBackdrop=false` 时确认面板仍有显式关闭按钮（现有关闭按钮和「关闭」btn 都在）。
- **工作量**：S。

### N6. 登录页：忘记密码静态提示 + 用户名自动聚焦

> **已完成（2026-11-06）**：用户名输入框 `autoFocus`；密码栏下方加静态提示「忘记密码？请联系管理员」（`forgotPasswordHint` 键，三语齐）。「记住用户名」预填没做（`h2bot-profile` 退出即清是刻意设计，本节风险段的理由成立）。功能描述见 docs/ACCOUNT_MANAGEMENT.md「忘记密码」一节。调研原文以 LayerFS 历史为准。

- **位置**：`/src/components/login/LoginScreen.tsx`、`/src/i18n.ts`。
- **现状**：ACCOUNT_MANAGEMENT.md「忘记密码」一节写了「登录页可以先放一句静态提示（『忘记密码请联系管理员』），不依赖验证通道」，未做。学生忘记密码时界面上没有任何指引。用户名输入框没有 `autoFocus`（改密弹窗的输入框有）。
- **影响**：目标用户是小三学生，忘记密码只会反复试或放弃；一句提示就把路指到管理员/老师那里，零成本。
- **方案**：密码 fieldset 下方加一行：

  ```tsx
  <p className="m-0 text-xs text-stone-500" lang={htmlLang[locale]}>
    {text.forgotPasswordHint}
  </p>
  ```

  三语 key：「忘记密码？请联系管理员」/「忘記密碼？請聯繫管理員」/「Forgot your password? Please contact your administrator.」。用户名 `input` 加 `autoFocus`。不建议做「记住用户名」预填：`h2bot-profile` 退出即清是刻意设计，另存一份用户名会绕开这个决定，且共用电脑场景有隐私顾虑。
- **第三方库**：无。
- **风险**：无。文案要不要加、何时加，文档说「跟控制台一起定」，落笔前找维护者确认一句。
- **工作量**：S。

### N7. 全局键盘快捷键

> **维护者决定不做（2026-11-06）**：本条整体不做——不做全局快捷键（新建对话、开关侧栏、窄屏浮层 Esc）。弹窗与菜单侧的键盘可达性是另一回事，已随 P6 完成补齐。调研原文以 LayerFS 历史为准。

- **位置**：`/src/App.tsx`（ChatApp），或抽 `/src/hooks/use-hotkeys.ts`。
- **现状**：没有任何快捷键。新建对话要移动鼠标点侧栏按钮（窄屏还得先开侧栏）；窄屏侧栏浮层没有 Esc 关闭（只有点背景）。
- **影响**：高频动作（新建对话、开关侧栏）键盘不可达；对键盘用户和无障碍都是缺口。
- **方案**：ChatApp 挂一个 window 级 keydown（走 ref 拿最新回调，与现有 `navigateRef` 同套路）：

  ```ts
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        shellRef.current.addSession();          // Cmd/Ctrl+K 新建对话
      } else if (mod && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        shellRef.current.toggleSidebar();       // Cmd/Ctrl+B 开关侧栏
      } else if (event.key === 'Escape' && narrowRef.current && sidebarOpenRef.current) {
        shellRef.current.closeSidebar();        // 窄屏浮层 Esc 收
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  ```

  注意与 `Modal` 的 Esc 效果（capture 阶段 + `stopPropagation`）不冲突：Modal 开着时它的监听先拦下事件，bubble 阶段的这个不会触发。输入框里 Cmd+K 也会被拦，这是惯例行为（ChatGPT 同款），可接受。
- **第三方库**：无（两三个键不值得引库）。
- **风险**：低。快捷键只在聊天侧生效，`/admin` 不挂。
- **工作量**：S。

### N8. 全局 ErrorBoundary：别让白屏成为唯一故障形态

> **已完成（2026-11-05）**：落点与本节方案略有出入——边界做成了两层且都挂在 App.tsx 里：PageBoundary 包住整页 JSX（整页渲染炸了降级为「页面出了点问题」提示加「刷新页面」按钮，三语 pageError/refreshPage 键），BubbleBoundary 包住单条消息（一条炸了降级成纯文本气泡、原文照显）。main.tsx 入口没有再包一层，App 自身函数体抛的异常不在边界覆盖内——实际主要故障形态（子树渲染炸）已覆盖。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「错误边界与降级」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/main.tsx`、新增 `/src/components/shell/ErrorBoundary.tsx`。
- **现状**：`main.tsx` 直接 `createRoot(...).render(<App/>)`，全树没有任何错误边界。渲染期任何一处抛异常（比如后端某天返回了校验漏网的形状、某个 `null.toFixed`）整页白屏，控制台之外零信息。
- **影响**：无测试、无监控的项目里，白屏是最糟的失败形态：用户不知道发生了什么，也做不了任何操作。
- **方案**：React 错误边界目前只支持 class 组件，30 行以内：

  ```tsx
  // src/components/shell/ErrorBoundary.tsx
  import {Component, type ErrorInfo, type ReactNode} from 'react';

  export class ErrorBoundary extends Component<
    {children: ReactNode},
    {failed: boolean}
  > {
    override state = {failed: false};

    static getDerivedStateFromError(): {failed: boolean} {
      return {failed: true};
    }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
      console.error('页面出错了', error, info.componentStack);
    }

    override render(): ReactNode {
      if (!this.state.failed) {
        return this.props.children;
      }
      return (
        <main className="flex h-full items-center justify-center bg-base-200 p-4">
          <div className="card w-full max-w-sm border border-base-300 bg-base-100">
            <div className="card-body gap-4">
              <h1 className="card-title">H^2 Bot</h1>
              <p className="m-0">页面出了点问题，重新加载一下。</p>
              <button type="button" className="btn btn-primary"
                onClick={() => window.location.reload()}>
                重新加载
              </button>
            </div>
          </div>
        </main>
      );
    }
  }
  ```

  文案三语化的话需要把 locale 传进来（boundary 在 App 外层拿不到 locale 状态，可以先读 `readCachedProfile()?.locale ?? localeFromSystem()`）。`main.tsx` 里包在 `<App/>` 外面。
- **第三方库**：无（`react-error-boundary` 能做的这个场景手写 30 行就够，不必加依赖）。
- **风险**：低。边界只接住渲染错误，事件处理器里的异常接不住（那是现有 try/catch 的职责）。
- **工作量**：S。

### N9. 头像上传客户端预校验（大小 / 格式）

> **已完成（2026-11-06）**：实现比本节草图更严——大小 ≤5MB；格式认 HEIC/HEIF 全族 MIME（单图 `image/heic`、`image/heif` 与多帧 `-sequence` 变体，IANA 注册口径），`file.type` 为空串退按扩展名判（png/jpg/jpeg/heic/heif），Windows Chrome 的 .heic 不被误拦。拒绝提示是当场一行 `role=alert`（`avatarTooLarge`/`avatarWrongType` 三语）、不发请求；服务端校验仍是权威。功能描述见 docs/ACCOUNT_MANAGEMENT.md「头像」一节。调研原文以 LayerFS 历史为准。

- **位置**：`/src/components/settings/AvatarPicker.tsx` 或 `/src/hooks/use-profile-actions.ts` 的 `pickAvatar`；`/src/i18n.ts` 加 key。
- **现状**：`avatarHint` 写着「支持格式：PNG/JPG/JPEG/HEIC，大小不超过5MB」，但选择文件后不做任何本地检查，直接 `POST /api/avatar`，靠服务器拒绝。
- **影响**：传一个 20MB 的照片要等整个上传走完才收到错误，移动端流量和时间都白白消耗；错误还是服务器中文 detail（见 P4）。本地能判定的提前拦掉，跟改密页「客户端硬门槛」的既有做法一致。
- **方案**：`pickAvatar` 开头加：

  ```ts
  const maxAvatarBytes = 5 * 1024 * 1024;
  const allowedAvatarTypes = new Set(['image/png', 'image/jpeg', 'image/heic', 'image/heif']);

  function avatarRejected(file: File, text: Copy): string | null {
    // HEIC 在部分浏览器 file.type 为空串：退按扩展名判。
    const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
    const typeOk = allowedAvatarTypes.has(file.type) ||
      (file.type === '' && ['heic', 'heif', 'png', 'jpg', 'jpeg'].includes(ext));
    if (!typeOk) return text.avatarWrongType;
    if (file.size > maxAvatarBytes) return text.avatarTooLarge;
    return null;
  }
  ```

  拒绝时 `setProfileError(...)`（现成的显示位），三语 key 两条。注意这是提示不是门槛，后端校验保持权威（与 ACCOUNT_MANAGEMENT.md 的分工原则一致）。
- **第三方库**：无。
- **风险**：低。`file.type` 为空的保底判断要留着，不然 Windows 上 HEIC 会被误拦。
- **工作量**：S。

### N10. 断网即时感知：window online/offline 事件接入服务状态

> **已完成（2026-11-06）**：实现比本节草图深一层——`offline` 立即挂既有服务横幅（`connectionRetry` 文案）；`online` 不轻信，主动 `GET /api/status` 确认，失败按 1s/2s/4s…封顶 15s 指数退避，世代编号（confirmGeneration）作废旧循环，防两条确认循环并存，`navigator.onLine` 为假时暂停等下一次 online；确认请求进行期间，常规 30 秒周期与可见性补查都让路。确认成功后 30 秒定时器倒计时清零重挂（任何时刻只有一个定时器），并广播 window 事件 `h2bot:network-ok`（poll.ts 导出 networkOkEvent）：500ms 续传轮询立即开始下一次，use-turn-engine 的断线补查也改听它（不再听 raw online，避免双份补查）。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「轮询与断线补查」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/hooks/use-service-status.ts`。
- **现状**：服务降级靠 30 秒一轮的 `/api/status` 轮询和动作失败时的 `showConnectionWarning()`。浏览器断网（WiFi 掉线）时，如果用户没有触发任何动作，最坏要等 30 秒才看到「无法连接到服务器」；期间点发送要先收到 fetch 失败。
- **影响**：学校场景 WiFi 不稳很常见，即时告知能少一批「点了没反应」的困惑。
- **方案**：轮询效果里加两个监听（`markService` 与 `check` 经 ref 取）：

  ```ts
  const onOffline = () => markServiceRef.current('unreachable');
  const onOnline = () => {
    // 网络回来了：立刻查一次，不用等下一轮 30 秒。
    void checkRef.current();
  };
  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);
  // cleanup 里对称移除
  ```

  `offline` 事件是 `navigator.onLine` 的可靠信号；`online` 只说明网卡通了不代表后端活了，所以是「立刻 check 一次」而不是直接 `markService('ok')`——现有 `check` 里 `wasDown → refreshWorkspace()` 的逻辑正好接上。
- **第三方库**：无。
- **风险**：低。注意 `check`/`markService` 要过 ref，避免把它们变成效果依赖导致轮询重启。
- **工作量**：S。

### N11. 动态 document.title（会话名进标签页）

> **已完成（2026-11-06）**：`useDocumentMeta(locale, pageTitle?)` 已实现（src/hooks/use-document-meta.ts）——聊天页「{会话名} - H^2 Bot」（会话名超 30 字符截断加省略号；无标题、新对话、未登录都只是「H^2 Bot」），管理台「管理员控制台 - H^2 Bot」（adminConsole 键）；连接符取半角连字符（本节草图的间隔号未用）。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「标签页标题与 html lang」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/App.tsx` 的 locale 效果、`/src/components/admin/AdminConsole.tsx` 同款效果。
- **现状**：两处效果都硬编码 `document.title = 'H^2 Bot'`。开多个会话标签页时（深层链接 `/chat/:id` 就是为分享和重开设计的）标签页全长一样，无法区分。
- **影响**：多标签使用场景找不到目标页；一行改动的事。
- **方案**：抽一个小 hook 统一两处（顺带解决 O8 的重复）：

  ```ts
  // src/hooks/use-document-meta.ts
  export function useDocumentMeta(locale: Locale, pageTitle?: string | null): void {
    useEffect(() => {
      document.documentElement.lang = htmlLang[locale];
      document.title =
        pageTitle !== null && pageTitle !== undefined && pageTitle !== ''
          ? `${pageTitle} · H^2 Bot`
          : 'H^2 Bot';
    }, [locale, pageTitle]);
  }
  ```

  ChatApp 传 `active ? sessionTitle(active, text.newChat) : null`；标题可能很长，截断到 30 字符左右再加后缀。AdminConsole 传 `text.adminConsole`。
- **第三方库**：无。
- **风险**：低。会话标题是学生输入，`document.title` 是纯文本赋值无注入风险。
- **工作量**：S。

### N12. 多标签页语言/资料同步（storage 事件）

> **已完成（2026-11-06）**：`h2bot-profile` / `h2bot-avatar` 变更当场应用语言、用户名、头像（头像半边超出本节范围，随 P12 的 dataURL 缓存一起完成）。登出同步按 `h2bot-logout` 标记键做（值=时间戳）：signOut 成功写入、openAccount 清除，其他标签页听到 `newValue ≠ null` 走 `enterLoginGuarded`——留在原页面的过期状态就保持在原页面、否则整页登录路径，正打的字照旧存 unsent。本节草图的 `loggedOutElsewhere` 提示文案未采用；服务器侧吊销不靠标记，仍走收到 401 后保底处理的路径（分工依据注在 profile-cache.ts 注释）。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「多标签页同步」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/App.tsx`（ChatApp），数据源 `/src/session/profile-cache.ts`。
- **现状**：`h2bot-profile` 只在本页写入。同一浏览器开两个标签页，A 里把语言从简中切到英文，B 不动；A 里退出登录（清掉缓存），B 的界面照常是登录态直到下一次 401（N1 的通道能治本，这条是零后端依赖的过渡）。
- **影响**：多标签不一致是小概率但真实的困惑源；storage 事件是浏览器原生能力，成本极低。
- **方案**：

  ```ts
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== 'h2bot-profile') return;
      if (event.newValue === null) {
        // 别的标签页退了登录：本标签页也回登录界面（带上说明）。
        enterLoginRef.current(text.loggedOutElsewhere);
        return;
      }
      const cached = readCachedProfile();
      if (cached !== null) {
        setLocale(cached.locale);   // 语言跟着切
        setUsername(cached.username);
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  ```

  新 i18n key `loggedOutElsewhere`（「已在其他标签页退出登录」）。若 N1 完成，`h2bot-logout` 这类过渡信号可以退役，语言同步这半保留。
- **第三方库**：无。
- **风险**：中低。「别的标签页退出就把本页强制退回登录」是把双刃剑：cookie 是全浏览器共享的，强制退回是对的，但正在打的草稿要靠 `enterLogin` 里现成的 `saveUnsent` 保住（已有）。
- **工作量**：S。

### N13. 深色主题

> **维护者决定不做（2026-11-06）**：维持亮色单主题（index.css 只注册 aiep 亮色主题、刻意不带 dark），深色主题不列入计划。调研原文以 LayerFS 历史为准。

- **位置**：`/src/index.css`；可选在设置弹窗加切换项（`SettingsModal.tsx` + 后端 profile 字段）。
- **现状**：`index.css` 明确只注册 `aiep` 亮色主题，并且刻意不带 daisyUI 内置 dark（注释写了原因：dark 会在系统深色模式下盖掉 aiep 变量）。全站无深色。
- **影响**：晚间使用刺眼；对「系统深色 + 网页亮色」的不一致观感有用户会提。这是产品决定级的事项，不是纯技术缺口——现有注释表明亮色单主题是有意为之。
- **方案**：若维护者决定要做，路径是现成的：再注册一个 `aiep-dark` 主题（`@plugin 'daisyui/theme'`，`color-scheme: dark`，把 stone/emerald 色板映射成暗色 oklch），HTML 根元素按偏好挂 `data-theme`。跟随系统用 `prefers-color-scheme` 媒体查询自动切；手动切换则需要把偏好存进账号（后端 profile 加字段）或 localStorage。语义类（`bg-base-200`、`text-error`）已全面使用，组件层几乎零改动；要排查的是散落的硬编码颜色（`text-stone-500/600`、`bg-stone-900/40` 背景遮罩、`border-stone-300`），这些在深色下对比度会失衡，需换成 `text-base-content/60` 这类语义写法。
- **第三方库**：无（daisyUI 自带多主题机制）。
- **风险**：硬编码 stone 色的地方不少（Sidebar、SessionRow、Modal 遮罩、多处提示文字），逐个排查是体力活；改错一处就是深色下的对比度事故。没有自动化测试，只能三种语言 × 明暗两套逐页手点。
- **工作量**：L。

---
## 二、优化点

### O1. 拆分 ChatApp 巨型组件

- **位置**：`/src/App.tsx`（739 行，单组件约 660 行）。
- **现状**：`ChatApp` 持有约 20 个 `useState` + 8 个 ref，六个 hook 虽然抽出去了，但它们的接线（十几个回调 props）、登录流程（`submitLogin`/`openAccount`/`enterLogin`）、草稿与首发消息流程（`rememberDraft`/`sendFirstMessage`/`submitMessage`）、侧栏开合（`openSidebar`/`closeSidebar`/`sidebarWanted`）全都还平铺在组件体里。之前已有一轮 `refactor-split-app-controller` 分支做过拆分，现在这版是拆过的结果，但组件仍然偏大。
- **影响**：任何一处改动都要通读全组件理清 ref 镜像关系（`depsRef`/`navigateRef`/八个 xxxRef），新改动的回归风险高；没有测试保底，认知负担就是唯一的防线，值得把它降下来。
- **方案**：继续按现有 hook 模式抽三块，不动渲染树：
  1. `use-auth-flow.ts`：`auth`、`loginOffline/loginDetail/loginNotice/loginSubmitting`、`submitLogin`、`openAccount`、`enterLogin`、启动效果（`listSessions` 引导）。`enterLogin` 需要清的旁路状态（draft、sessions、engine、password、profileApi、sessionActions）以回调集合传入，保持现在的 ref 取用法。
  2. `use-composer.ts`：`draft/draftRef`、`composingNew/sendingNew`、`rememberDraft`、`sendFirstMessage`、`submitMessage`、unsent 缓存读写。
  3. `use-sidebar.ts`：`sidebarOpen`、`sidebarWanted`、`openSidebar/closeSidebar`、窄屏恢复效果。
  每抽一块就跑 `pnpm exec tsc --noEmit` + `pnpm check` + `pnpm build`，并手点：登录 → 新建会话 → 发消息 → 改名/删除/置顶 → 改密 → 退出 → 断网提示 → 窄屏开合。一次一个提交，出问题好回退。
- **第三方库**：无。
- **风险**：中高——这是纯重构里最容易碰坏 ref 时序的一类（hook 效果执行顺序、`depsRef` 镜像时机都有讲究，注释里自己都写了「本 hook 的效果比主控的 ref 同步效果先跑」）。没有自动化测试，只能小步提交 + 每步手点。属 AGENTS.md 定义的大改动，动手前要许可。
- **工作量**：L。

### O2. 路由级代码拆分：/admin 懒加载 + vendor 分块

> **已完成（2026-11-06）**：两半都完成。`/admin` 改 `React.lazy` ＋ `Suspense`（fallback 是控制台 checking 占位同款的空白 div `h-full bg-base-200`，不引入新文案），独立分块 `AdminConsole-*.js` 10.86 KB（gzip 2.98 KB），主块 124 KB；vendor 分块走 `build.rolldownOptions.output.codeSplitting.groups`（Vite 8 是 rolldown 内核，本节 `manualChunks` 草图已废弃）——`vendor-react` 254.74 KB、`vendor-markdown` 413.63 KB，与高亮树共享的 14 个包显式排除在分组外保按需块自包含，highlighter 45.6 KB 按需块不变。分块加载失败（页面开着时发布了新版本）另有保底处理：`vite:preloadError` 由 PageBoundary 之外的 ChunkFailureToast 监听，弹「有新版本了，刷新页面即可」（newVersionRefresh 三语），模块级标志一次页面会话只弹一条；lazy 的 rejection 由 PageBoundary 接住。功能描述见 docs/TECH.md「前端」与 docs/CHAT_PAGE_BEHAVIOR.md「错误边界与降级」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/App.tsx`、`/vite.config.ts`。
- **现状**：`AdminConsole` 及其五个子组件被 `App.tsx` 静态 import，`dist/assets` 里只有单个 `index-*.js`：每个学生、每次访问登录页，都下载了管理员控制台、聊天 Markdown/KaTeX 渲染管线的全部代码。zxcvbn 字典已经懒加载了（做得对），但组件层没有拆。
- **影响**：首屏 JS 体积无谓增大；`/admin` 本来就和聊天侧「完全无关」（代码注释原话），是最干净的一刀。
- **方案**：

  ```tsx
  // src/App.tsx
  import {lazy, Suspense} from 'react';
  const AdminConsole = lazy(() => import('./components/admin/AdminConsole.tsx'));

  <Route
    path="/admin"
    element={
      <Suspense fallback={<div className="h-full bg-base-200" />}>
        <AdminConsole />
      </Suspense>
    }
  />
  ```

  再进一步（可选）：`vite.config.ts` 加 `build.rollupOptions.output.manualChunks`，把 `react`/`react-dom`/`react-router` 与 `katex`/`react-markdown`/`remark-*`/`rehype-katex` 分成两个 vendor 块——业务代码改动时用户不必重新下载 React 和 KaTeX。`ChatMain` 不建议懒加载：它是主内容，拆了反而让登录后多一次请求瀑布。
- **第三方库**：无。
- **风险**：低。`lazy` 的 fallback 与现有 `checking` 占位同款；manualChunks 配置错了顶多是分块不理想，构建产物照跑。
- **工作量**：S。

### O3. i18n 类型加强：缺 key 从「运行时 undefined」变成编译错误

- **位置**：`/src/i18n.ts` 尾部的 `satisfies Record<Locale, Record<string, string>>`。
- **现状**：`Record<string, string>` 允许三个语言对象各有一套不同的 key：`en` 少写一个 key，类型检查不报错，运行时 `text.someKey` 是 `undefined`，界面渲染成空白。UI_WARNINGS.md 要求「三种语言都要有」，现在这条规矩只靠人肉。三语对象各 60+ key、还在持续加（本调研就提了十来条新 key），漏写只是时间问题。
- **影响**：缺 key 的 bug 静默、难查（空白文字不报错），且只在使用了那个功能的那个语言下出现。
- **方案**：以 zh-CN 为形状基准，让另外两语必须提供全部 key：

  ```ts
  const zhCN = {
    sessions: '会话',
    // …全部 key
  };
  export type Copy = typeof zhCN;

  export const translations: Record<Locale, Copy> = {
    'zh-CN': zhCN,
    'zh-TW': {sessions: '對話', /* 缺任何一个 key 都过不了 tsc */},
    en: {sessions: 'Chats', /* 同上 */},
  };
  ```

  组件侧 `translations[locale]` 类型不变（`Copy`），零改动。顺手删掉已死的 `switchLanguage` key（全仓 grep 无使用，三语各一条）。
- **第三方库**：无。
- **风险**：极低。改完 `tsc --noEmit` 立刻暴露现有缺漏（如果有）。
- **工作量**：S。

### O4. 清除无用内容：未使用的 `tailwind-bootstrap-grid` 插件与无用的 key

- **位置**：`/src/index.css` 的 `@plugin 'tailwind-bootstrap-grid'` 块、`/package.json` devDependencies、`/src/i18n.ts` 的 `switchLanguage`。
- **现状**：全仓 grep（除 node_modules/.pnpm-store/dist）找不到任何 `row`/`col-*`/`offset-*`/`g-*` 栅格类的使用——插件注册的 utility 一个都没被用上；`switchLanguage` key 定义了三次、使用零次。AGENTS.md 还专门为这个插件记过一条 CSS 注释坑（`col-*/offset-*` 写法会截断注释）。
- **影响**：Tailwind v4 的 utility 按需生成，未使用类不进产物，所以 CSS 体积影响小；真正的成本是依赖树里多一个包、index.css 里多一段要小心的配置、以及「新人以为项目在用 bootstrap 栅格」的误导。
- **方案**：删掉 `index.css` 里的 `@plugin 'tailwind-bootstrap-grid'` 块，请维护者 `pnpm remove tailwind-bootstrap-grid`（依赖只能维护者动）。删除后跑 `pnpm build` 对比产物确认无变化，再全仓 grep 复核一遍 `col-`/`row` 确实无使用。若维护者说「留着以后排版用」，至少把配置注释里写明「当前无使用处」。
- **第三方库**：无（这是移除依赖，方向相反）。
- **风险**：低，但要防 grep 漏网：`chat/markdown.css` 里若有 `.row` 之类的自定义类不算数（那不是插件产物），删插件前把 `dist` 前后 diff 一遍最稳。
- **工作量**：S。

### O5. 启动引导并行化：listSessions 与 readProfile 同时发

- **位置**：`/src/App.tsx` 启动效果（`useEffect(..., [])` 里 `listSessions().then(async items => { profile = await readProfile(); ... })`）。
- **现状**：串行两个请求：先等 `/api/sessions` 回来，再发 `/api/profile`，都到了才 `setAuth('ready')`。学校网络下每个来回几百毫秒，白屏占位（`bg-stone-100` 空 div）时间是两者之和。
- **影响**：登录后/刷新后的可交互时间无谓翻倍；两个请求互不依赖（401 处理逻辑也一样），没有串行的理由。
- **方案**：

  ```ts
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [items, profile] = await Promise.all([
          listSessions(),
          readProfile().catch((error: unknown) => {
            // profile 拉不到不拦启动：401 往外抛给统一处理，其它错误当 null。
            if (error instanceof ApiError && error.status === 401) throw error;
            return null;
          }),
        ]);
        if (cancelled) return;
        const next = sessionsFromList(items);
        setSessions(next);
        routingRef.current.claimPath(next);
        if (profile) {
          setUsername(profile.username);
          setLocale(profile.locale);
          setAvatarUrl(profile.avatarUrl);
          saveCachedProfile({username: profile.username, locale: profile.locale});
        }
        setAuth('ready');
      } catch (error) {
        // 现有的 401 / connectionFailure / 其它三分支原样搬进来
      }
    })();
    return () => { cancelled = true; };
  }, []);
  ```

  语义差异要留意：现在 profile 的非 401 失败会被吞掉、照常 `ready`（username 留 null），而 sessions 失败才走错误分支——并行版保持一致（`catch` 里返回 null 那步）。StrictMode 下双执行照旧被 `cancelled` 接住。
- **第三方库**：无。
- **风险**：中低。启动路径是核心链路，错误分支的搬迁要逐条对照；改完手点四种场景：正常登录、cookie 过期（401）、后端没起（connectionFailure）、profile 500。
- **工作量**：S。

### O6. 登录响应直接带全 profile，省掉登录后的第二次 readProfile

- **位置**：`/src/api/session.ts`（`LoginResult`）、`/src/App.tsx`（`openAccount`）、后端 `/api/login`。
- **现状**：`POST /api/login` 返回 `{locale, sessions}`，`openAccount` 之后又 fire-and-forget 一次 `readProfile()` 拿 username 和 avatarUrl。每次登录固定两个来回，且 profile 回来前侧栏用户名短暂显示保底文案。
- **影响**：登录到「界面完整」的时间多一个 RTT；`openAccount` 里那段 `.then/.catch` 补偿逻辑（401 再 `enterLogin`）是纯粹为第二个请求存在的。
- **方案**：后端在登录响应里加 `username`、`avatar_url` 两个字段（数据就在手边），前端：

  ```ts
  export type LoginResult = {
    locale: string;
    username: string;
    avatarUrl: string;
    sessions: SessionItem[];
  };
  ```

  `openAccount` 直接 `setUsername/setAvatarUrl/saveCachedProfile`，删掉整段 `readProfile().then(...)`。向后兼容期可以用 `isRecord` 判断字段缺失时退回旧路径，等后端上线后删。
- **第三方库**：无。
- **风险**：跨栈改动（动接口契约，按 AGENTS.md 要维护者许可）；登录是核心链路，前后端要同一批上线。
- **工作量**：M（前端 S，后端与联调另算）。

### O7. Toast 状态统一：删掉组件内的第二套计数

> **已完成（2026-11-06）**：Toast props 改 `{toast: {id, text} | null, lang, onDismiss}`，组件内第二套计数与渲染期 `wasMessage` 比较删除；id 唯一来源是 App 的 `toastCount`，`closing` 由 `closingId` 派生、`key={toast.id}` 驱动节点重建与动画重播——连续同文案不同 id 的提示各播各的、3 秒计时从零重计。`lang` 由父级按当前 locale 现算传入。多条堆叠没做（本节结论一致：单条替换维持现状）。机制见 src/components/toast/Toast.tsx 注释与 App.tsx 的 `showToast`。调研原文以 LayerFS 历史为准。

- **位置**：`/src/App.tsx`（`toast` state + `toastCount` ref + `showToast`）、`/src/components/toast/Toast.tsx`（内部 `counter` state + `wasMessage` 渲染期比较）。
- **现状**：同一条 toast 有两套 id 机制：App 里 `toastCount.current += 1` 生成 `{id, text, lang}`，Toast 组件内部又维护 `counter`，靠渲染期比较 `message !== wasMessage` 决定重播动画。Toast 的 props 却只接 `message: string | null`——App 生成的 id 根本没传进去，两条连续的同文案 toast（比如连删两个会话都弹「已删除」）会因为 `message` 字符串没变而不重播动画，甚至第二条被 `wasMessage` 比较吞掉。
- **影响**：连续同文案提示的动画/计时不重播是小 bug；双份状态是维护负担。
- **方案**：把 App 已有的 id 传给组件，组件内不再造 id：

  ```tsx
  // App.tsx
  <Toast toast={toast} lang={htmlLang[locale]} onDismiss={() => setToast(null)} />
  // toast state: {id: number; text: string} | null（lang 由当前 locale 现算，不用快照）

  // Toast.tsx props 改为 {toast: {id: number; text: string} | null; lang: string; onDismiss: () => void}
  // 内部以 toast?.id 为 key 驱动「重播动画 + 重置 3 秒计时」：
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(onDismissRef.current, showMs);
    return () => window.clearTimeout(timer);
  }, [toast?.id]);
  ```

  渲染元素 `key={toast.id}`，同文案不同 id 也会整节点重建、动画重播。`lang` 改为随当前 locale 现算（现在的快照行为在「toast 显示中途切语言」时会拿旧 lang，现算更对）。顺带评估：要不要支持多条堆叠？UI_WARNINGS.md 没要求，单条替换（新的顶掉旧的）维持现状即可，别新造浮层样式。
- **第三方库**：无。
- **风险**：低。改动局限在两个文件；手点「连删两个会话」验证动画重播。
- **工作量**：S。

### O8. 抽 `useDocumentMeta`，消除两处重复的 lang/title 效果

> **已完成（2026-11-06）**：与 N11 同批完成——`useDocumentMeta(locale, pageTitle?)` 统管 html lang 与 title 两件事，ChatApp 与 AdminConsole 的两处重复效果已删除、各换成一行调用。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「标签页标题与 html lang」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/App.tsx` 与 `/src/components/admin/AdminConsole.tsx` 各有一个一模一样的 `useEffect(() => { document.documentElement.lang = ...; document.title = ... }, [locale])`。
- **现状**：重复代码；且 title 硬编码（见 N11）。
- **影响**：小，但 N11 要做动态标题时必然要抽，先抽好等于给 N11 铺路。
- **方案**：见 N11 的 `use-document-meta.ts` 草图，两处替换成一行调用。
- **第三方库**：无。
- **风险**：极低。
- **工作量**：S。

### O9. 窄屏断点常量集中一处

> **已完成（2026-11-06）**：`use-narrow-screen.ts` 导出 `narrowQuery` 与 `narrowScreenNow()`，App 的初始 `sidebarOpen` 改 `useState(() => !narrowScreenNow())`——TS 侧 767px 字面量只剩 hook 一处。调研原文以 LayerFS 历史为准。

- **位置**：`/src/hooks/use-narrow-screen.ts`（`const narrowQuery = '(max-width: 767px)'`）、`/src/App.tsx`（`useState(() => !window.matchMedia('(max-width: 767px)').matches)` 手写同一断点）、`/src/components/sidebar/class.ts` 与 `shell/frame-class.ts`（CSS 侧的窄屏样式）。
- **现状**：`767px` 这个值在 TS 里出现两次字面量；`ChatApp` 初始 `sidebarOpen` 没有复用 hook 里的查询串。改断点时容易只改一处，出现「hook 认为窄屏、初始状态认为宽屏」的裂缝。
- **影响**：小隐患 + 可读性；`useNarrowScreen` 已经在模块顶层定义了查询串，导出即可。
- **方案**：

  ```ts
  // src/hooks/use-narrow-screen.ts
  export const narrowQuery = '(max-width: 767px)';
  export function narrowScreenNow(): boolean {
    return window.matchMedia(narrowQuery).matches;
  }
  ```

  `App.tsx` 的初始 state 改为 `useState(() => !narrowScreenNow())`。
- **第三方库**：无。
- **风险**：极低。
- **工作量**：S。

### O10. i18n 加最小插值机制，为带参数的文案做准备

- **位置**：`/src/i18n.ts`；调用方按需。
- **现状**：全部文案是静态字符串。已有若干「差一个参数」的地方：重置确认想说「将重置 {username} 的密码」（现在用户名单独一行 `<p>` 显示，勉强绕过）；N3 的日期分组、将来的审计提示都会遇到。
- **影响**：不提前定机制，各组件会各自用字符串拼接，语序问题（英文的 SVO 与中文语序不同）会让拼接方案很快破产。
- **方案**：十行的具名占位插值，不引库：

  ```ts
  // src/i18n.ts
  export function t(template: string, params: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
      key in params ? String(params[key]) : match,
    );
  }
  // 文案：resetConfirm: '重置后 {username} 所有设备都会被强制下线…'
  // 用法：t(text.resetConfirm, {username})
  ```

  类型上把带参数的 key 单独放一个 `templates` 子对象（`Record<Locale, Record<string, string>>`）也可以，避免和普通 key 混淆。新文案才用它，存量静态文案不动。
- **第三方库**：无（这个规模不值得引 i18next/formatjs；真到几十条带参数文案、要复数规则时再点名 `@formatjs/intl` 不迟）。
- **风险**：极低。
- **工作量**：S。

### O11. 置顶动作改乐观更新

> **已完成（2026-11-06）**：点击立即生效（pinnedAt 用本地时间顶上）→ 成功换服务端权威值 → 失败回滚。本节指出的「回滚 pinnedAt 不精确」简化被采纳（恢复成 null、不快照原值，罕见回滚场景只影响置顶组内先后，文档认可）。失败反馈从 `setNotice` 改为错误 toast（菜单点完就关，警示框容易被漏看）；401 走登录界面不弹 toast，连接类失败照旧挂全局服务横幅，成功不提示。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「侧栏置顶乐观更新」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/hooks/use-session-actions.ts` 的 `pinOpenSession`。
- **现状**：`await pinSession(...)` 成功回来才 `setSessions` 更新 UI。网络一般时，点「置顶」到列表重排之间有可感知的延迟，且期间没有任何 pending 指示（菜单已经关了）。改名和删除同样是等服务端，但那两个有弹窗 pending 态撑着；置顶是菜单点完即关，延迟直接裸露。
- **影响**：手感问题；置顶失败率低（同一个 PATCH 端点），乐观更新的回滚场景罕见。
- **方案**：

  ```ts
  async function pinOpenSession(id: string, pinned: boolean) {
    const {setSessions, /* … */} = depsRef.current;
    // 先本地生效：pinnedAt 用本地时间顶上，服务端回来再换成权威值。
    setSessions((current) =>
      current.map((s) =>
        s.id === id
          ? {...s, pinned, pinnedAt: pinned ? new Date().toISOString() : null}
          : s,
      ),
    );
    try {
      const item = await pinSession(id, pinned, pinned ? new Date().toISOString() : null);
      setSessions((current) =>
        current.map((s) => (s.id === id ? {...s, pinned: item.pinned, pinnedAt: item.pinned_at} : s)),
      );
    } catch (error) {
      // 回滚 + 现有的 401 / connectionFailure / setNotice 三分支
      setSessions((current) =>
        current.map((s) => (s.id === id ? {...s, pinned: !pinned, pinnedAt: null} : s)),
      );
      /* … */
    }
  }
  ```

  注意回滚分支里 `pinnedAt` 恢复不精确（原值没存），置顶互斥场景下影响可忽略；讲究一点就在乐观更新前把原 session 快照下来供回滚。连续快点两次置顶的乱序由「后发请求的响应覆盖」自然收敛，无需 titleSaves 那种排队。
- **第三方库**：无。
- **风险**：中低。FLIP 重排动画会跟着乐观更新立刻播，失败回滚时再播一次回去——观感上要手点确认不突兀。
- **工作量**：M。

---
## 三、未完善与潜在问题

### P1. `withConnectionRetry` 会重试非幂等 POST，可能重复建会话

> **已完成（2026-11-05）**：比本节方案更严——连接层自动重试只对 GET 打开；POST/PATCH/DELETE 一律默认只跑一次，调用方显式传 retry:true 才重试（src/api/http.ts 的 autoRetry）。建会话、登录、改密、头像、abort 等 POST 都没打开重试，重复建会话无从发生；Idempotency-Key 的跨栈远期方案不再需要。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「超时与重试」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/api/http.ts`（`withConnectionRetry` 无条件包住 `requestJson`/`requestEmpty` 的所有请求）。
- **现状**：重试条件是「非 ApiError，或 detail 为 null」，最多 4 次、间隔 300ms，不区分 HTTP 方法。`POST /api/sessions`（建会话）、`POST /api/login`、`POST /api/password`、`POST /api/avatar`、`POST /api/sessions/:id/abort` 全都会被重试。典型事故：服务器已经收到并处理了 `createSession`，响应在网络上丢了（fetch 抛错）→ 重试 → 数据库里出现两个同名会话，前端只认最后一个 id，另一个成了没人认领的多余会话，一直挂在列表里。
- **影响**：低概率但用户可见（重复会话、重复改名请求），且改密这种「吊销全部设备」的操作被盲目重试也让人不安（虽然它幂等性好一些）。
- **方案**：只对安全方法自动重试，其余显式选择：

  ```ts
  export async function requestJson(
    path: string,
    init?: {method?: string; body?: string | FormData; retry?: boolean},
  ): Promise<unknown> {
    const method = init?.method ?? 'GET';
    const run = async () => { /* 现有实现 */ };
    // GET 天然幂等；PATCH/DELETE 幂等可重；POST 默认不重试，调用方明示才重。
    const retryable = init?.retry ?? (method !== 'POST');
    return retryable ? withConnectionRetry(run) : run();
  }
  ```

  `abortReply` 这类「重发无害」的 POST 可以显式传 `retry: true`。更彻底的做法是建会话带 `Idempotency-Key` 请求头（前端 `crypto.randomUUID()` 一次生成、重试复用），但要后端配合存储去重，跨栈，放远期。
- **第三方库**：无。
- **风险**：中。收紧重试后，弱网下 POST 的首次失败会更快暴露给用户（原来可能第 2 次就成了）——配合 WarningBox 的既有报错路径，可接受；改完手点弱网场景（DevTools 限速 + 断网切换）。
- **工作量**：M。

### P2. fetch 无超时：启动引导可能永远停在占位页

> **已实现（2026-11-05）**：普通请求 fetch 超时 15 秒、FormData（头像上传）60 秒（AbortSignal.timeout，超时统一包成 ApiError(0, null) 进入「连不上」的既有降级路径）；流式对话请求没有总超时（上游整块返回，一轮实测可达 23 秒，断流靠续传恢复）。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「超时与重试」。调研原文以 LayerFS 历史为准。

### P3. `ApiError(0, null)` 语义过载：「连不上」和「响应解析不了」混为一谈

- **位置**：`/src/api/http.ts`（网络错误、JSON 解析失败、`requestJson` 里 `response.json()` 失败都抛 `ApiError(0, null)`；各 `isXxx` 校验失败也抛它）、`/src/api/failure.ts`（`connectionFailure` 把 detail 为 null 的 ApiError 一律当连接失败）。
- **现状**：同一个 `ApiError(0, null)` 至少表示四种情况：fetch 网络异常、响应体不是合法 JSON（比如 nginx 挂了返回 HTML 502 页）、JSON 合法但形状不对（后端改了字段名、版本不匹配）、以及 `withConnectionRetry` 保底处理时抛出的 `throw new ApiError(0, null)`。它们全部被 `connectionFailure()` 判真 → 界面显示「无法连接到服务器」、服务状态标 `unreachable`。
- **影响**：后端升级导致响应形状变化时，用户和排查故障的人看到的是「无法连接到服务器」——方向完全错误的提示，会把排查引向网络层；`unreachable` 状态还会触发恢复后的 `refreshWorkspace`，掩盖真实病因。
- **方案**：给解析/校验失败一个可区分的形态，不必大动：

  ```ts
  // http.ts：状态码照实传，detail 用一个专用哨兵值区分「有响应但读不懂」
  export const unparseableDetail = Symbol('unparseable'); // 或约定 detail = '__unparseable__'

  // 各 isXxx 校验失败处：
  throw new ApiError(response.status, unparseableDetail);

  // failure.ts：
  export function connectionFailure(error: unknown): boolean {
    return (
      !(error instanceof ApiError) ||
      (error.status === 0 && error.detail === null) // 只剩真正的网络层失败
    );
  }
  ```

  形状错误进入 `explain` 的保底文案（可新增一条 `responseUnexpected`：「服务器返回了看不懂的内容」，三语），并且不标 `unreachable`、不触发 `refreshWorkspace`。改动范围是所有抛 `ApiError(0, null)` 的校验点（session/profile/status/admin 四个文件约十处），机械但要过全。
- **第三方库**：无。
- **风险**：中。`connectionFailure` 的判真范围收窄，要确认没有依赖「校验失败也当断网」的隐藏行为（通读六个 hook 的 catch 分支后未发现，但改完要把手点清单跑全）。
- **工作量**：M。

### P4. 服务端错误 detail 只有简体中文，英文/繁中用户看到外语报错；`lang='zh-Hans'` hack 散布 6 处

- **位置**：`/src/api/failure.ts`（`explain` 原样透传 detail）；`lang={error === text.connectionError ? htmlLang[locale] : 'zh-Hans'}` 这个判断出现在 LoginScreen、AdminLoginForm、SettingsModal、ConfirmLogout、ChangePasswordPage、ConfirmResetPassword、ConfirmAdminLogout 共 7 处。
- **现状**：后端所有错误 detail 都是中文句子（ACCOUNT_MANAGEMENT.md 明确的设计），前端原样显示，并用「不是本地文案就标 zh-Hans」的 hack 让浏览器至少用中文字体渲染。英文界面用户遇到「用户名或密码不正确」这类错误时看到的是简体中文。
- **影响**：三语产品里错误信息单语，违反 UI_WARNINGS.md「三种语言都要有」的精神；hack 本身也是每次新增表单都要复制一遍的坏味道。
- **方案**：错误码目录，跨栈但改动清晰——后端在响应里加机器可读的 `code`（`{"code": "invalid_credentials", "detail": "用户名或密码不正确"}`），前端维护映射：

  ```ts
  // failure.ts
  export function explainLocalized(
    error: unknown,
    text: Copy,
  ): {message: string; lang: string} {
    if (error instanceof ApiError && error.code !== null && error.code in text.errorCodes) {
      return {message: text.errorCodes[error.code as keyof typeof text.errorCodes], lang: htmlLangFor(text)};
    }
    if (error instanceof ApiError && error.detail) {
      return {message: error.detail, lang: 'zh-Hans'}; // 未知码：维持现状保底
    }
    return {message: text.connectionError, lang: htmlLangFor(text)};
  }
  ```

  `errorCodes` 是三语子对象（登录错误、密码策略、重置失败等十来条），`lang` hack 收敛进这一个函数，7 个组件改成统一调用。需要 `ApiError` 带上 `code` 字段、`readDetail` 同时读 `code`。后端没安排前，可先做前端半边：把已知的固定 detail 字符串（「用户名或密码不正确」等）做一张精确匹配映射表——脆弱但零后端依赖，作为过渡。
- **第三方库**：无。
- **风险**：跨栈契约改动，要维护者许可；过渡方案的字符串精确匹配在后端改文案时静默失效（退回中文显示，不会更糟）。
- **工作量**：M（前端半边 S）。

### P5. 改密页客户端门槛消息未走 i18n，与「三语都要有」的自家规矩冲突

- **位置**：`/src/components/settings/ChangePasswordPage.tsx` 的 `newPasswordRejected`（返回硬编码简中「密码长度要在 6 到 128 之间」「这个密码太常见了，换一个」）。
- **现状**：这两条是提交前本地拦截的消息，设计意图是「跟后端 check_password_policy 一字不差」（ACCOUNT_MANAGEMENT.md 的分工原则），后端消息是中文，于是前端也硬编码中文。显示处靠 `shownError === text.connectionError ? htmlLang[locale] : 'zh-Hans'` 保底字体。UI_WARNINGS.md 要求界面提示三语齐全，这里是明确的例外，且文档里没有记录这个例外。
- **影响**：英文界面的学生改密码被拦时看到简中报错；同时「前端提示必须与后端逐字一致」和「界面文案必须三语」两条自家规矩在这里冲突，没有成文裁决。
- **方案**：把「一字不差」重新解释为「语义与门槛一字不差，文案按语言本地化」：两条消息进 i18n（`passwordTooShort` / `passwordTooCommon`，含 `{min}`/`{max}` 参数，用 O10 的插值），`newPasswordRejected` 返回 key 而不是字符串：

  ```ts
  function newPasswordRejected(password: string, minLength: number): 'tooShort' | 'tooCommon' | null {
    if (password.length < minLength || password.length > 128) return 'tooShort';
    if (isWeakPassword(password)) return 'tooCommon';
    return null;
  }
  // 提交处：setGateError(rejected === 'tooShort' ? t(text.passwordTooShort, {min: minLength, max: 128}) : text.passwordTooCommon);
  ```

  后端仍是唯一门槛，其中文 detail 走 P4 的错误码路径显示。顺手把 `minLength` 参数化（N4 的 admin 侧要传 8）。改完在 ACCOUNT_MANAGEMENT.md 把「消息一字不差」那条更新成本地化后的新约定，别让文档和代码继续互相矛盾。
- **第三方库**：无。
- **风险**：低；主要是文档同步，避免下一个人按旧规矩把硬编码中文加回来。
- **工作量**：S。

### P6. 焦点管理缺口：Modal 无焦点圈定/滚动锁，两处 role="menu" 无键盘导航

> **已完成（2026-11-06）**：Modal 三段补齐——模块级 `openPanels` 栈（叠开只有栈顶响应 Esc/Tab）、Tab 首尾循环（焦点落面板外拉回第一个）、计数式背景滚动锁（最后一个弹窗关闭才恢复；移动端 Safari `overflow: hidden` 不保留滚动位置的已知小瑕疵先接受，`position: fixed` 方案未采）、关闭还焦点给触发元素（打开时焦点在面板外才记录、`isConnected` 守卫）；`focusableIn` 过滤 `inert` 子树与 `display: none`。两处 `role="menu"`（LanguageMenu、SessionRow）补方向键循环＋Home/End＋打开即聚焦＋关闭还焦点，同款写法各自实现（未抽共用 hook）。`@ariakit/react` 未引入。`opacity-100 scale-100` 动效类未动。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「焦点管理」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/components/shell/Modal.tsx`（全部弹窗共用）、`/src/components/sidebar/SessionRow.tsx` 与 `/src/components/language/LanguageMenu.tsx` 的浮层菜单。
- **现状**：① Modal 打开时焦点不进面板、Tab 会跑到背景内容上、关闭后焦点不回到触发按钮、背景可以照常滚动（移动端弹窗后面跟着滚）；② 两个菜单都有 `role="menu"`/`menuitem`/`menuitemradio` 和 Esc、外点关闭，但没有方向键移动、没有打开即聚焦、关闭后焦点也不回按钮——ARIA 语义宣告了键盘行为却没实现，读屏用户预期落空。做得好的部分也要记录：`aria-hidden` + `inert` 在关闭态都有，`role="alert"`/`role="status"` 用得对，侧栏关闭时整棵 `inert`。
- **影响**：键盘/读屏用户操作弹窗和菜单困难；这是无障碍合规层面的实际缺口，目标用户是小学生，学校设备可能开着系统级辅助功能。
- **方案**：Modal 里补三段（保持自建 portal 结构不动，`opacity-100 scale-100` 保留）：打开时记录 `document.activeElement`、聚焦面板内第一个可聚焦元素；keydown 里拦 Tab 做首尾循环；关闭清理时恢复焦点并解锁 `document.body.style.overflow`（草图见调研过程中的标准 focus-trap 写法，约 25 行）。菜单方向键：抽一个 `useMenuKeys(itemsRef, open, onClose)` 小 hook 给两处共用——ArrowUp/Down 循环聚焦、Home/End 跳首尾、关闭时焦点回触发按钮，约 40 行。若维护者愿意加依赖，点名 **@ariakit/react**（MIT，headless，focus-trap、menu 键盘语义、portal 定位全都自带且经过大量无障碍审计；引入理由：这类焦点边界逻辑手写容易漏掉情况又没有测试保底）——但它的 Menu 组件要求接管触发按钮结构，与「浮层保持 createPortal、不换 daisyUI dropdown」的既有约束需要比对后再定，手写小 hook 是更保守的默认路线。
- **第三方库**：默认无；可选点名 @ariakit/react（理由如上，装不装维护者定）。
- **风险**：手写焦点圈定的边界 case（面板内动态出现的元素、嵌套弹窗——现在 RenameSession 和 ConfirmLogout 都只有一层，无嵌套）多，改完要键盘手点每个弹窗和菜单；`body` 滚动锁在移动端 Safari 上会丢滚动位置，需要用 `position: fixed; top: -scrollY` 方案或接受小瑕疵。
- **工作量**：M。

### P7. 多标签页登出/吊销不同步（N1 完成前的过渡缺口）

> **部分完成（2026-11-06）**：主动登出已同步——signOut 成功写 `h2bot-logout` 标记（值=时间戳）、openAccount 清除；其他标签页 storage 监听听到 `newValue ≠ null` 走 `enterLoginGuarded`（留在原页面的过期状态就保持在原页面、否则整页登录路径，正打的字照旧存 unsent），不再等下一次 401。**没做的一半**：服务器侧吊销（改密、停用、管理员重置）不写任何本地标记，仍靠本页请求收到 401 时保底处理，治本等 `/api/events` 推送通道（backlog）。分工依据注在 src/session/profile-cache.ts 注释。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「多标签页同步」。调研原文以 LayerFS 历史为准。

- **位置**：`/src/App.tsx`（`signOut`、`enterLogin`）。
- **现状**：标签页 A 退出登录（`POST /api/logout` 清 cookie），标签页 B 的界面毫无变化，继续以登录态渲染，直到 B 的下一次 API 请求收到 401——而 30 秒的 `/api/status` 轮询是无鉴权端点（ACCOUNT_MANAGEMENT.md 自己标注「要改成带鉴权」），不会触发 401，所以 B 可以无限期假装在线。ACCOUNT_MANAGEMENT.md「会话状态通道」一节把这条列为动机之一（「在一个标签页退出，另一个现在要等下一次请求才发现掉线」）。
- **影响**：共用电脑场景（学校正是）：前一个学生退出，后一个学生看到还开着的会话界面，点了才发现掉线；也算轻微的隐私观感问题。
- **方案**：治本是 N1 的 SSE 通道。零后端依赖的过渡是 storage 信号——`signOut` 成功后写一个登出标记键，其它标签页监听：

  ```ts
  // signOut 成功分支（enterLogin(null) 之后）：
  window.localStorage.setItem('h2bot-logout', String(Date.now()));

  // ChatApp 挂一次：
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === 'h2bot-logout') {
        enterLoginRef.current(null); // 与本页主动退出同款清理，地址去 /login
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  ```

  storage 事件只在「其它」标签页触发，本页不会自己被强制退回登录。登出标记键留在 localStorage 无害（下次登录不清它也行，事件只认写入瞬间），讲究一点可以在 `openAccount` 里 `removeItem`。与 N12 的 language 同步监听可以合并成一个 storage 效果。
- **第三方库**：无。
- **风险**：低。注意 `enterLogin(null)` 会 `saveUnsent` 存草稿——B 标签页正打的字被保住，行为正确。
- **工作量**：S。

### P8. `refreshWorkspace` 全量替换 sessions，可能踩掉本地进行中的状态

- **位置**：`/src/hooks/use-service-status.ts`（`refreshWorkspace` 里 `current.setSessions(next)`）。
- **现状**：服务从 `unreachable` 恢复后，直接 `setSessions(sessionsFromList(items))` 全量替换。替换出的新列表里每条都是 `messages: [], messagesKnown: false`——已经加载过历史、正在展示消息的会话被换回「未加载」空壳；如果替换瞬间有改名/置顶请求正在进行（弱网恢复期正是重试高发期），它们成功后对旧数组元素的 `map` 更新会作用在被替换前的引用上，结果被这次全量替换吞掉。
- **影响**：断网恢复的瞬间，正开着的会话可能闪回加载态、重新拉历史；进行中的改名结果丢失（界面回退成旧标题，直到下次刷新）。低频但发生在「服务刚恢复」这个用户最敏感的时点。
- **方案**：替换时做保留合并而不是硬覆盖：

  ```ts
  current.setSessions((prev) =>
    next.map((fresh) => {
      const old = prev.find((item) => item.id === fresh.id);
      // 本地已加载的消息与 messagesKnown 保留，元数据（标题、置顶）用服务端新值。
      return old
        ? {...fresh, messages: old.messages, messagesKnown: old.messagesKnown}
        : fresh;
    }),
  );
  ```

  注意 `setSessions` 现在的类型是 `(sessions: Session[]) => void`，要改成接 updater（`Dispatch<SetStateAction<Session[]>>`，App 里传下来的本来就是 `setSessions`，改个类型即可）。进行中的改名与合并的竞态窗口缩到毫秒级，剩余风险接受；`claimPath(next)` 照旧在合并后调用。
- **第三方库**：无。
- **风险**：中低。合并策略要手点验证：断网 → 打开某会话读历史 → 恢复 → 消息还在、不重拉；断网期间在另一标签页删掉的会话恢复后消失（`next` 里没有就不保留，正确）。
- **工作量**：M。

### P9. 文档滞后：README 和 ACCOUNT_MANAGEMENT 仍写 `?page=admin`、`?page=password`

> **已修复（2026-11-04）**：README 与 ACCOUNT_MANAGEMENT 的 URL 引用已统一到路径路由（本地提交 1418e5c，LayerFS 分支 `docs-update-path-references`），仓库文档里已无 `?page=admin`、`?page=password`（仅本条目原文引述）。本节保留作调研记录。

> 现状见 README.md 与 docs/ACCOUNT_MANAGEMENT.md（均已对齐真实路径路由）；调研原文以 LayerFS 历史为准。

### P10. AdminConsole 账号表：空态缺失、无手动刷新、无分页预期

> **已完成（2026-11-06）**：空态行（`noAccounts` 三语、跨三列居中）与手动刷新按钮（`refreshAccounts` 键、lucide `RotateCw`、busy 时 `aria-busy` ＋转圈；401 回登录表单、其余错误表格上方 `role=alert` 警示行）已实现；另加了本节方案没有的 30 秒静默轮询（仅列表视图；`document.hidden`、任何对话框开着、手动刷新正在进行都跳过这次轮询；失败静默、401 交下一次显式操作）。分页仍未做，代码注释记「账号数上百再考虑后端分页」。功能描述见 docs/ACCOUNT_MANAGEMENT.md「控制台」一节。调研原文以 LayerFS 历史为准。

- **位置**：`/src/components/admin/AdminConsole.tsx`。
- **现状**：`accounts` 为空数组时渲染一个只有表头的空表，没有任何「暂无账号」说明；列表只在挂载和登录成功时拉一次，没有刷新按钮，管理员在别处建了号（init.py 预设/数据操作）后这个页面看不到；账号直接全量平铺，`fetchAdminAccounts` 也无分页参数。
- **影响**：现阶段全校账号量小，分页不急；但空表无提示会被当成加载失败，无刷新按钮会逼人整页 F5。都是架子期该补的小件。
- **方案**：① `accounts.length === 0` 时表体渲染一行跨三列的空态：`<td colSpan={3} className="text-center text-stone-500 py-8" lang={...}>{text.noAccounts}</td>`（新 key，三语）；② header 里加刷新按钮（daisyUI `btn btn-ghost btn-sm` + lucide `RotateCw` 图标，项目已用 lucide），点击重跑 `fetchAdminAccounts`，busy 时图标换 `loading loading-spinner`；③ 分页暂不做，在代码注释里记一句「账号数上百再考虑后端分页」。
- **第三方库**：无（lucide-react 已在依赖里）。
- **风险**：极低。
- **工作量**：S。

### P11. 登录/管理员登录按钮无进行中指示

> **已完成（2026-11-06）**：学生登录按钮与管理员登录按钮都在提交中 `aria-busy` ＋ `loading spinner`（管理员登录按钮同款后补），零新文案，与本节草图一致。功能描述见 docs/ACCOUNT_MANAGEMENT.md「忘记密码」一节的完成注记。调研原文以 LayerFS 历史为准。

- **位置**：`/src/components/login/LoginScreen.tsx`、`/src/components/admin/AdminLoginForm.tsx`。
- **现状**：提交期间两个表单都只把按钮 `disabled`（`blocked` 含 `submitting`/`busy`），没有 spinner 或文案变化；对照 RenameSession、ConfirmDelete、ConfirmResetPassword 都有 `loading loading-spinner` + `aria-busy`，登录反而是全应用唯一「点了没动静」的异步按钮。P2 的 15 秒超时若实施，弱网下这个静默期会更长。
- **影响**：慢网络下用户以为没点上，反复戳或放弃；无障碍侧也缺 `aria-busy` 语义。
- **方案**：照现有弹窗按钮的写法：

  ```tsx
  <button type="submit" className="btn btn-primary btn-block" disabled={blocked} aria-busy={submitting}>
    {submitting ? <span className="loading loading-spinner loading-sm" aria-hidden="true" /> : text.logIn}
  </button>
  ```

  AdminLoginForm 同款（`busy`）。零新文案。
- **第三方库**：无。
- **风险**：无。
- **工作量**：S。

### P12. `h2bot-profile` 缓存不含头像，离线启动时头像闪回默认图

> **已完成（2026-11-06）**：实现形态与本节草图不同——不把 URL 塞进 `h2bot-profile`，而是独立键 `h2bot-avatar` 存 `{url, dataUrl}`（dataURL 化后可能几 MB，混存会因超配额连用户名带语言一起写不进）：`parseProfile` 拿到非默认头像 URL 即 fire-and-forget 抓取转 dataURL（>5MB 跳过、配额超限静默降级），App 的 `avatarUrl` 惰性初始化读缓存，**离线启动侧栏与设置弹窗显示本人头像**、不闪默认图；退出登录随 `h2bot-profile` 一起清。同批修复 wire 字段错位：后端 `ProfileResponse` 发 `avatar_url`（无 camelCase 别名），前端 `parseProfile` 自 2026-11-02 引入起误读 `value.avatarUrl`——真头像永远退回默认图、离线缓存从未生效，2026-11-06 修正（src/api/profile.ts，注释记原委；其余解析器核对无第二处错位）。功能描述见 docs/ACCOUNT_MANAGEMENT.md「头像」一节。调研原文以 LayerFS 历史为准。

- **位置**：`/src/session/profile-cache.ts`（`CachedProfile = {username, locale}`）、`/src/App.tsx`（启动时 `avatarUrl` 初始为 null，靠 `readProfile` 回来才设置）。
- **现状**：缓存的设计目的写在注释里——「接口服务连不上的时候，页面上还是知道『我是谁、我用哪种语言』」。但「我是谁」漏了头像：离线启动时侧栏和设置弹窗里显示默认头像，服务器回来才换成真头像。username 和 locale 都从缓存拿了，头像独缺。
- **影响**：小观感问题 + 一致性问题：离线保底做了三分之二。头像 URL 带内容哈希（`api/profile.ts` 注释），URL 本身不敏感，进 localStorage 不违反「密钥不进前端」，也符合该缓存的既有定位。
- **方案**：`CachedProfile` 加可选字段（旧缓存无此字段照常通过校验，天然向后兼容，不用做迁移）：

  ```ts
  export type CachedProfile = {username: string; locale: Locale; avatarUrl?: string};
  // readCachedProfile：typeof parsed.avatarUrl === 'string' 才带上，否则 undefined
  ```

  App 启动 `useState<string | null>(() => cachedProfile?.avatarUrl ?? null)`；三处 `saveCachedProfile` 调用点补 `avatarUrl: profile.avatarUrl`。`AvatarImage` 现有的加载失败回退（`failedSrc`）正好接住「缓存的哈希 URL 已失效」的情况，无需额外处理。注意 `enterLogin` 的 `clearCachedProfile()` 照旧全清，不破坏退出即清的设计。
- **第三方库**：无。
- **风险**：低。离线时头像文件本身若在 CDN/后端上同样拉不到，还是会回退默认图——这属预期（缓存救的是 URL，救不了图片本体），不算回归。
- **工作量**：S。

---

## 优先级建议（供安排进度参考）

按「收益 / 风险 / 是否已被文档列入计划」大致排序：

1. **先做零风险小件**：O3（i18n 类型）、O9（断点常量）、P9（文档滞后）、P11（登录 spinner）、N6（忘记密码提示）、N5（重置面板精修，文档已列入计划）——都是 S，互相独立，可一批走完。
2. **再做体验与健壮性主力**：P2（fetch 超时）、P3（错误语义分离）、O5（启动并行）、O2（/admin 懒加载）、N8（ErrorBoundary）、N10（online/offline）、P7（多标签过渡）——把「故障形态」从白屏/误导提示收敛到既有降级 UI。
3. **中等改造**：P1（POST 重试收紧，与 P2/P3 同一批动 http.ts 最省事）、P4（错误码，前端半边先行）、P5（门槛消息 i18n，与 N4 联动）、O7（Toast 统一）、P12（头像缓存）、N2/N3（侧栏搜索与分组）、O10（插值）、P6（焦点管理）。
4. **大件/需决定**：N1（SSE 通道，等后端安排，文档已定协议）、O1（ChatApp 拆分，大改动需许可）、O6（登录带 profile，跨栈）、N13（深色主题，产品决定）、O11（乐观置顶）、P8（refreshWorkspace 合并）。

所有条目共同的验收方式（无自动化测试的约束下）：`pnpm check` + `pnpm build` 过，然后按各条「风险」里列出的手点清单在浏览器逐项走一遍，三种语言各过一遍涉及文案的条目。
