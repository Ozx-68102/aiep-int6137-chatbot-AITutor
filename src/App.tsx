import {lazy, Suspense, type SubmitEvent, useEffect, useRef, useState} from 'react';
import {useDocumentMeta} from './hooks/use-document-meta.ts';
import {narrowScreenNow, useNarrowScreen} from './hooks/use-narrow-screen.ts';
import {usePasswordChange} from './hooks/use-password-change.ts';
import {chatIdFromPath, usePathRouting} from './hooks/use-path-routing.ts';
import {useProfileActions} from './hooks/use-profile-actions.ts';
import {useSessionActions} from './hooks/use-session-actions.ts';
import {serviceNoticeText, useServiceStatus} from './hooks/use-service-status.ts';
import {useTurnEngine} from './hooks/use-turn-engine.ts';
import {connectionFailure, explain} from './api/failure.ts';
import {sendFeedback} from './api/feedback.ts';
import {ApiError, mustChangePasswordCode, mustChangePasswordEvent} from './api/http.ts';
import {logout, readProfile} from './api/profile.ts';
import {defaultAvatarUrl, type Profile} from './api/profile.ts';
import {createSession, emptySession, listSessions, login, sessionsFromList} from './api/session.ts';
import type {LoginResult} from './api/session.ts';
import {ChatMain} from './components/chat/ChatMain.tsx';
import type {WarningItem} from './components/chat/WarningBox.tsx';
import {LoginScreen} from './components/login/LoginScreen.tsx';
import {ChangePasswordPage} from './components/settings/ChangePasswordPage.tsx';
import {ConfirmLogout} from './components/settings/ConfirmLogout.tsx';
import {SettingsModal} from './components/settings/SettingsModal.tsx';
import {chatFrameClass} from './components/shell/frame-class.ts';
import {Modal} from './components/shell/Modal.tsx';
import {PageBoundary} from './components/shell/PageBoundary.tsx';
import {Sidebar} from './components/sidebar/Sidebar.tsx';
import {Toast, type ToastItem} from './components/toast/Toast.tsx';
import {translations, type Messages} from './i18n/index.ts';
import {
  avatarCacheKey,
  clearCachedProfile,
  clearLogoutMarker,
  logoutMarkerKey,
  profileCacheKey,
  readCachedAvatarData,
  readCachedProfile,
  saveCachedProfile,
  writeLogoutMarker,
} from './session/profile-cache.ts';
import type {CachedProfile} from './session/profile-cache.ts';
import {clearAllDrafts, clearDraft, readDraft, saveDraft} from './session/drafts.ts';
import {openPushChannel} from './session/push-channel.ts';
import {clearUnsent, readUnsent, saveUnsent} from './session/unsent.ts';
import {titleFromQuestion} from './session/title.ts';
import {BrowserRouter, Route, Routes, useLocation, useNavigate} from 'react-router';
import type {Message, Session} from './type/chat.ts';
import {htmlLang, isLocale, localeFromSystem, type Locale} from './type/locale.ts';

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
 * 「会话失效、留在原页面」状态的原因：401 的 reason 词表（expired/disabled）
 * 加上推送通道的失效原因（password_changed/admin_reset）；推送帧里不认识的
 * reason 词一律记成 unknown——也按失效处理，文案退回服务器推来的 message。
 */
type SessionInvalidReason = 'expired' | 'disabled' | 'password_changed' | 'admin_reset' | 'unknown';

/** 留在原页面的失效状态：原因 + 服务器推来的建议文案（只在 unknown 时用）。 */
type SessionInvalid = {reason: SessionInvalidReason; message: string | null};

/** 推送帧的 reason 词 → 页面状态词；词表之外的词一律 unknown。 */
function toSessionInvalidReason(reason: string): SessionInvalidReason {
  if (
    reason === 'expired' ||
    reason === 'disabled' ||
    reason === 'password_changed' ||
    reason === 'admin_reset'
  ) {
    return reason;
  }
  return 'unknown';
}

