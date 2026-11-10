import {lazy, Suspense, useEffect, useRef, useState} from 'react';
import {useAuthFlow} from './hooks/use-auth-flow.ts';
import {useBootstrapSession} from './hooks/use-bootstrap-session.ts';
import {useDocumentMeta} from './hooks/use-document-meta.ts';
import {useMessageSubmit} from './hooks/use-message-submit.ts';
import {useMultiTabSync} from './hooks/use-multi-tab-sync.ts';
import {usePasswordChange} from './hooks/use-password-change.ts';
import {usePathRouting} from './hooks/use-path-routing.ts';
import {useProfileActions} from './hooks/use-profile-actions.ts';
import {useSessionActions} from './hooks/use-session-actions.ts';
import {serviceNoticeText, useServiceStatus} from './hooks/use-service-status.ts';
import {useSidebarState} from './hooks/use-sidebar-state.ts';
import {useTurnEngine} from './hooks/use-turn-engine.ts';
import {warningsFor} from './components/chat/warnings.ts';
import {LoginScreen} from './components/login/LoginScreen.tsx';
import {ChangePasswordPage} from './components/settings/ChangePasswordPage.tsx';
import {AppFrame} from './components/shell/AppFrame.tsx';
import {PageBoundary} from './components/shell/PageBoundary.tsx';
import {Toast, type ToastItem} from './components/toast/Toast.tsx';
import {translations} from './i18n/index.ts';
import {chatIdFromPath, SELF_CHANGE_PWD} from './session/paths.ts';
import {readCachedAvatarData, readCachedProfile} from './session/profile-cache.ts';
import type {CachedProfile} from './session/profile-cache.ts';
import {BrowserRouter, Route, Routes, useLocation, useNavigate} from 'react-router';
import type {Session} from './type/chat.ts';
import {htmlLang, localeFromSystem, type Locale} from './type/locale.ts';

/**
 * /admin 懒加载（O2）：AdminConsole 和它的子组件随动态 import 单独成块，
 * 访问控制台才下载，聊天侧的用户不必下载管理员代码。分块由动态 import 自然
 * 产生，vite.config.ts 不用动。AdminConsole 是命名导出，lazy 要 default
 * 形状，这里包一层。
 */
const AdminConsole = lazy(() =>
  import('./components/admin/AdminConsole.tsx').then((module) => ({
    default: module.AdminConsole,
  })),
);

// 分块加载失败的提示一次页面会话只弹一条：发布期间新旧版本交错（旧页面要旧分块、
// 服务器已换新）会让每个动态 import 都失败，不设这个标记会反复弹。
// 模块级变量跨组件挂载卸载存活，刷新页面即复位——刷新后就拿到新分块了，
// 一次就够。
let chunkFailureNoticed = false;

/**
 * 接住动态分块加载失败（发布期间新旧版本交错的窗口）：Vite 对动态 import 失败统一派
 * vite:preloadError，这里弹 toast 提示刷新页面拿新版本。刻意渲染在
 * PageBoundary 外面：/admin 的分块加载失败时，lazy 的 rejection 会把整页
 * 送进错误边界，toast 得留在边界外才看得见。
 * 语言不属于任何页面状态：跟着本地记的资料走，读不到随系统（PageBoundary
 * 同款做法）；失败瞬间取一次快照，不随后续切语言联动。
 */
function ChunkFailureToast() {
  const [toast, setToast] = useState<(ToastItem & {lang: string}) | null>(null);
  useEffect(() => {
    function onPreloadError() {
      if (chunkFailureNoticed) {
        return;
      }
      chunkFailureNoticed = true;
      const locale = readCachedProfile()?.locale ?? localeFromSystem();
      setToast({id: 1, text: translations[locale].newVersionRefresh, lang: htmlLang[locale]});
    }
    window.addEventListener('vite:preloadError', onPreloadError);
    return () => {
      window.removeEventListener('vite:preloadError', onPreloadError);
    };
  }, []);
  return (
    <Toast
      toast={toast}
      lang={toast?.lang ?? 'en'}
      onDismiss={() => {
        setToast(null);
      }}
    />
  );
}

/**
 * 路由用真实路径：/admin 整页渲染管理员控制台，其余地址交给聊天侧
 * （ChatApp），由它再认 /、/chat/:id、/password 和 /login；不带 id 的
 * /chat 和未知路径一律归位到根路径。控制台是完全独立的一页——聊天侧
 * 的会话和用户信息引导流程一概不跑（ChatApp 根本不挂载）。懒加载分块
 * 下载期间给一个与控制台自己的 checking 占位同款的空白占位，不引入新文案。
 */
