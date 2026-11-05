import {type SubmitEvent, useEffect, useRef, useState} from 'react';
import {narrowScreenNow, useNarrowScreen} from './hooks/use-narrow-screen.ts';
import {usePasswordChange} from './hooks/use-password-change.ts';
import {chatIdFromPath, usePathRouting} from './hooks/use-path-routing.ts';
import {useProfileActions} from './hooks/use-profile-actions.ts';
import {useSessionActions} from './hooks/use-session-actions.ts';
import {serviceNoticeText, useServiceStatus} from './hooks/use-service-status.ts';
import {useTurnEngine} from './hooks/use-turn-engine.ts';
import {connectionFailure, explain} from './api/failure.ts';
import {sendFeedback} from './api/feedback.ts';
import {ApiError} from './api/http.ts';
import {logout, readProfile} from './api/profile.ts';
import {defaultAvatarUrl, type Profile} from './api/profile.ts';
import {createSession, emptySession, listSessions, login, sessionsFromList} from './api/session.ts';
import type {LoginResult} from './api/session.ts';
import {AdminConsole} from './components/admin/AdminConsole.tsx';
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
import {Toast} from './components/toast/Toast.tsx';
import {translations} from './i18n/index.ts';
import {
  clearCachedProfile,
  readCachedAvatarData,
  readCachedProfile,
  saveCachedProfile,
} from './session/profile-cache.ts';
import type {CachedProfile} from './session/profile-cache.ts';
import {clearAllDrafts, clearDraft, readDraft, saveDraft} from './session/drafts.ts';
import {clearUnsent, readUnsent, saveUnsent} from './session/unsent.ts';
import {titleFromQuestion} from './session/title.ts';
import {BrowserRouter, Route, Routes, useLocation, useNavigate} from 'react-router';
import type {Message, Session} from './type/chat.ts';
import {htmlLang, isLocale, localeFromSystem, type Locale} from './type/locale.ts';

/**
 * 路由用真实路径：/admin 整页渲染管理员控制台，其余地址交给聊天侧
 * （ChatApp），由它再认 /、/chat/:id、/password 和 /login；不带 id 的
 * /chat 和未知路径一律归位到根路径。控制台是完全独立的一页——聊天侧
 * 的会话和用户信息引导流程一概不跑（ChatApp 压根不挂载）。
 */