/** 会话失效警示条的文案：每个原因配固定的本地化词条；unknown 退回服务器推来的 message。 */
function sessionInvalidText(invalid: SessionInvalid, text: Messages): string {
  switch (invalid.reason) {
    case 'expired':
      return text.sessionExpired;
    case 'disabled':
      return text.accountDisabled;
    case 'password_changed':
      return text.passwordChanged;
    case 'admin_reset':
      return text.passwordResetByAdmin;
    case 'unknown':
      return invalid.message ?? text.sessionExpired;
  }
}

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
  const [auth, setAuth] = useState<'checking' | 'anonymous' | 'ready'>('checking');
  const [loginOffline, setLoginOffline] = useState(false);
  const [loginDetail, setLoginDetail] = useState<string | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  // 初始的宽窄判断与 useNarrowScreen 共用同一个断点查询串：改断点只改一处。
  const [sidebarOpen, setSidebarOpen] = useState(() => !narrowScreenNow());
  // 用户在宽屏上想看到的侧边栏状态。窄屏自动收起只是临时的，不改它。
  const sidebarWanted = useRef(sidebarOpen);
  const narrow = useNarrowScreen(() => {
    // 窄屏自动收起：不改用户的偏好，窗口拉宽之后按偏好恢复。
    setSidebarOpen(false);
  });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(() => cachedProfile?.username ?? null);
  // 离线启动：侧栏头像先显示本地缓存，不会闪现默认图（P12 的侧栏半边）。
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() => readCachedAvatarData());
  const [view, setView] = useState<'chat' | 'profile'>('chat');
  const [composingNew, setComposingNew] = useState(false);
  const [sendingNew, setSendingNew] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  // 留在原页面的过期状态（docs/ACCOUNT_MANAGEMENT.md 会话状态通道的最小 HTTP 版）：
  // auth 保持 ready，聊天页原样保留、输入区禁用、输入区上方挂常驻警示条。
  // expired 可以就地重新登录（Modal 里弹 LoginScreen）；disabled 是终态，只给提示。
  // 触发来源两个：带 reason 的 401（handleAuthError），以及推送通道的失效帧
  //（handlePushInvalid，原因多三种：密码已修改、被管理员重置、不认识的词）。
  const [sessionInvalid, setSessionInvalid] = useState<SessionInvalid | null>(null);
  const [reloginOpen, setReloginOpen] = useState(false);
  // 推送通道的世代编号：重新登录成功后加一，通道效果随之关掉旧连接、新建
  // 一条（旧连接在登录态失效后已经彻底死了，不复用）。
  const [pushEpoch, setPushEpoch] = useState(0);
  // 「必须修改密码」拦截：密码来自别人手的账号（预设密码、被控制台重置过
  // 密码）被服务器打了标记，本人改出一个新密码之前不放行其他功能。来源
  // 三个：登录响应、profile 响应，以及任何请求收到的 403（http.ts 的全局
  // 保底事件）。契约见 docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md「必须改密标记」。
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<ToastItem | null>(null);
  const draftRef = useRef(draft);
  const sessionInvalidRef = useRef(sessionInvalid);
  // 异步回调和效果调用的函数统一从 ref 里拿 navigate：走 ref 就不会成为
  // 各个效果的响应式依赖。
  const navigateRef = useRef(navigate);
  // 多标签页的 storage 监听只注册一次，登出处理要读到最新的 enterLoginGuarded：
  // 走 ref，别让它成为效果依赖。初值给 null、由下面的镜像效果填上：在这里
  // 直接读后面才声明的函数会被 React Compiler 记成「初始化期间读取」。
  // 镜像在挂载后的第一帧就完成，storage 事件不可能比它更早到。
  const enterLoginGuardedRef = useRef<((detail: string | null) => void) | null>(null);
  // 推送失效的回调同样走 ref：通道效果只注册一次，回调要读到最新的一份
  //（和 enterLoginGuardedRef 同一做法，镜像效果在函数声明之后）。
  const handlePushInvalidRef = useRef<((reason: string, message: string | null) => void) | null>(
    null,
  );
  const toastCount = useRef(0);
  const text = translations[locale];
  const loginError = loginOffline ? text.connectionError : loginDetail;
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
  const routingRef = useRef(routing);
  const service = useServiceStatus({
    auth,
    setSessions,
    setUsername,
    setLocale,
    setAvatarUrl,
    onClaimPath: (list) => routingRef.current.claimPath(list),
    onEnterLogin: enterLoginGuarded,
  });
  const serviceRef = useRef(service);
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
  const engineRef = useRef(engine);
  const password = usePasswordChange({
    locale,
    onPasswordChanged: () => setLoginNotice(text.passwordChanged),
    onEnterLogin: enterLoginGuarded,
    onConnectionWarning: service.showConnectionWarning,
  });
  const passwordRef = useRef(password);
  const profileApi = useProfileActions({
    locale,
    setLocale,
    setUsername,
    setAvatarUrl,
    onEnterLogin: enterLoginGuarded,
    onConnectionWarning: service.showConnectionWarning,
  });
  const profileApiRef = useRef(profileApi);
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
  const sessionActionsRef = useRef(sessionActions);
  // enterLogin 和启动效果会被效果捕获，不能直接引用 hook 返回的对象
  // （响应式），一律走上面这几个 ref 拿最新的 API——和 navigateRef 同一做法。
  const serviceNotice = serviceNoticeText(service.serviceState, text);
  const active = sessions.find((session) => session.id === activeId);
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
  const warnings: WarningItem[] = [];
  if (sessionInvalid !== null) {
    // 会话失效的常驻警示条，不可关闭：disabled 用红色出错语气（终态，登录也
    // 没用，不给按钮）；其余原因（含推送来的密码已修改、被管理员重置）都是
    // 琥珀的「有状况」语气，可以就地重新登录。白底黑字，语义色只在图标上
    //（docs/UI_WARNINGS.md）。
    const terminal = sessionInvalid.reason === 'disabled';
    warnings.push({
      id: 'session-invalid',
      tone: terminal ? 'error' : 'warning',
      text: sessionInvalidText(sessionInvalid, text),
      ...(terminal
        ? {}
        : {
            action: {
              label: text.logInAgain,
              onClick: () => {
                setReloginOpen(true);
              },
            },
          }),
    });
  }
  if (serviceNotice !== null) {
    warnings.push({id: 'service', tone: 'warning', text: serviceNotice});
  }
  if (notice !== null) {
    warnings.push({id: 'notice', tone: 'error', text: notice});
  }
  if (engine.sessionWarning !== null && engine.sessionWarning.sessionId === active?.id) {
    warnings.push({
      id: 'session',
      tone: 'warning',
      text: engine.sessionWarning.text,
      onDismiss: () => {
        engine.setSessionWarning(null);
      },
    });
  }

  // 标签页标题（N11）：有活跃会话且有标题就是「{会话名} - H^2 Bot」，
  // 新对话、无标题、未登录都只是「H^2 Bot」。切会话、改名、置顶刷新
  // （sessions 整份替换）、登录登出都经由 active 自动跟随，不用额外接线。
  // lang 与 title 两件事统一住在 useDocumentMeta（O8）。
  useDocumentMeta(locale, active?.title ?? null);

  useEffect(() => {
    // 窗口从窄变宽：按用户之前的偏好把侧边栏恢复回去。
    if (!narrow) {
      setSidebarOpen(sidebarWanted.current);
    }
  }, [narrow]);

  // 多标签页同步（N12 + P7）：其他标签页改语言/资料、主动登出，都经由
  // localStorage 的 storage 事件当场广播过来，立即应用，不靠轮询。storage
  // 事件只派发给「其他」标签页，写入方自己收不到，所以写了登出标记的
  // 标签页不会被自己二次触发。服务器侧吊销（会话过期、账号停用）不在这
  // 个监听的范围：它不写任何本地标记，仍由本页请求的 401 保底处理
  // （handleAuthError）——两者分工不同。
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === logoutMarkerKey) {
        // newValue 为 null 是登录方在清墓碑（openAccount），不是登出，不处理。
        if (event.newValue !== null) {
          // 别的标签页主动登出了：login cookie 全浏览器共享，本页的登录态
          // 随之作废，立即进入登录界面路径，不等下一次 401。已经在
          // 留在原页面的过期状态里时横幅挂着、输入锁着，就保持原地（enterLoginGuarded 的
          // 语义），不升级成整页清空。
          // 草稿存在 sessionStorage、按标签页各存各的：登出的那个标签页清不到
          // 这一份，每个标签页听到广播都清自己的（对齐 signOut 里 clearAllDrafts
          // 的「共用电脑不留半截字」）。
          clearAllDrafts();
          enterLoginGuardedRef.current?.(null);
        }
        return;
      }
      if (event.key === profileCacheKey || event.key === avatarCacheKey) {
        if (event.newValue === null) {
          // 清缓存只发生在登出/被强制下线路径：主动登出由上面的登出标记接管，
          // 服务器侧被强制下线照旧靠 401 保底处理。这里不做二次处理，更不会强制跳转页面。
          return;
        }
        const cached = readCachedProfile();
        if (cached !== null) {
          // 别的标签页改了语言或用户名：语言立即换，显示立即刷新。
          setLocale(cached.locale);
          setUsername(cached.username);
        }
        if (event.key === avatarCacheKey) {
          const avatar = readCachedAvatarData();
          if (avatar !== null) {
            setAvatarUrl(avatar);
          }
        }
      }
    }
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // http.ts 的全局保底：任何请求收到 403 且响应体带 must_change_password
  // 标记，都会广播这个事件，页面在这里进入强制修改密码的拦截。事件是同步
  // 派发的：监听器在错误继续往上抛之前就会执行，各调用方不用各自处理。
  useEffect(() => {
    function onMustChangePassword() {
      setMustChangePassword(true);
    }
    window.addEventListener(mustChangePasswordEvent, onMustChangePassword);
    return () => {
      window.removeEventListener(mustChangePasswordEvent, onMustChangePassword);
    };
  }, []);

  // 推送通道 /api/events（docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md「推送通道」）：
  // 登录态有效期间挂着一条连接，服务器主动推「你已被强制下线」（令牌过期、
  // 密码已修改、被管理员重置），不用等下一次请求收到 401。进入登录态
  //（auth 不是 ready）时效果清理、连接关闭；重新登录成功后 pushEpoch 加一，
  // 效果重跑、新建一条连接，不复用旧的。每标签页一条，同源自动带 cookie。
  useEffect(() => {
    if (auth !== 'ready') {
      return;
    }
    const channel = openPushChannel((reason, message) => {
      handlePushInvalidRef.current?.(reason, message);
    });
    return () => {
      channel.close();
    };
  }, [auth, pushEpoch]);

  // 拦截期间的路径守卫：用户手输别的地址、用浏览器前进后退离开，都送回
  // /password。渲染分支本身不看地址（拦截生效期间只渲染强制改密页），这里
  // 把地址栏也按住，两边一致。
  useEffect(() => {
    if (auth === 'ready' && mustChangePassword && location.pathname !== '/password') {
      void navigate('/password', {replace: true});
    }
  }, [auth, mustChangePassword, location.pathname, navigate]);

  useEffect(() => {
    draftRef.current = draft;
    sessionInvalidRef.current = sessionInvalid;
    navigateRef.current = navigate;
    routingRef.current = routing;
    serviceRef.current = service;
    engineRef.current = engine;
    passwordRef.current = password;
    profileApiRef.current = profileApi;
    sessionActionsRef.current = sessionActions;
  });

  useEffect(() => {
    let cancelled = false;
    listSessions().then(
      async (items) => {
        if (cancelled) {
          return;
        }
        let profile: Profile | null = null;
        try {
          profile = await readProfile();
        } catch (error) {
          if (cancelled) {
            return;
          }
          if (error instanceof ApiError && error.status === 401) {
            setAuth('anonymous');
            return;
          }
        }
        if (cancelled) {
          return;
        }
        let next = sessionsFromList(items);
        if (cancelled) {
          return;
        }
        setSessions(next);
        routingRef.current.claimPath(next);
        if (profile) {
          setUsername(profile.username);
          setLocale(profile.locale);
          setAvatarUrl(profile.avatarUrl);
          saveCachedProfile({username: profile.username, locale: profile.locale});
          // 页面恢复时拿到「必须修改密码」标记：进入拦截。
          setMustChangePassword(profile.mustChangePassword);
        }
        setAuth('ready');
      },
      (error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          setAuth('anonymous');
          return;
        }
        if (
          error instanceof ApiError &&
          error.status === 403 &&
          error.code === mustChangePasswordCode
        ) {
          // 被标了「必须修改密码」的账号刷新页面：会话列表请求被拦成 403，
          // 但登录态还有效。直接进入强制修改密码的拦截，不回登录界面——改密、
          // 退出、资料这些入口都在服务器的豁免清单里，拦截期间这些入口照常可用。
          setMustChangePassword(true);
          setAuth('ready');
          return;
        }
        if (connectionFailure(error)) {
          // 接口服务连不上：登录状态还在（cookie 还在），聊天区照常开着，
          // 只在聊天区上方报一次连不上。用户名字和语言用本地记着的那份。
          setComposingNew(true);
          // 离线启动也恢复新对话自己的草稿：刷新不丢。
          setDraft(readDraft(null));
          serviceRef.current.markService('unreachable');
          setAuth('ready');
          return;
        }
        setLoginOffline(false);
        setLoginDetail(
          explain(error, localeFromSystem(), translations[localeFromSystem()].connectionError),
        );
        setAuth('anonymous');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  function openSidebar() {
    sidebarWanted.current = true;
    setSidebarOpen(true);
  }

  function closeSidebar() {
    // 窄屏上侧边栏是浮层，关掉它不代表用户想在宽屏上也收起。
    if (!narrow) {
      sidebarWanted.current = false;
    }
    setSidebarOpen(false);
  }

  /** 成功之后的短提示：弹窗自己关了，得有个地方告诉用户「成了」。 */
  function showToast(message: string) {
    toastCount.current += 1;
    // id 只在这里生成（O7）：Toast 组件拿它重播动画、重新计时 3 秒，不再自造计数。
    setToast({id: toastCount.current, text: message});
  }

  function enterLogin(detail: string | null) {
    // 被强制退回登录页时，正打到一半的字存起来，登录成功后放回输入框。
    // 主动退出不走这里存：signOut 成功之后会把这份缓存清掉。
    const typed = draftRef.current.trim();
    if (typed !== '') {
      saveUnsent(typed);
    }
    setAuth('anonymous');
    setSessions([]);
    setActiveId(null);
    setDraft('');
    setNotice(null);
    setUsername(null);
    clearCachedProfile();
    setView('chat');
    // 主动退出（登出、改密成功强制回来）地址去规范登录入口 /login：
    // 旧会话 id 不再留在地址栏、浏览器历史和复制出去的链接里，
    // 重新登录后也不会又弹回改密页。被 401 强制退回登录页时地址不动：登录界面
    // 就地渲染，重新登录后由路由自动认领回原会话。
    if (detail === null) {
      void navigateRef.current('/login', {replace: true});
    }
    routingRef.current.resetPasswordEntry();
    setComposingNew(false);
    setConfirmLogout(false);
    setSessionInvalid(null);
    setReloginOpen(false);
    // 回登录界面就解除拦截：标记还在不在，由下一次登录响应说了算。
    setMustChangePassword(false);
    profileApiRef.current.setProfileError(null);
    passwordRef.current.setError(null);
    sessionActionsRef.current.titleSaves.current.clear();
    engineRef.current.resetForLogin();
    setLoginOffline(false);
    setLoginDetail(detail);
    setLoginSubmitting(false);
  }

  /**
   * 会话类 401 的统一入口（轮次引擎、半截回答轮询和 App 自己的请求都走
   * 这里）：带着 reason（expired/disabled）就进入「留在原页面的过期状态」——
   * 聊天页、会话列表、草稿、profile 缓存全部原样保留，只禁用输入区、挂
   * 常驻警示条；没有 reason（老后端）保守回退整页 enterLogin 路径。只在
   * auth 是 ready 时有意义：checking/anonymous 阶段的 401 照旧走整页登录屏。
   */
  function handleAuthError(error: ApiError) {
    if (error.reason === 'expired' || error.reason === 'disabled') {
      setSessionInvalid({reason: error.reason, message: null});
      return;
    }
    enterLogin(error.detail);
  }

  /**
   * 推送通道收到 valid:false：与收到带 reason 的 401 完全同一套行为——
   * 会话、消息、草稿原地保留，输入区禁用、挂常驻警示条。不认识的 reason
   * 词也按失效处理（文案退回帧里的 message）。
   */
  function handlePushInvalid(reason: string, message: string | null) {
    setSessionInvalid({reason: toSessionInvalidReason(reason), message});
  }

  /**
   * 其余动作（侧栏、设置、改密、服务状态恢复）的 401 出口还是 enterLogin：
   * 已经在留在原页面的过期状态里时不再升级成整页清空——横幅已经挂着了，清空
   * 反而把这个状态保住的东西弄丢。
   */
  function enterLoginGuarded(detail: string | null) {
    if (sessionInvalidRef.current !== null) {
      return;
    }
    enterLogin(detail);
  }

  // enterLoginGuarded 的 ref 镜像单独放在它的声明之后：React Compiler 不接受
  // 在函数声明之前把它捕获进任何闭包（会报「初始化期间读取」），而上面的大
  // 镜像效果位于声明之前。storage 监听只读 ref，不直接捕获函数。
  useEffect(() => {
    enterLoginGuardedRef.current = enterLoginGuarded;
  });

  // handlePushInvalid 的 ref 镜像单独放在它的声明之后：和 enterLoginGuardedRef
  // 同一个理由，React Compiler 不接受在函数声明之前把它捕获进闭包。
  useEffect(() => {
    handlePushInvalidRef.current = handlePushInvalid;
  });

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

  async function submitLogin(usernameValue: string, password: string) {
    if (loginOffline) {
      return;
    }
    setLoginSubmitting(true);
    setLoginOffline(false);
    setLoginDetail(null);
    setLoginNotice(null);
    try {
      const result = await login(usernameValue, password);
      await openAccount(result);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setLoginDetail(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        setLoginOffline(true);
        service.showConnectionWarning();
        return;
      }
      setLoginDetail(explain(error, locale, text.connectionError));
    } finally {
      setLoginSubmitting(false);
    }
  }

  async function openAccount(result: LoginResult) {
    // 登录回来了：清掉上一次登出留下的标记（事件只认写入瞬间，墓碑不留着）。
    clearLogoutMarker();
    if (isLocale(result.locale)) {
      setLocale(result.locale);
    }
    // 上一个登录态的进行中请求、轮询和「线程已加载」标记都作废：一次清掉。
    // 整页登录路径里 enterLogin 已经清过（幂等）；在原页面重新登录靠这次清理
    // 加 bumpThreadRetry 让当前会话的历史重新拉取——activeId 和 auth 都没变，
    // 线程加载效果只能靠 retry 计数重新触发。
    engineRef.current.resetForLogin();
    engineRef.current.bumpThreadRetry();
    setSessionInvalid(null);
    setReloginOpen(false);
    // 登录响应里的「必须修改密码」标记：为真就进入拦截（只渲染强制改密页），
    // 为假解除拦截、恢复正常。
    setMustChangePassword(result.must_change_password);
    // 重新登录成功后推送通道新建一条连接：auth 本来就是 ready 时（在原页面
    // 重新登录）靠这个编号让通道效果重跑；全新登录时 auth 的变化同样触发。
    setPushEpoch((current) => current + 1);
    let next = sessionsFromList(result.sessions);
    setSessions(next);
    routingRef.current.claimPath(next);
    // 被强制下线时存下的那句话放回输入框；放回就消费掉，别带去再下一次登录。
    // 在原页面重新登录时输入框里的字本来就留着，没有存下的句子就不要动它。
    const unsent = readUnsent();
    if (unsent !== '') {
      setDraft(unsent);
      clearUnsent();
    }
    setNotice(null);
    setView('chat');
    setAuth('ready');
    void readProfile()
      .then((profile) => {
        setUsername(profile.username);
        setLocale(profile.locale);
        setAvatarUrl(profile.avatarUrl);
        saveCachedProfile({username: profile.username, locale: profile.locale});
        // 重新拉一份 profile 核对标记：改密成功时服务器在同一个事务里清掉
        // 它；万一这里还拿到 true，拦截重新生效。
        setMustChangePassword(profile.mustChangePassword);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          handleAuthError(error);
        }
      });
  }

  /**
   * 输入框变化：更新状态，同时存进当前会话自己的草稿（N3：sessionStorage
   * 按键 h2bot-draft:{会话id} 各存各的，新对话用固定键）。每次按键即写而
   * 不做防抖：sessionStorage 同步写开销可忽略，省掉「切会话/卸载时何时
   * flush」的时序隐患。引擎的 busy 回填（setDraft）也走这里，回填的文字
   * 同样写进对应会话的草稿。
   */
  function handleDraft(value: string) {
    setDraft(value);
    saveDraft(activeId, value);
  }

  function showSession(id: string) {
    setComposingNew(false);
    setActiveId(id);
    // 草稿按会话各存各的：切会话不互相清，切回来原样恢复。
    setDraft(readDraft(id));
    setNotice(null);
    setView('chat');
  }

  function showNewChat() {
    setComposingNew(true);
    setActiveId(null);
    // unsent 恢复优先于草稿：被强制下线、busy 回填存下的句子不能丢；
    // 没有存下的句子才用新对话自己的草稿。
    const unsent = readUnsent();
    setDraft(unsent !== '' ? unsent : readDraft(null));
    setNotice(null);
    setView('chat');
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

  async function signOut() {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    profileApi.setProfileError(null);
    try {
      await logout();
      enterLogin(null);
      // 主动退出：enterLogin 刚存过草稿，这里清掉，别带去下一次登录。
      // （退出时 401 是被强制下线，走上面 catch 的路，不清。）
      clearUnsent();
      // 各会话的草稿也在主动退出时清空：共用电脑不留半截字（对齐
      // clearCachedProfile 的隐私处理）。被强制下线不清——重新登录后草稿原样恢复。
      clearAllDrafts();
      // 把主动登出广播给其他标签页（P7）：收到 storage 事件的标签页立即
      // 回登录界面，不等下一次 401。写入方收不到自己的 storage 事件。
      writeLogoutMarker();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(null);
        return;
      }
      if (connectionFailure(error)) {
        service.showConnectionWarning();
        return;
      }
      profileApi.setProfileError(explain(error, locale, text.connectionError));
    } finally {
      setLoggingOut(false);
    }
  }

  function addSession() {
    if (composingNew) {
      setView('chat');
      return;
    }
    showNewChat();
    void navigate('/');
  }

  async function sendFirstMessage(question: string) {
    setSendingNew(true);
    setNotice(null);
    let sessionId = '';
    try {
      const title = titleFromQuestion(question);
      const created = emptySession(await createSession(title));
      sessionId = created.id;
      void navigate(`/chat/${created.id}`, {replace: true});
      engine.markThreadLoaded(sessionId);
      const turnId = crypto.randomUUID();
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        text: question,
        locale,
        turnId,
      };
      setComposingNew(false);
      setSessions((current) => [
        {
          ...created,
          title: created.title ?? title,
          messages: [userMessage],
          messagesKnown: true,
        },
        ...current,
      ]);
      setActiveId(created.id);
      clearUnsent();
      // 发送成功：清掉新对话自己的草稿（问题已经进线程了）。
      clearDraft(null);
      setDraft('');
      markEntering(userMessage.id);
      engine.sendingRef.current.add(sessionId);
      engine.setPendingIds((current) => new Set(current).add(sessionId));
      engine.clearSessionWarning(sessionId);
      await engine.sendQuestion(sessionId, question, turnId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // 会话在发出前就过期了：这句提问存起来，登录后放回输入框。
        saveUnsent(question);
        handleAuthError(error);
        return;
      }
      if (connectionFailure(error)) {
        service.showConnectionWarning();
        return;
      }
      if (sessionId === '') {
        setNotice(explain(error, locale, text.connectionError));
      }
    } finally {
      setSendingNew(false);
      if (sessionId !== '') {
        engine.sendingRef.current.delete(sessionId);
        // 与引擎的 finally 对齐：断线恢复已经把轮询接过去时不清 pending，
        // 不然输入框被解锁，下一次发送会碰到 409。
        if (!engine.hasLivePoller(sessionId)) {
          engine.setPendingIds((current) => {
            const next = new Set(current);
            next.delete(sessionId);
            return next;
          });
        }
      }
    }
  }

  function submitMessage(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (
      !question ||
      sendingNew ||
      sessionInvalid !== null ||
      (active && engine.sendingRef.current.has(active.id))
    ) {
      return;
    }
    if (!active) {
      void sendFirstMessage(question);
      return;
    }
    const sessionId = active.id;
    const title = titleFromQuestion(question);
    const missingTitle = active.title === null;
    const turnId = crypto.randomUUID();
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      text: question,
      locale,
      turnId,
    };
    engine.sendingRef.current.add(sessionId);
    engine.setPendingIds((current) => new Set(current).add(sessionId));
    setNotice(null);
    engine.clearSessionWarning(sessionId);
    clearUnsent();
    // 发送成功：清掉这场会话自己的草稿。
    clearDraft(sessionId);
    setDraft('');
    updateSession(sessionId, (session) => ({
      ...session,
      title: session.title ?? title,
      messages: [...session.messages, userMessage],
    }));
    markEntering(userMessage.id);
    if (missingTitle) {
      const saving = sessionActions
        .saveTitle(sessionId, title)
        .then((saved) => {
          if (!saved) {
            updateSession(sessionId, (session) => ({...session, title: null}));
          }
        })
        .finally(() => {
          sessionActions.titleSaves.current.delete(sessionId);
        });
      sessionActions.titleSaves.current.set(sessionId, saving);
    }
    void engine.sendQuestion(sessionId, question, turnId);
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
        offline={loginOffline}
        submitting={loginSubmitting}
        onLocale={setLocale}
        onSubmit={(usernameValue, password) => {
          void submitLogin(usernameValue, password);
        }}
      />
    );
  }

  // 「必须修改密码」拦截：标记为真就只渲染强制改密页，正常聊天主体一概不
  // 渲染；地址由上面的守卫效果按在 /password。改密成功后服务器吊销这个账号
  // 的全部登录（含当前设备），走 use-password-change 既有的成功路径回登录
  // 界面；重新登录后由登录响应里的标记解除拦截。
  if (mustChangePassword) {
    return (
      <ChangePasswordPage
        locale={locale}
        username={username}
        error={password.error}
        busy={password.busy}
        forced
        onSubmit={password.submit}
      />
    );
  }

  // 修改密码是独立的一页，不是弹窗：没有背景可误点，密码输一半不会丢。
  // 地址是 /password，刷新和后退都是页面的行为，不是弹窗的。
  if (location.pathname === '/password') {
    return (
      <ChangePasswordPage
        locale={locale}
        username={username}
        error={password.error}
        busy={password.busy}
        onSubmit={password.submit}
        onCancel={() => {
          password.setError(null);
          if (routing.isPasswordPushed()) {
            // 入口压入过一条历史记录：取消就是后退，路径效果会把视图跟着地址带回去。
            void navigate(-1);
            return;
          }
          // 直接以 /password 打开（刷新、粘贴地址），历史里没有可退的：
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
    <div className={chatFrameClass(narrow, sidebarOpen)}>
      <Sidebar
        locale={locale}
        narrow={narrow}
        open={sidebarOpen}
        sessions={sessions}
        activeId={activeId}
        settingsOpen={view === 'profile'}
        username={username}
        avatarUrl={avatarUrl}
        onCreate={addSession}
        onClose={() => {
          closeSidebar();
        }}
        onOpenSession={openSession}
        onRename={(id, title) => sessionActions.renameOpenSession(id, title)}
        onDelete={(id) => sessionActions.removeSession(id)}
        onPin={(id, pinned) => {
          void sessionActions.pinOpenSession(id, pinned);
        }}
        onOpenSettings={() => {
          setConfirmLogout(false);
          profileApi.setProfileError(null);
          setView('profile');
        }}
      />
      <ChatMain
        key={active?.id ?? 'new'}
        locale={locale}
        sidebarOpen={sidebarOpen}
        onShowSidebar={() => {
          openSidebar();
        }}
        active={active}
        warnings={warnings}
        enteringIds={enteringIds}
        onAnimationEnd={(id) => {
          setEnteringIds((current) => {
            if (!current.has(id)) {
              return current;
            }
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }}
        pending={activePending}
        presentIds={engine.presentIds}
        onPresentEnd={engine.endPresent}
        progressText={progressText}
        draft={draft}
        inputLocked={inputLocked}
        sendLocked={sendLocked}
        onWaitHint={() => {
          showToast(text.waitForReply);
        }}
        onDraft={handleDraft}
        onSubmit={submitMessage}
        onStop={() => {
          if (active) {
            void engine.stopSending(active.id);
          }
        }}
        onRetry={(turnId) => {
          if (active) {
            void engine.retryTurn(active.id, turnId);
          }
        }}
        onEditResend={(turnId, text) => {
          if (active) {
            void engine.retryTurn(active.id, turnId, text);
          }
        }}
        onFeedback={async (turnId, feedback) => {
          if (!active) {
            return false;
          }
          try {
            await sendFeedback(active.id, turnId, feedback);
            return true;
          } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
              // 点赞途中被强制下线：跟其他动作一样走统一的 401 入口。
              handleAuthError(error);
              return false;
            }
            if (connectionFailure(error)) {
              service.showConnectionWarning();
              return false;
            }
            // 后端拒绝（404 轮次不存在、502 上游没收到）或别的错：进输入区
            // 上方的警示横幅；简中显示后端 detail 原文，英文/繁中优先按状态码
            // 映射；按钮状态由 MessageActions 回退。
            setNotice(explain(error, locale, text.actionFailed));
            return false;
          }
        }}
      />
      <SettingsModal
        locale={locale}
        open={view === 'profile'}
        username={username}
        avatarUrl={avatarUrl}
        avatarBusy={profileApi.savingAvatar}
        hasCustomAvatar={avatarUrl !== null && !avatarUrl.startsWith(defaultAvatarUrl)}
        error={confirmLogout ? null : profileApi.profileError}
        saving={profileApi.savingLocale}
        onLocale={(next) => {
          void profileApi.changeLocale(next);
        }}
        onAvatarPick={(file) => {
          void profileApi.pickAvatar(file);
        }}
        onChangePassword={() => {
          password.setError(null);
          // 真页面：地址变成 /password，压入一条历史记录，浏览器后退就能回来。
          routing.markPasswordPushed();
          void navigate('/password');
        }}
        onLogout={() => setConfirmLogout(true)}
        onClose={() => {
          setConfirmLogout(false);
          profileApi.setProfileError(null);
          setView('chat');
        }}
      />
      <ConfirmLogout
        locale={locale}
        open={confirmLogout}
        error={profileApi.profileError}
        loggingOut={loggingOut}
        onCancel={() => {
          profileApi.setProfileError(null);
          setConfirmLogout(false);
        }}
        onConfirm={() => {
          void signOut();
        }}
      />
      {/* 会话过期后的就地重新登录：Modal 里放 LoginScreen 同款卡片，不清聊天页的
          任何状态；登录失败弹窗不关，错误留在表单里；成功由 openAccount 就地
          恢复（刷新 profile 和会话列表）。disabled 不提供（终态，登录也没用）。 */}
      <Modal
        open={sessionInvalid !== null && sessionInvalid.reason !== 'disabled' && reloginOpen}
        titleId="relogin-title"
        panelClass="w-full max-w-sm p-0"
        onClose={() => {
          setReloginOpen(false);
          setLoginDetail(null);
          setLoginOffline(false);
        }}
      >
        <LoginScreen
          locale={locale}
          error={loginError}
          offline={loginOffline}
          submitting={loginSubmitting}
          embedded
          headingId="relogin-title"
          onLocale={setLocale}
          onSubmit={(usernameValue, password) => {
            void submitLogin(usernameValue, password);
          }}
        />
      </Modal>
      <Toast
        toast={toast}
        lang={htmlLang[locale]}
        onDismiss={() => {
          setToast(null);
        }}
      />
    </div>
  );
}