export default function App() {
  return (
    <>
      <PageBoundary>
        <BrowserRouter>
          <Routes>
            <Route
              path="/admin"
              element={
                <Suspense fallback={<div className="h-full bg-base-200" />}>
                  <AdminConsole />
                </Suspense>
              }
            />
            <Route path="/*" element={<ChatApp />} />
          </Routes>
        </BrowserRouter>
      </PageBoundary>
      <ChunkFailureToast />
    </>
  );
}

function ChatApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const [cachedProfile] = useState<CachedProfile | null>(() => readCachedProfile());
  const [locale, setLocale] = useState<Locale>(() => cachedProfile?.locale ?? localeFromSystem());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(() => cachedProfile?.username ?? null);
  // 离线启动：侧栏头像先显示本地缓存，不会闪现默认图（P12 的侧栏半边）。
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() => readCachedAvatarData());
  const [view, setView] = useState<'chat' | 'profile'>('chat');
  const [composingNew, setComposingNew] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<ToastItem | null>(null);
  const draftRef = useRef(draft);
  // 异步回调和效果调用的函数统一从 ref 里拿 navigate：走 ref 就不会成为
  // 各个效果的响应式依赖。
  const navigateRef = useRef(navigate);
  // enterLogin 和启动效果会被效果捕获，不能直接引用 hook 返回的对象
  // （响应式），一律走下面这几个 ref 拿最新的 API——和 navigateRef 同一做法。
  // 这些 ref 建在对应 hook 接线之前（更早已接线的 hook 要拿着它们去读），
  // 初值给 null，由接线完成后的镜像效果填上。
  const routingRef = useRef<ReturnType<typeof usePathRouting> | null>(null);
  const serviceRef = useRef<ReturnType<typeof useServiceStatus> | null>(null);
  const engineRef = useRef<ReturnType<typeof useTurnEngine> | null>(null);
  const passwordRef = useRef<ReturnType<typeof usePasswordChange> | null>(null);
  const profileApiRef = useRef<ReturnType<typeof useProfileActions> | null>(null);
  const sessionActionsRef = useRef<ReturnType<typeof useSessionActions> | null>(null);
  const toastCount = useRef(0);
  const text = translations[locale];
  const active = sessions.find((session) => session.id === activeId);
  const {narrow, sidebarOpen, openSidebar, closeSidebar} = useSidebarState();
  const authFlow = useAuthFlow({
    locale,
    text,
    setLocale,
    setUsername,
    setAvatarUrl,
    setSessions,
    setActiveId,
    setDraft,
    setNotice,
    setView,
    setComposingNew,
    setConfirmLogout,
    navigateRef,
    draftRef,
    routingRef,
    serviceRef,
    engineRef,
    passwordRef,
    profileApiRef,
    sessionActionsRef,
  });
  const {
    auth,
    loginNotice,
    loginSubmitting,
    loginError,
    sessionInvalid,
    reloginOpen,
    mustChangePassword,
    loggingOut,
    setAuth,
    setLoginOffline,
    setLoginDetail,
    setReloginOpen,
    setMustChangePassword,
    enterLogin,
    enterLoginGuardedRef,
    enterLoginGuarded,
    handleAuthError,
    submitLogin,
    signOut,
    finishPasswordChange,
    cancelGatedLogin,
  } = authFlow;
  useMultiTabSync({enterLoginGuardedRef, setLocale, setUsername, setAvatarUrl});
  const {sendingNew, handleDraft, showSession, showNewChat, submitMessage} = useMessageSubmit({
    locale,
    text,
    draft,
    activeId,
    active,
    sessionInvalid,
    navigate,
    setDraft,
    setActiveId,
    setSessions,
    setNotice,
    setView,
    setComposingNew,
    markEntering,
    updateSession,
    handleAuthError,
    engineRef,
    sessionActionsRef,
    serviceRef,
  });
  const routing = usePathRouting({
    auth,
    sessions,
    activeId,
    showSession,
    showNewChat,
    setView,
    setComposingNew,
    setActiveId,
    setDraft,
  });
  const service = useServiceStatus({
    locale,
    auth,
    setSessions,
    setUsername,
    setLocale,
    setAvatarUrl,
    onClaimPath: (list) => routingRef.current?.claimPath(list, 'recovery'),
    onEnterLogin: enterLoginGuarded,
  });
  const engine = useTurnEngine({
    locale,
    auth,
    activeId,
    composingNew,
    sessions,
    setSessions,
    updateSession,
    markEntering,
    setNotice,
    setDraft: handleDraft,
    onAuthError: handleAuthError,
    onConnectionWarning: service.showConnectionWarning,
  });
  const password = usePasswordChange({
    locale,
    // 改密成功的收尾不走守卫（守卫会把它吞掉）：回记下的来路就地渲染登录屏，
    // 登录屏带「密码已修改，请用新密码重新登录」的提示（finishPasswordChange）。
    onFinish: finishPasswordChange,
    // 401（会话已死）：表单错误已是统一文案，登录屏上带同句，不透出「未登录」。
    onSessionExpired: (message) => {
      enterLogin(null);
      setLoginDetail(message);
    },
    onConnectionWarning: service.showConnectionWarning,
  });
  const profileApi = useProfileActions({
    locale,
    setLocale,
    setUsername,
    setAvatarUrl,
    onEnterLogin: enterLoginGuarded,
    onConnectionWarning: service.showConnectionWarning,
  });
  const sessionActions = useSessionActions({
    locale,
    activeId,
    setSessions,
    setNotice,
    onShowToast: showToast,
    onEnterLogin: enterLoginGuarded,
    onConnectionWarning: service.showConnectionWarning,
    showNewChat,
    onStopPolling: engine.stopPolling,
    onClearPending: engine.clearPending,
  });

  useEffect(() => {
    draftRef.current = draft;
    navigateRef.current = navigate;
    routingRef.current = routing;
    serviceRef.current = service;
    engineRef.current = engine;
    passwordRef.current = password;
    profileApiRef.current = profileApi;
    sessionActionsRef.current = sessionActions;
  });

  useBootstrapSession({
    setAuth,
    setMustChangePassword,
    setLoginOffline,
    setLoginDetail,
    setSessions,
    setUsername,
    setLocale,
    setAvatarUrl,
    setComposingNew,
    setDraft,
    routingRef,
    serviceRef,
  });

  const serviceNotice = serviceNoticeText(service.serviceState, text);
  const activePending = active ? engine.pendingIds.has(active.id) : false;
  // 当前会话最新的进度节点名（没有进度时 undefined）：等待气泡里显示。
  const progressText = active ? engine.progressBySession[active.id] : undefined;
  const historyLocked = engine.historyLoadingId === active?.id && active.messages.length === 0;
  // 打字和发送分开解锁（N9）：流式回答期间不再锁键盘——想到追问可以先记下来；
  // 发送照旧等这一轮结束（sendLocked，输入框有字时给禁用的发送按钮＋提示）。
  // 首条消息建会话中（sendingNew）和留在原页面的过期状态仍然锁输入。
  const inputLocked = sendingNew || sessionInvalid !== null;
  const sendLocked = inputLocked || activePending || historyLocked;
  // 会话级的提示都在输入区分隔线上方的警示框里（聊天滚动区与输入区之间的流内节点），只有一种样子。
  const warnings = warningsFor({
    sessionInvalid,
    serviceNotice,
    notice,
    sessionWarning: engine.sessionWarning,
    activeId: active?.id,
    text,
    onRelogin: () => {
      setReloginOpen(true);
    },
    onDismissSessionWarning: () => {
      engine.setSessionWarning(null);
    },
  });

  // 标签页标题（N11）：有活跃会话且有标题就是「{会话名} - H^2 Bot」，
  // 新对话、无标题、未登录都只是「H^2 Bot」。切会话、改名、置顶刷新
  // （sessions 整份替换）、登录登出都经由 active 自动跟随，不用额外接线。
  // lang 与 title 两件事统一住在 useDocumentMeta（O8）。
  useDocumentMeta(locale, active?.title ?? null);

  /** 成功之后的短提示：弹窗自己关了，得有个地方告诉用户「成了」。 */
  function showToast(message: string) {
    toastCount.current += 1;
    // id 只在这里生成（O7）：Toast 组件拿它重播动画、重新计时 3 秒，不再自造计数。
    setToast({id: toastCount.current, text: message});
  }

  function updateSession(sessionId: string, change: (session: Session) => Session) {
    setSessions((current) =>
      current.map((session) => (session.id === sessionId ? change(session) : session)),
    );
  }

  function markEntering(id: string) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      return;
    }
    setEnteringIds((current) => new Set(current).add(id));
    // 保底清理：正常由 onAnimationEnd 移除；气泡在动画结束前就被删掉时
    // （重发去掉旧回答、发送没成功整轮回滚），onAnimationEnd 不会再来，
    // id 会一直残留在集合里。进场动画最长 300ms，500ms 后再清一次，幂等。
    window.setTimeout(() => {
      setEnteringIds((current) => {
        if (!current.has(id)) {
          return current;
        }
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, 500);
  }

  function openSession(id: string) {
    if (id === activeId && !composingNew) {
      setView('chat');
      if (engine.shouldReloadThread(id)) {
        engine.bumpThreadRetry();
      }
      return;
    }
    showSession(id);
    void navigate(`/chat/${id}`);
  }

  function addSession() {
    if (composingNew) {
      setView('chat');
      return;
    }
    showNewChat();
    void navigate('/');
  }

  if (auth === 'checking') {
    return <div className="h-full bg-stone-100" />;
  }

  if (auth === 'anonymous') {
    return (
      <LoginScreen
        locale={locale}
        error={loginError}
        notice={loginNotice}
        submitting={loginSubmitting}
        onLocale={setLocale}
        onSubmit={(usernameValue, password, turnstileToken) =>
          submitLogin(usernameValue, password, turnstileToken)
        }
      />
    );
  }

  // 「必须修改密码」拦截：标记为真就只渲染强制改密页（地址被守卫按在
  // /force-change-pwd），正常聊天主体一概不渲染。被标记的登录不算登录成功：
  // 服务器发的只是一条能到豁免路径的受限会话。「放弃本次登录」＝放弃这条
  // 受限会话（cancelGatedLogin 作废会话、回记下的来路就地登录），标记不清
  // 除，下次登录仍会被拦。改密成功后服务器吊销这个账号的全部登录（含当前
  // 设备）：页面就地亮「密码已修改」提示（password.changed），片刻后收尾回
  // 记下的来路就地渲染登录屏；重新登录后由登录响应里的标记解除拦截。
  if (mustChangePassword) {
    return (
      <ChangePasswordPage
        locale={locale}
        username={username}
        error={password.error}
        busy={password.busy}
        success={password.changed}
        forced
        onSubmit={password.submit}
        onCancel={() => void cancelGatedLogin()}
      />
    );
  }

  // 自助改密是独立的一页（/change-pwd），不是弹窗：没有背景可误点，密码输
  // 一半不会丢。刷新和后退都是页面的行为，不是弹窗的。改密成功后就地亮
  // 提示，收尾与闸门同一套：回记下的来路（markPasswordPushed 记下的）就地
  // 登录，见 use-auth-flow 的 finishPasswordChange。
  if (location.pathname === SELF_CHANGE_PWD) {
    return (
      <ChangePasswordPage
        locale={locale}
        username={username}
        error={password.error}
        busy={password.busy}
        success={password.changed}
        onSubmit={password.submit}
        onCancel={() => {
          password.setError(null);
          if (routing.isPasswordPushed()) {
            // 入口压入过一条历史记录：取消就是后退，路径效果会把视图跟着地址带回去。
            void navigate(-1);
            return;
          }
          // 直接以 /change-pwd 打开（刷新、粘贴地址），历史里没有可退的：
          // 就地把路径换掉回聊天。
          setView('chat');
          void navigate(activeId === null ? '/' : `/chat/${activeId}`, {
            replace: true,
          });
        }}
      />
    );
  }

  // 已登录却站在 /login、或站在即将被归位效果送走的地址（不带 id 的 /chat、未知路径）：
  // 效果马上会把地址送去该去的地方，先放个占位，别闪现一帧聊天框。
  if (location.pathname !== '/' && chatIdFromPath(location.pathname) === null) {
    return <div className="h-full bg-stone-100" />;
  }

  return (
    <AppFrame
      narrow={narrow}
      sidebarOpen={sidebarOpen}
      locale={locale}
      text={text}
      sessions={sessions}
      activeId={activeId}
      active={active}
      view={view}
      username={username}
      avatarUrl={avatarUrl}
      warnings={warnings}
      enteringIds={enteringIds}
      setEnteringIds={setEnteringIds}
      activePending={activePending}
      progressText={progressText}
      draft={draft}
      inputLocked={inputLocked}
      sendLocked={sendLocked}
      confirmLogout={confirmLogout}
      setConfirmLogout={setConfirmLogout}
      setView={setView}
      setNotice={setNotice}
      loggingOut={loggingOut}
      toast={toast}
      setToast={setToast}
      sessionInvalid={sessionInvalid}
      reloginOpen={reloginOpen}
      setReloginOpen={setReloginOpen}
      setLoginDetail={setLoginDetail}
      setLoginOffline={setLoginOffline}
      loginError={loginError}
      loginSubmitting={loginSubmitting}
      setLocale={setLocale}
      addSession={addSession}
      closeSidebar={closeSidebar}
      openSidebar={openSidebar}
      openSession={openSession}
      showToast={showToast}
      handleDraft={handleDraft}
      submitMessage={submitMessage}
      submitLogin={submitLogin}
      signOut={signOut}
      handleAuthError={handleAuthError}
      navigate={navigate}
      engine={engine}
      sessionActions={sessionActions}
      profileApi={profileApi}
      password={password}
      routing={routing}
      service={service}
    />
  );
}
