import {type SubmitEvent, useEffect, useRef, useState} from 'react';
import {useNarrowScreen} from './hooks/use-narrow-screen.ts';
import {streamReply} from './api/chat.ts';
import {connectionFailure, explain} from './api/failure.ts';
import {ApiError} from './api/http.ts';
import {readPartial} from './api/partial.ts';
import type {PartialReply} from './api/partial.ts';
import {readStatus} from './api/status.ts';
import {changePassword, logout, readProfile, updateProfile, uploadAvatar} from './api/profile.ts';
import {defaultAvatarUrl, type Profile} from './api/profile.ts';
import {
  abortReply,
  createSession,
  deleteSession,
  emptySession,
  listSessions,
  login,
  pinSession,
  renameSession,
  sessionsFromList,
} from './api/session.ts';
import type {LoginResult} from './api/session.ts';
import {AdminConsole} from './components/admin/AdminConsole.tsx';
import {ChatMain} from './components/chat/ChatMain.tsx';
import type {WarningItem} from './components/chat/WarningBox.tsx';
import {LoginScreen} from './components/login/LoginScreen.tsx';
import {ChangePasswordPage} from './components/settings/ChangePasswordPage.tsx';
import {ConfirmLogout} from './components/settings/ConfirmLogout.tsx';
import {SettingsModal} from './components/settings/SettingsModal.tsx';
import {chatFrameClass} from './components/shell/frame-class.ts';
import {Sidebar} from './components/sidebar/Sidebar.tsx';
import {Toast} from './components/toast/Toast.tsx';
import {translations} from './i18n.ts';
import {clearCachedProfile, readCachedProfile, saveCachedProfile} from './session/profile-cache.ts';
import type {CachedProfile} from './session/profile-cache.ts';
import {clearUnsent, readUnsent, saveUnsent} from './session/unsent.ts';
import {titleFromQuestion} from './session/title.ts';
import {loadThread} from './session/thread.ts';
import {startPartialPolling} from './session/poll.ts';
import {visibleText} from './session/text.ts';
import {BrowserRouter, matchPath, Route, Routes, useLocation, useNavigate} from 'react-router';
import type {Message, Session} from './type/chat.ts';
import {htmlLang, isLocale, localeFromSystem, type Locale} from './type/locale.ts';

const statusIntervalMs = 30000;

type ServiceState = 'ok' | 'unreachable' | 'database' | 'store';

function serviceNoticeText(
  state: ServiceState,
  copy: (typeof translations)[Locale],
): string | null {
  if (state === 'unreachable') {
    return copy.connectionRetry;
  }
  if (state === 'database') {
    return copy.serviceUnavailable;
  }
  if (state === 'store') {
    return copy.replyStoreUnavailable;
  }
  return null;
}