export default function App() {
  return (
    <PageBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/admin" element={<AdminConsole />} />
          <Route path="/*" element={<ChatApp />} />
        </Routes>
      </BrowserRouter>
    </PageBoundary>
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
  // 离线启动：侧栏头像先用本地缓存顶上，不闪回默认图（P12 的侧栏半边）。
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() => readCachedAvatarData());
  const [view, setView] = useState<'chat' | 'profile'>('chat');
  const [composingNew, setComposingNew] = useState(false);
  const [sendingNew, setSendingNew] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  // 会话失效的原地态（docs/ACCOUNT_MANAGEMENT.md 会话状态通道的最小 HTTP 版）：
  // auth 保持 ready，聊天页原样保留、输入区禁用、输入区上方挂常驻警示条。
  // expired 可以就地重新登录（Modal 里弹 LoginScreen）；disabled 是终态，只给提示。
  const [sessionInvalid, setSessionInvalid] = useState<'expired' | 'disabled' | null>(null);
  const [reloginOpen, setReloginOpen] = useState(false);
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<{id: number; text: string; lang: string} | null>(null);
  const draftRef = useRef(draft);
  const sessionInvalidRef = useRef(sessionInvalid);
  // 异步回调和效果调用的函数统一从 ref 里拿 navigate：走 ref 就不会成为
  // 各个效果的响应式依赖。
  const navigateRef = useRef(navigate);
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
  // （响应式），一律走上面这几个 ref 拿最新的 API——和 navigateRef 同一套路。
  const serviceNotice = serviceNoticeText(service.serviceState, text);
  const active = sessions.find((session) => session.id === activeId);
  const activePending = active ? engine.pendingIds.has(active.id) : false;
  // 当前会话最新的进度节点名（没有进度时 undefined）：等待气泡里显示。
  const progressText = active ? engine.progressBySession[active.id] : undefined;
  const historyLocked = engine.historyLoadingId === active?.id && active.messages.length === 0;
  // 打字和发送分开解锁（N9）：流式回答期间不再锁键盘——想到追问可以先记下来；
  // 发送照旧等这一轮结束（sendLocked，输入框有字时给禁用的发送按钮＋提示）。
  // 首条消息建会话中（sendingNew）和会话失效原地态仍然锁输入。
  const inputLocked = sendingNew || sessionInvalid !== null;
  const sendLocked = inputLocked || activePending || historyLocked;
  // 会话级的提示都在输入区分隔线上方的警示框里（聊天滚动区与输入区之间的流内节点），只有一种样子。
  const warnings: WarningItem[] = [];
  if (sessionInvalid !== null) {
    // 会话失效的常驻警示条，不可关闭：expired 用琥珀的「有状况」语气（可以
    // 就地重新登录）；disabled 用红色出错语气（终态，登录也没用，不给按钮）。
    // 白底黑字，语义色只在图标上（docs/UI_WARNINGS.md）。
    warnings.push({
      id: 'session-invalid',
      tone: sessionInvalid === 'disabled' ? 'error' : 'warning',
      text: sessionInvalid === 'disabled' ? text.accountDisabled : text.sessionExpired,
      ...(sessionInvalid === 'expired'
        ? {
            action: {
              label: text.logInAgain,
              onClick: () => {
                setReloginOpen(true);
              },
            },
          }
        : {}),
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
    routingRef.current.resetPasswordEntry();
    setComposingNew(false);
    setConfirmLogout(false);
    setSessionInvalid(null);
    setReloginOpen(false);
    profileApiRef.current.setProfileError(null);
    passwordRef.current.setError(null);
    sessionActionsRef.current.titleSaves.current.clear();
    engineRef.current.resetForLogin();
    setLoginOffline(false);
    setLoginDetail(detail);
    setLoginSubmitting(false);
  }

  /**
   * 会话类 401 的统一入口（回合引擎、半截回答轮询和 App 自己的请求都走
   * 这里）：带着 reason（expired/disabled）就进原地的「会话失效」态——
   * 聊天页、会话列表、草稿、profile 缓存全部原样保留，只禁用输入区、挂
   * 常驻警示条；没有 reason（老后端）保守回退整页 enterLogin 路径。只在
   * auth 是 ready 时有意义：checking/anonymous 阶段的 401 照旧走整页登录屏。
   */
  function handleAuthError(error: ApiError) {
    if (error.reason === 'expired' || error.reason === 'disabled') {
      setSessionInvalid(error.reason);
      return;
    }
    enterLogin(error.detail);
  }

  /**
   * 其余动作（侧栏、设置、改密、服务状态恢复）的 401 出口还是 enterLogin：
   * 已经在会话失效原地态里时不再升级成整页清空——横幅已经挂着了，清空
   * 反而把原地态保住的东西弄丢。
   */
  function enterLoginGuarded(detail: string | null) {
    if (sessionInvalidRef.current !== null) {
      return;
    }
    enterLogin(detail);
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
    // 兜底清理：正常由 onAnimationEnd 移除；气泡在动画结束前就被删掉时
    // （重发去掉旧回答、发送没成功整轮回滚），onAnimationEnd 不会再来，
    // id 会一直漏在集合里。进场动画最长 300ms，500ms 后再清一次，幂等。
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
    if (isLocale(result.locale)) {
      setLocale(result.locale);
    }
    // 上一个登录态的在飞请求、轮询和「线程已加载」标记都作废：一次清掉。
    // 整页登录路径里 enterLogin 已经清过（幂等）；原地重登录靠这次清理
    // 加 bumpThreadRetry 让当前会话的历史重新拉——activeId 和 auth 都没变，
    // 线程加载效果只能靠 retry 计数重新触发。
    engineRef.current.resetForLogin();
    engineRef.current.bumpThreadRetry();
    setSessionInvalid(null);
    setReloginOpen(false);
    let next = sessionsFromList(result.sessions);
    setSessions(next);
    routingRef.current.claimPath(next);
    // 被踢时存下的那句话放回输入框；放回就消费掉，别带去再下一次登录。
    // 原地重登录时输入框里的字本来就留着，没有存句就不要动它。
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
   * flush」的时序坑。引擎的 busy 回填（setDraft）也走这里，回填的文字
   * 同样落进对应会话的草稿。
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
    // unsent 恢复优先于草稿：被踢、busy 回填存下的句子不能丢；
    // 没有存句才用新对话自己的草稿。
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
      // （退出时 401 是被踢，走上面 catch 的路，不清。）
      clearUnsent();
      // 各会话的草稿也在主动退出时清空：共用电脑不留半截字（对齐
      // clearCachedProfile 的隐私处理）。被踢不清——重登录后草稿原样恢复。
      clearAllDrafts();
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
        // 不然输入框被解锁，下一发会撞 409。
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
            // 入口压过一条历史：取消就是后退，路径效果会把视图跟着地址带回去。
            void navigate(-1);
            return;
          }
          // 直接以 /password 打开（刷新、贴地址），历史里没有可退的：
          // 就地把路径换掉回聊天。
          setView('chat');
          void navigate(activeId === null ? '/' : `/chat/${activeId}`, {
            replace: true,
          });
        }}
      />
    );
  }

  // 已登录却站在 /login、或站在即将被归位效果送走的地址（裸 /chat、未知路径）：
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
              // 点赞途中被踢：跟其他动作一样走统一的 401 入口。
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
          // 真页面：地址变成 /password，压一条历史，浏览器后退就能回来。
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
      {/* 会话过期后的就地重登录：Modal 里放 LoginScreen 同款卡片，不清聊天页的
          任何状态；登录失败弹窗不关，错误留在表单里；成功由 openAccount 就地
          恢复（刷新 profile 和会话列表）。disabled 不给（终态，登录也没用）。 */}
      <Modal
        open={sessionInvalid === 'expired' && reloginOpen}
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
        message={toast?.text ?? null}
        lang={toast?.lang ?? htmlLang[locale]}
        onDismiss={() => {
          setToast(null);
        }}
      />
    </div>
  );
}