/**
 * 路由用真实路径：/admin 整页渲染管理员控制台，其余地址交给聊天侧
 * （ChatApp），由它再认 /、/chat/:id、/password 和 /login。旧的查询参数
 * 地址（?session=、?page=）由 ChatApp 里的兼容效果重定向到新路径。
 * 控制台是完全独立的一页——聊天侧的会话和用户信息引导流程一概不跑
 * （ChatApp 压根不挂载）。
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin" element={<AdminConsole />} />
        <Route path="/*" element={<ChatApp />} />
      </Routes>
    </BrowserRouter>
  );
}

/** /chat/:id 里的会话 id；其它路径（含不带 id 的 /chat）返回 null。 */
function chatIdFromPath(pathname: string): string | null {
  const matched = matchPath('/chat/:id', pathname);
  return matched?.params.id ?? null;
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
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia('(max-width: 767px)').matches,
  );
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
  const [sessionWarning, setSessionWarning] = useState<{sessionId: string; text: string} | null>(
    null,
  );
  const [username, setUsername] = useState<string | null>(() => cachedProfile?.username ?? null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [view, setView] = useState<'chat' | 'profile'>('chat');
  const [composingNew, setComposingNew] = useState(false);
  const [sendingNew, setSendingNew] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [changePasswordBusy, setChangePasswordBusy] = useState(false);
  const [changePasswordError, setChangePasswordError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [savingLocale, setSavingLocale] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [enteringIds, setEnteringIds] = useState<string[]>([]);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<{id: number; text: string; lang: string} | null>(null);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [threadRetry, setThreadRetry] = useState(0);
  const [serviceState, setServiceState] = useState<ServiceState>('ok');
  const serviceStateRef = useRef<ServiceState>('ok');
  const sendingRef = useRef<Set<string>>(new Set());
  const aborters = useRef(new Map<string, {controller: AbortController; turnId: string}>());
  const stoppers = useRef(new Map<string, Promise<void>>());
  const titleSaves = useRef(new Map<string, Promise<void>>());
  const pollers = useRef(new Map<string, () => void>());
  const sessionsRef = useRef(sessions);
  const draftRef = useRef(draft);
  const localeRef = useRef(locale);
  const activeIdRef = useRef(activeId);
  const authRef = useRef(auth);
  const locationRef = useRef(location);
  // 异步回调和旧有效果调用的函数统一从 ref 里拿 navigate：走 ref 就不会
  // 成为各个效果的响应式依赖，和 connectionWarningRef 是同一套路。
  const navigateRef = useRef(navigate);
  // 改密页是怎么进来的：'push' = 从设置里点进来（压过一条历史，取消等于浏览器后退）；
  // 'direct' = 刷新、贴地址或前进后退直接打开（没有可退的，取消就地替换路径）；
  // null = 当前不在改密页。
  const passwordEntry = useRef<'push' | 'direct' | null>(null);
  // 上一次渲染时的路径：路径同步效果靠它判断「刚离开改密页」。
  const prevPathRef = useRef('');
  const loadedThreads = useRef(new Set<string>());
  const threadFlight = useRef(new Set<string>());
  const connectionWarningRef = useRef<() => void>(() => undefined);
  const connectionCopyRef = useRef('');
  const toastCount = useRef(0);
  const resumePartialRef = useRef<(sessionId: string, messages: Message[]) => void>(
    () => undefined,
  );
  const text = translations[locale];
  const loginError = loginOffline ? text.connectionError : loginDetail;
  const serviceNotice = serviceNoticeText(serviceState, text);
  const active = sessions.find((session) => session.id === activeId);
  const activePending = active ? pendingIds.has(active.id) : false;
  const inputLocked = sendingNew || activePending;
  const historyLocked = historyLoadingId === active?.id && active.messages.length === 0;
  // 会话级的提示都在聊天区顶部的警示框里，只有一种样子。
  const warnings: WarningItem[] = [];
  if (serviceNotice !== null) {
    warnings.push({id: 'service', tone: 'warning', text: serviceNotice});
  }
  if (notice !== null) {
    warnings.push({id: 'notice', tone: 'error', text: notice});
  }
  if (sessionWarning !== null && sessionWarning.sessionId === active?.id) {
    warnings.push({
      id: 'session',
      tone: 'warning',
      text: sessionWarning.text,
      onDismiss: () => {
        setSessionWarning(null);
      },
    });
  }

  useEffect(() => {
    document.documentElement.lang = htmlLang[locale];
    document.title = 'H^2 Bot';
  }, [locale]);

  useEffect(() => {
    // 窗口从窄变宽：按用户之前的偏好把侧边栏恢复回去。
    if (!narrow) {
      setSidebarOpen(sidebarWanted.current);
    }
  }, [narrow]);

  useEffect(() => {
    sessionsRef.current = sessions;
    draftRef.current = draft;
    localeRef.current = locale;
    activeIdRef.current = activeId;
    authRef.current = auth;
    locationRef.current = location;
    navigateRef.current = navigate;
    connectionWarningRef.current = showConnectionWarning;
    connectionCopyRef.current = text.connectionError;
    resumePartialRef.current = resumePartial;
  });

  useEffect(() => {
    if (auth !== 'ready' || composingNew || activeId === null) {
      return;
    }
    const sessionId = activeId;
    const flights = threadFlight.current;
    if (loadedThreads.current.has(sessionId) || flights.has(sessionId)) {
      return;
    }
    const existing = sessionsRef.current.find((session) => session.id === sessionId);
    if (existing && existing.messages.length > 0) {
      loadedThreads.current.add(sessionId);
      return;
    }
    let cancelled = false;
    flights.add(sessionId);
    setHistoryLoadingId(sessionId);
    void loadThread(sessionId, localeRef.current)
      .then((thread) => {
        if (cancelled) {
          return;
        }
        loadedThreads.current.add(sessionId);
        setSessions((current) =>
          current.map((session) => {
            if (session.id !== sessionId || session.messages.length > 0) {
              return session;
            }
            return {...session, messages: thread.messages, messagesKnown: true};
          }),
        );
        if (thread.partial.status === 'streaming') {
          resumePartialRef.current(sessionId, thread.messages);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          enterLogin(error.detail);
          return;
        }
        if (connectionFailure(error)) {
          connectionWarningRef.current();
          return;
        }
        setNotice(explain(error, connectionCopyRef.current));
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        flights.delete(sessionId);
        setHistoryLoadingId((current) => (current === sessionId ? null : current));
      });
    return () => {
      cancelled = true;
      flights.delete(sessionId);
      setHistoryLoadingId((current) => (current === sessionId ? null : current));
    };
  }, [activeId, auth, composingNew, threadRetry]);

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
        claimPath(next);
        if (profile) {
          setUsername(profile.username);
          setLocale(profile.locale);
          setAvatarUrl(profile.avatarUrl);
          saveCachedProfile({username: profile.username, locale: profile.locale});
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
        if (connectionFailure(error)) {
          // 接口服务连不上：登录状态还在（cookie 还在），聊天区照常开着，
          // 只在聊天区上方报一次连不上。用户名字和语言用本地记着的那份。
          setComposingNew(true);
          markService('unreachable');
          setAuth('ready');
          return;
        }
        setLoginOffline(false);
        setLoginDetail(explain(error, translations[localeFromSystem()].connectionError));
        setAuth('anonymous');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (auth !== 'ready') {
      return;
    }
    let stopped = false;
    let timer = 0;

    const check = async () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      try {
        const status = await readStatus();
        if (stopped) {
          return;
        }
        const wasDown = serviceStateRef.current === 'unreachable';
        if (status.reply_store === 'unavailable') {
          markService('store');
        } else if (status.database === 'unavailable') {
          markService('database');
        } else {
          markService('ok');
        }
        if (wasDown) {
          // 服务器刚回来：把会话列表和用户信息补上。
          void refreshWorkspace();
        }
      } catch {
        if (!stopped) {
          markService('unreachable');
        }
      }
    };

    const tick = async () => {
      await check();
      if (!stopped) {
        timer = window.setTimeout(tick, statusIntervalMs);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void check();
      }
    };

    void tick();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [auth]);

  // 旧地址兼容：?page=admin、?page=password、?session=<id> 都是旧的查询参数
  // 格式，认出来就就地重定向到对应的真实路径。不带 id 的 /chat、未知路径和
  // 多余的参数也在这里一并归位。
  useEffect(() => {
    const {pathname, search} = location;
    if (search !== '') {
      const params = new URLSearchParams(search);
      const page = params.get('page');
      const session = params.get('session');
      if (page === 'admin') {
        void navigate('/admin', {replace: true});
      } else if (page === 'password') {
        void navigate('/password', {replace: true});
      } else if (session !== null && session !== '') {
        void navigate(`/chat/${session}`, {replace: true});
      } else {
        void navigate(pathname, {replace: true});
      }
      return;
    }
    if (pathname === '/' || pathname === '/login' || pathname === '/password') {
      return;
    }
    if (chatIdFromPath(pathname) === null) {
      void navigate('/', {replace: true});
    }
  }, [location.pathname, location.search, navigate]);

  // 路径驱动聊天状态：前进后退或代码导航在 / 与 /chat/:id 之间切换时，
  // 把对应的会话带到台前。取代原来手写的历史监听。
  useEffect(() => {
    const pathname = location.pathname;
    if (authRef.current !== 'ready') {
      prevPathRef.current = pathname;
      return;
    }
    if (pathname === '/password') {
      if (passwordEntry.current === null) {
        // 浏览器前进后退回到改密页：历史里这一条本来就是压进去的。
        passwordEntry.current = 'push';
      }
      prevPathRef.current = pathname;
      return;
    }
    passwordEntry.current = null;
    const leavingPassword = prevPathRef.current === '/password';
    prevPathRef.current = pathname;
    if (leavingPassword) {
      setView('chat');
    }
    if (pathname === '/login') {
      // 已登录还站在 /login：送回根路径是 claimPath 的事，这里不动聊天状态。
      return;
    }
    const wanted = chatIdFromPath(pathname);
    if (wanted === null) {
      if (pathname === '/') {
        showNewChat();
      }
      return;
    }
    const found = sessionsRef.current.find((session) => session.id === wanted);
    if (found === undefined) {
      // 地址里的会话不存在（被删了，或换账号重登）：回根路径重新来过。
      showNewChat();
      void navigate('/', {replace: true});
      return;
    }
    if (leavingPassword && wanted === activeIdRef.current) {
      // 从改密页退回来、会话没变：只切视图，不走 showSession/showNewChat，
      // 输入框里没发出去的字原样留着。
      return;
    }
    if (wanted !== activeIdRef.current) {
      showSession(found.id);
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    const active = pollers.current;
    return () => {
      for (const stop of active.values()) {
        stop();
      }
      active.clear();
    };
  }, []);

  /** 登录或引导完成后按当前路径认领状态：打开哪个会话、停在改密页还是回根路径。 */
  function claimPath(list: Session[]): void {
    const {pathname} = locationRef.current;
    if (pathname === '/password') {
      // 直接以 /password 打开、或在改密页上刷新：留在改密页。
      // 这种进入方式历史里没有我们压的那一条，取消走就地替换的路。
      passwordEntry.current = 'direct';
      return;
    }
    if (pathname === '/login') {
      // 已经登录了，规范登录入口没有存在的意义：回根路径，
      // 聊天状态交给路径同步效果收拾。
      void navigateRef.current('/', {replace: true});
      return;
    }
    const wanted = chatIdFromPath(pathname);
    if (wanted === null) {
      setComposingNew(true);
      setActiveId(null);
      return;
    }
    const found = list.find((session) => session.id === wanted);
    if (found === undefined) {
      void navigateRef.current('/', {replace: true});
      setComposingNew(true);
      setActiveId(null);
      return;
    }
    setComposingNew(false);
    setActiveId(found.id);
  }

  function showConnectionWarning() {
    // 连不上服务器归到服务状态里：聊天区上方只出一个框，不重复报两遍。
    markService('unreachable');
  }

  function markService(state: ServiceState) {
    serviceStateRef.current = state;
    setServiceState(state);
  }

  /** 服务器回来了：把会话列表和用户信息补上，不用用户手动刷新页面。 */
  async function refreshWorkspace(): Promise<void> {
    try {
      const items = await listSessions();
      const next = sessionsFromList(items);
      setSessions(next);
      // 按当前地址重新认领状态：离线期间停在 /chat/<id> 的，把会话重新打开。
      claimPath(next);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
      }
      return;
    }
    try {
      const profile = await readProfile();
      setUsername(profile.username);
      setLocale(profile.locale);
      setAvatarUrl(profile.avatarUrl);
      saveCachedProfile({username: profile.username, locale: profile.locale});
    } catch {
      return;
    }
  }

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
    setToast({id: toastCount.current, text: message, lang: htmlLang[locale]});
  }

  function enterLogin(detail: string | null) {
    // 被踢回登录页时，正打到一半的字存起来，登录成功后放回输入框。
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
    // 重新登录后也不会又弹回改密页。被 401 踢出时地址不动：登录界面
    // 就地渲染，重新登录后由路由自动认领回原会话。
    if (detail === null) {
      void navigateRef.current('/login', {replace: true});
    }
    passwordEntry.current = null;
    setComposingNew(false);
    setConfirmLogout(false);
    setProfileError(null);
    setChangePasswordError(null);
    setPendingIds(new Set());
    setHistoryLoadingId(null);
    loadedThreads.current.clear();
    threadFlight.current.clear();
    titleSaves.current.clear();
    for (const stop of pollers.current.values()) {
      stop();
    }
    pollers.current.clear();
    setSessionWarning(null);
    setLoginOffline(false);
    setLoginDetail(detail);
    setLoginSubmitting(false);
  }

  function updateSession(sessionId: string, change: (session: Session) => Session) {
    setSessions((current) =>
      current.map((session) => (session.id === sessionId ? change(session) : session)),
    );
  }

  function markEntering(id: string) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion) {
      setEnteringIds((current) => [...current, id]);
    }
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
        showConnectionWarning();
        return;
      }
      setLoginDetail(explain(error, text.connectionError));
    } finally {
      setLoginSubmitting(false);
    }
  }

  async function openAccount(result: LoginResult) {
    if (isLocale(result.locale)) {
      setLocale(result.locale);
    }
    let next = sessionsFromList(result.sessions);
    setSessions(next);
    claimPath(next);
    // 被踢时存下的那句话放回输入框；放回就消费掉，别带去再下一次登录。
    const unsent = readUnsent();
    setDraft(unsent);
    if (unsent !== '') {
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
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          enterLogin(error.detail);
        }
      });
  }

  function rememberDraft() {
    const typed = draftRef.current.trim();
    if (typed !== '') {
      saveUnsent(typed);
    }
  }

  function showSession(id: string) {
    rememberDraft();
    setComposingNew(false);
    setActiveId(id);
    setDraft('');
    setNotice(null);
    setView('chat');
  }

  function showNewChat() {
    rememberDraft();
    setComposingNew(true);
    setActiveId(null);
    setDraft(readUnsent());
    setNotice(null);
    setView('chat');
  }

  function openSession(id: string) {
    if (id === activeId && !composingNew) {
      setView('chat');
      if (!loadedThreads.current.has(id) && !threadFlight.current.has(id)) {
        setThreadRetry((current) => current + 1);
      }
      return;
    }
    showSession(id);
    void navigate(`/chat/${id}`);
  }

  async function changeLocale(next: Locale) {
    if (next === locale || savingLocale) {
      return;
    }
    setSavingLocale(true);
    setProfileError(null);
    try {
      const profile = await updateProfile(next);
      setUsername(profile.username);
      setLocale(profile.locale);
      setAvatarUrl(profile.avatarUrl);
      saveCachedProfile({username: profile.username, locale: profile.locale});
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        showConnectionWarning();
        return;
      }
      setProfileError(explain(error, text.connectionError));
    } finally {
      setSavingLocale(false);
    }
  }

  async function pickAvatar(file: File) {
    if (savingAvatar) {
      return;
    }
    setSavingAvatar(true);
    setProfileError(null);
    try {
      const profile = await uploadAvatar(file);
      setAvatarUrl(profile.avatarUrl);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        showConnectionWarning();
        return;
      }
      setProfileError(explain(error, text.connectionError));
    } finally {
      setSavingAvatar(false);
    }
  }

  async function signOut() {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    setProfileError(null);
    try {
      await logout();
      enterLogin(null);
      // 主动退出：enterLogin 刚存过草稿，这里清掉，别带去下一次登录。
      // （退出时 401 是被踢，走上面 catch 的路，不清。）
      clearUnsent();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(null);
        return;
      }
      if (connectionFailure(error)) {
        showConnectionWarning();
        return;
      }
      setProfileError(explain(error, text.connectionError));
    } finally {
      setLoggingOut(false);
    }
  }

  async function submitChangePassword(
    oldPassword: string,
    newPassword: string,
    confirmPassword: string,
  ) {
    if (changePasswordBusy) {
      return;
    }
    setChangePasswordBusy(true);
    setChangePasswordError(null);
    try {
      await changePassword(oldPassword, newPassword, confirmPassword);
      // 成功：服务端已经清掉本设备的 login cookie、吊销了这个账号所有设备的登录，
      // 不用再调 logout，直接带着提示回登录页。
      setLoginNotice(text.passwordChanged);
      enterLogin(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        showConnectionWarning();
        return;
      }
      setChangePasswordError(explain(error, text.connectionError));
    } finally {
      setChangePasswordBusy(false);
    }
  }

  async function renameOpenSession(id: string, title: string): Promise<boolean> {
    const trimmed = title.trim();
    if (trimmed === '') {
      return false;
    }
    const pendingTitle = titleSaves.current.get(id);
    if (pendingTitle) {
      await pendingTitle;
    }
    try {
      const item = await renameSession(id, trimmed);
      showToast(text.renameDone);
      setSessions((current) =>
        current.map((session) => {
          if (session.id !== id) {
            return session;
          }
          return {
            ...session,
            title: item.title,
          };
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return false;
      }
      if (connectionFailure(error)) {
        showConnectionWarning();
        return false;
      }
      setNotice(explain(error, text.connectionError));
      return false;
    }
  }

  async function saveTitle(sessionId: string, title: string): Promise<boolean> {
    try {
      await renameSession(sessionId, title);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return false;
      }
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return false;
      }
      if (connectionFailure(error)) {
        showConnectionWarning();
        return false;
      }
      setNotice(explain(error, text.connectionError));
      return false;
    }
  }

  async function removeSession(id: string): Promise<boolean> {
    const wasCurrent = activeId === id;
    try {
      await deleteSession(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return false;
      }
      if (connectionFailure(error)) {
        showConnectionWarning();
        return false;
      }
      setNotice(explain(error, text.connectionError));
      return false;
    }
    setSessions((current) => current.filter((session) => session.id !== id));
    showToast(text.deleteDone);
    stopPolling(id);
    clearPending(id);
    if (!wasCurrent) {
      return true;
    }
    showNewChat();
    void navigate('/', {replace: true});
    return true;
  }

  async function pinOpenSession(id: string, pinned: boolean) {
    try {
      const item = await pinSession(id, pinned, pinned ? new Date().toISOString() : null);
      setSessions((current) =>
        current.map((session) =>
          session.id === id ? {...session, pinned: item.pinned, pinnedAt: item.pinned_at} : session,
        ),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        showConnectionWarning();
        return;
      }
      setNotice(explain(error, text.connectionError));
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
      loadedThreads.current.add(sessionId);
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
      setDraft('');
      markEntering(userMessage.id);
      sendingRef.current.add(sessionId);
      setPendingIds((current) => new Set(current).add(sessionId));
      clearSessionWarning(sessionId);
      await sendQuestion(sessionId, question, turnId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // 会话在发出前就过期了：这句提问存起来，登录后放回输入框。
        saveUnsent(question);
        enterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        showConnectionWarning();
        return;
      }
      if (sessionId === '') {
        setNotice(explain(error, text.connectionError));
      }
    } finally {
      setSendingNew(false);
      if (sessionId !== '') {
        sendingRef.current.delete(sessionId);
        setPendingIds((current) => {
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
      }
    }
  }

  function submitMessage(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || sendingNew || (active && sendingRef.current.has(active.id))) {
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
    sendingRef.current.add(sessionId);
    setPendingIds((current) => new Set(current).add(sessionId));
    setNotice(null);
    clearSessionWarning(sessionId);
    clearUnsent();
    setDraft('');
    updateSession(sessionId, (session) => ({
      ...session,
      title: session.title ?? title,
      messages: [...session.messages, userMessage],
    }));
    markEntering(userMessage.id);
    if (missingTitle) {
      const saving = saveTitle(sessionId, title)
        .then((saved) => {
          if (!saved) {
            updateSession(sessionId, (session) => ({...session, title: null}));
          }
        })
        .finally(() => {
          titleSaves.current.delete(sessionId);
        });
      titleSaves.current.set(sessionId, saving);
    }
    void sendQuestion(sessionId, question, turnId);
  }

  function addWaitingMessage(sessionId: string, messageId: string, turnId: string) {
    const message: Message = {
      id: messageId,
      role: 'assistant',
      text: '',
      locale,
      waiting: true,
      turnId,
    };
    updateSession(sessionId, (session) => ({
      ...session,
      messages: [...session.messages, message],
    }));
    markEntering(messageId);
  }

  function applyStreamText(sessionId: string, messageId: string, chunk: string) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message) => {
        if (message.id !== messageId) {
          return message;
        }
        const text = message.text + chunk;
        return {...message, text, waiting: visibleText(message.role, text) === ''};
      }),
    }));
  }

  function applyPartialText(sessionId: string, turnId: string, partial: PartialReply) {
    if (turnId === '') {
      return;
    }
    updateSession(sessionId, (session) => {
      const index = session.messages.findIndex((message) => message.turnId === turnId);
      if (index === -1) {
        // 这一轮还没进到页面里（比如刚刷新完），先补一个气泡。
        const message: Message = {
          id: turnId,
          role: 'assistant',
          text: partial.text,
          locale,
          turnId,
          waiting: partial.status === 'streaming',
        };
        return {...session, messages: [...session.messages, message]};
      }
      const message = session.messages[index];
      if (!partial.text.startsWith(message.text)) {
        return session;
      }
      const waiting =
        partial.status === 'streaming' && visibleText(message.role, partial.text) === '';
      const messages = [...session.messages];
      messages[index] = {...message, text: partial.text, waiting};
      return {...session, messages};
    });
  }

  /** 把这一轮的回答气泡去掉，提问留着。 */
  function removeTurnAnswer(sessionId: string, turnId: string) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.filter(
        (message) => !(message.turnId === turnId && message.role === 'assistant'),
      ),
    }));
  }

  /** 把这一轮的提问和气泡一起去掉（这一轮根本没发出去）。 */
  function removeTurn(sessionId: string, turnId: string) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.filter((message) => message.turnId !== turnId),
    }));
  }

  /** 把这一轮的错误提示去掉（重发之前）。 */
  function removeFailedNotice(sessionId: string, turnId: string) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.filter(
        (message) => !(message.turnId === turnId && message.role === 'error'),
      ),
    }));
  }

  /**
   * 重发一轮：把失败的回答换成重新答一遍同一句提问。
   *
   * 提问留在原处，失败的回答和它的提示去掉。新的回答算新的一轮，
   * 服务器会把上一轮在上游留下的记录删掉，历史里不会出现两遍问答。
   */
  async function retryTurn(sessionId: string, turnId: string) {
    if (sendingRef.current.has(sessionId)) {
      return;
    }
    const question = questionOfTurn(sessionId, turnId);
    if (question === null || question.trim() === '') {
      setNotice(text.actionFailed);
      return;
    }
    removeTurnAnswer(sessionId, turnId);
    removeFailedNotice(sessionId, turnId);
    const newTurnId = crypto.randomUUID();
    sendingRef.current.add(sessionId);
    setPendingIds((current) => new Set(current).add(sessionId));
    setNotice(null);
    clearSessionWarning(sessionId);
    await sendQuestion(sessionId, question, newTurnId, turnId);
  }

  /**
   * 某一轮问的是什么。
   *
   * 提问那条不一定带这一轮的编号：刷新以后看到的提问是上游的记录，
   * 上游不知道我们的编号。那就按位置找 —— 失败提示前面最近的一条提问。
   */
  function questionOfTurn(sessionId: string, turnId: string): string | null {
    const messages = sessionsRef.current.find((item) => item.id === sessionId)?.messages ?? [];
    const notice = messages.findIndex(
      (message) => message.role === 'error' && message.turnId === turnId,
    );
    for (let index = notice - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') {
        return messages[index].text;
      }
    }
    const own = messages.find((message) => message.role === 'user' && message.turnId === turnId);
    return own?.text ?? null;
  }

  /**
   * 聊天记录里的错误提示。带着这一轮的编号时，用户可以重发这一轮。
   */
  function addErrorMessage(
    sessionId: string,
    content: string,
    messageLocale: Locale,
    turnId?: string,
  ) {
    const message: Message = {
      id: crypto.randomUUID(),
      role: 'error',
      text: content,
      locale: messageLocale,
      turnId,
    };
    updateSession(sessionId, (session) => ({
      ...session,
      messages: [...session.messages, message],
    }));
    markEntering(message.id);
  }

  function clearPending(sessionId: string) {
    setPendingIds((current) => {
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }

  /** 新的一轮开始了：上一轮的提示（比如「对话已停止」）不再占着位置。 */
  function clearSessionWarning(sessionId: string) {
    setSessionWarning((current) => (current?.sessionId === sessionId ? null : current));
  }

  function stopPolling(sessionId: string) {
    const stop = pollers.current.get(sessionId);
    if (stop === undefined) {
      return;
    }
    stop();
    pollers.current.delete(sessionId);
  }

  function startPolling(sessionId: string, turnId: string) {
    stopPolling(sessionId);
    const stop = startPartialPolling(
      sessionId,
      (partial) => {
        applyPartialText(sessionId, turnId, partial);
        if (partial.status === 'streaming') {
          return;
        }
        stopPolling(sessionId);
        clearPending(sessionId);
        if (partial.status === 'failed') {
          addErrorMessage(sessionId, text.replyInterrupted, locale, turnId);
        }
        if (partial.status === 'aborted') {
          setSessionWarning({sessionId, text: text.replyStopped});
        }
      },
      () => {
        // 会话没了（404）或会话过期（401）：轮询到此为止，输入框解锁。
        // 过期的事不用在这里说：下一个动作（发送、重命名……）自然会
        // 带着去重新登录。
        stopPolling(sessionId);
        clearPending(sessionId);
      },
    );
    pollers.current.set(sessionId, stop);
  }

  function resumePartial(sessionId: string, messages: Message[]) {
    const waiting = messages.find((message) => message.waiting === true);
    if (waiting === undefined) {
      return;
    }
    setPendingIds((current) => new Set(current).add(sessionId));
    startPolling(sessionId, waiting.turnId ?? '');
  }

  async function recoverReply(sessionId: string, turnId: string) {
    let partial: PartialReply;
    try {
      partial = await readPartial(sessionId);
    } catch {
      // 问不到服务器：不知道这一轮到底怎么样，只能报连不上。
      removeTurnAnswer(sessionId, turnId);
      addErrorMessage(sessionId, text.connectionError, locale);
      return;
    }
    if (partial.turnId !== null && partial.turnId !== turnId) {
      // Redis 里留着的是别的轮次，这一轮其实没写出来。
      removeTurnAnswer(sessionId, turnId);
      addErrorMessage(sessionId, text.connectionError, locale);
      return;
    }
    if (partial.status === 'streaming') {
      applyPartialText(sessionId, turnId, partial);
      startPolling(sessionId, turnId);
      return;
    }
    if (partial.status === 'failed') {
      applyPartialText(sessionId, turnId, partial);
      addErrorMessage(sessionId, text.replyInterrupted, locale, turnId);
      return;
    }
    if (partial.status === 'aborted') {
      applyPartialText(sessionId, turnId, partial);
      setSessionWarning({sessionId, text: text.replyStopped});
      return;
    }
    if (partial.status === 'finished') {
      if (partial.turnId === null && partial.text.trim() === lastAssistantText(sessionId)?.trim()) {
        // Redis 里没有编号，只能靠文字分辨：留着的是上一轮的收尾，这一轮其实没开始。
        removeTurnAnswer(sessionId, turnId);
        addErrorMessage(sessionId, text.connectionError, locale);
        return;
      }
      applyPartialText(sessionId, turnId, partial);
      return;
    }
    // 这一轮根本没写出来（上游还没接上就断了）：提示照样给，
    // 也照样能重发 —— 这一轮在上游没有留下什么，重发就是重新问一遍。
    removeTurnAnswer(sessionId, turnId);
    addErrorMessage(sessionId, text.replyInterrupted, locale, turnId);
  }

  /** 这一场会话里最后一条助手回答，用来分辨 Redis 里那份是上一轮留下的还是这一轮的。 */
  function lastAssistantText(sessionId: string): string | null {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    const messages = session?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'assistant') {
        return message.text;
      }
    }
    return null;
  }

  async function sendQuestion(
    sessionId: string,
    question: string,
    turnId: string,
    retryOf?: string,
  ) {
    const assistantId = crypto.randomUUID();
    const controller = new AbortController();
    aborters.current.set(sessionId, {controller, turnId});
    let received = '';
    try {
      addWaitingMessage(sessionId, assistantId, turnId);
      const outcome = await streamReply(
        sessionId,
        question,
        locale,
        turnId,
        (chunk) => {
          received += chunk;
          applyStreamText(sessionId, assistantId, chunk);
        },
        controller.signal,
        retryOf,
      );
      if (outcome === 'busy') {
        // 这场会话已经有一轮在写，这一次没发出去。把问题放回输入框，等答完再发。
        removeTurn(sessionId, turnId);
        setDraft(question);
        saveUnsent(question);
        setSessionWarning({sessionId, text: text.roundBusy});
        await refreshThread(sessionId);
        return;
      }
      if (outcome === 'aborted') {
        // 用户按了停止。停止流程负责收尾：它去问服务器这一轮到底怎么样，
        // 页面上说的话要跟服务器一致。
        const stop = stoppers.current.get(sessionId);
        if (stop) {
          await stop;
          return;
        }
        if (received.trim() === '') {
          removeTurnAnswer(sessionId, turnId);
        }
        setSessionWarning({sessionId, text: text.replyStopped});
        return;
      }
      if (outcome === 'interrupted') {
        await recoverReply(sessionId, turnId);
        return;
      }
      if (outcome === 'not-started') {
        removeTurnAnswer(sessionId, turnId);
        addErrorMessage(sessionId, text.connectionError, locale);
      }
    } catch (error) {
      removeTurnAnswer(sessionId, turnId);
      if (error instanceof ApiError && error.status === 401) {
        // 发送时被踢：发送前草稿已经清了，这句提问存起来，
        // 登录后放回输入框。
        saveUnsent(question);
        enterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        showConnectionWarning();
        return;
      }
      const detail = error instanceof ApiError ? error.detail : null;
      addErrorMessage(sessionId, detail ?? text.connectionError, detail ? 'zh-CN' : locale, turnId);
    } finally {
      aborters.current.delete(sessionId);
      stoppers.current.delete(sessionId);
      sendingRef.current.delete(sessionId);
      if (!pollers.current.has(sessionId)) {
        clearPending(sessionId);
      }
    }
  }

  /** 重新读一次线程：这一轮是在别的页面发出去的，本页还不知道。 */
  async function refreshThread(sessionId: string) {
    try {
      const thread = await loadThread(sessionId, locale);
      updateSession(sessionId, (session) => ({
        ...session,
        messages: thread.messages,
        messagesKnown: true,
      }));
      if (thread.partial.status === 'streaming') {
        resumePartial(sessionId, thread.messages);
      }
    } catch {
      // 读不到就算了，页面照常用。
    }
  }

  /**
   * 用户按了停止之后的收尾。
   *
   * 先让服务器记下停止（服务器写停止标记，再取消正在跑的任务），
   * 再问服务器这一轮到底怎么样：服务器说还在写就接着等，
   * 说停了就显示「对话已停止」。页面不自己宣布停了。
   */
  async function finishStop(sessionId: string, turnId: string) {
    try {
      await abortReply(sessionId, turnId);
    } catch {
      // 服务器那边收不到也不碍事：页面已经不等这一轮了。
    }

    let partial: PartialReply | null = null;
    try {
      partial = await readPartial(sessionId);
    } catch {
      partial = null;
    }

    if (partial === null || (partial.turnId !== null && partial.turnId !== turnId)) {
      // 问不到服务器，或者 Redis 里留着的是别的轮次：按停掉了处理。
      removeTurnAnswer(sessionId, turnId);
      setSessionWarning({sessionId, text: text.replyStopped});
      return;
    }
    if (partial.status === 'streaming') {
      // 服务器那边还在写：接着等，别骗用户说停了。
      startPolling(sessionId, turnId);
      setSessionWarning({sessionId, text: text.replyStopFailed});
      return;
    }
    if (partial.status === 'failed') {
      applyPartialText(sessionId, turnId, partial);
      addErrorMessage(sessionId, text.replyInterrupted, locale, turnId);
      return;
    }
    if (partial.status === 'finished') {
      // 回答其实已经写完了：把答案补上，不显示「对话已停止」。
      applyPartialText(sessionId, turnId, partial);
      return;
    }
    // aborted，或者这一轮根本没开始。
    if (partial.text.trim() === '') {
      removeTurnAnswer(sessionId, turnId);
    }
    setSessionWarning({sessionId, text: text.replyStopped});
  }

  async function stopSending(sessionId: string) {
    const entry = aborters.current.get(sessionId);
    const turnId = entry?.turnId ?? '';
    const operation = finishStop(sessionId, turnId);
    stoppers.current.set(sessionId, operation);
    // 本地先断开：页面不等这一轮了。服务器那边由 finishStop 去说。
    entry?.controller.abort();
    await operation;
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

  // 修改密码是独立的一页，不是弹窗：没有背景可误点，密码输一半不会丢。
  // 地址是 /password，刷新和后退都是页面的行为，不是弹窗的。
  if (location.pathname === '/password') {
    return (
      <ChangePasswordPage
        locale={locale}
        username={username}
        error={changePasswordError}
        busy={changePasswordBusy}
        onSubmit={(oldPassword, newPassword, confirmPassword) =>
          submitChangePassword(oldPassword, newPassword, confirmPassword)
        }
        onCancel={() => {
          setChangePasswordError(null);
          if (passwordEntry.current === 'push') {
            // 入口压过一条历史：取消就是后退，路径效果会把视图跟着地址带回去。
            void navigate(-1);
            return;
          }
          // 直接以 /password 打开（刷新、贴地址），历史里没有可退的：
          // 就地把路径换掉回聊天。
          setView('chat');
          void navigate(activeIdRef.current === null ? '/' : `/chat/${activeIdRef.current}`, {
            replace: true,
          });
        }}
      />
    );
  }

  // 已登录却站在 /login、或站在即将被兼容效果归位的地址（裸 /chat、未知路径）：
  // 效果马上会把地址送去该去的地方，先放个占位，别闪一帧聊天框。
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
        onRename={(id, title) => renameOpenSession(id, title)}
        onDelete={(id) => removeSession(id)}
        onPin={(id, pinned) => {
          void pinOpenSession(id, pinned);
        }}
        onOpenSettings={() => {
          setConfirmLogout(false);
          setProfileError(null);
          setView('profile');
        }}
      />
      <ChatMain
        locale={locale}
        sidebarOpen={sidebarOpen}
        onShowSidebar={() => {
          openSidebar();
        }}
        active={active}
        warnings={warnings}
        enteringIds={enteringIds}
        onAnimationEnd={(id) => {
          setEnteringIds((current) => current.filter((item) => item !== id));
        }}
        pending={activePending}
        draft={draft}
        inputLocked={inputLocked}
        sendLocked={inputLocked || historyLocked}
        onDraft={setDraft}
        onSubmit={submitMessage}
        onStop={() => {
          if (active) {
            void stopSending(active.id);
          }
        }}
        onRetry={(turnId) => {
          if (active) {
            void retryTurn(active.id, turnId);
          }
        }}
      />
      <SettingsModal
        locale={locale}
        open={view === 'profile'}
        username={username}
        avatarUrl={avatarUrl}
        avatarBusy={savingAvatar}
        hasCustomAvatar={avatarUrl !== null && !avatarUrl.startsWith(defaultAvatarUrl)}
        error={confirmLogout ? null : profileError}
        saving={savingLocale}
        onLocale={(next) => {
          void changeLocale(next);
        }}
        onAvatarPick={(file) => {
          void pickAvatar(file);
        }}
        onChangePassword={() => {
          setChangePasswordError(null);
          // 真页面：地址变成 /password，压一条历史，浏览器后退就能回来。
          passwordEntry.current = 'push';
          void navigate('/password');
        }}
        onLogout={() => setConfirmLogout(true)}
        onClose={() => {
          setConfirmLogout(false);
          setProfileError(null);
          setView('chat');
        }}
      />
      <ConfirmLogout
        locale={locale}
        open={confirmLogout}
        error={profileError}
        loggingOut={loggingOut}
        onCancel={() => {
          setProfileError(null);
          setConfirmLogout(false);
        }}
        onConfirm={() => {
          void signOut();
        }}
      />
      <Toast
        message={toast?.text ?? null}
        lang={toast?.lang ?? htmlLang[locale]}
        onDismiss={() => {
          setToast(null);
        }}
      />
    </div>
  );
}
