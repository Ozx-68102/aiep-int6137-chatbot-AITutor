import {type SubmitEvent, useEffect, useRef, useState} from 'react';
import {useNarrowScreen} from './hooks/use-narrow-screen.ts';
import {usePasswordChange} from './hooks/use-password-change.ts';
import {chatIdFromPath, usePathRouting} from './hooks/use-path-routing.ts';
import {useProfileActions} from './hooks/use-profile-actions.ts';
import {useSessionActions} from './hooks/use-session-actions.ts';
import {serviceNoticeText, useServiceStatus} from './hooks/use-service-status.ts';
import {useTurnEngine} from './hooks/use-turn-engine.ts';
import {connectionFailure, explain} from './api/failure.ts';
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
import {PageBoundary} from './components/shell/PageBoundary.tsx';
import {Sidebar} from './components/sidebar/Sidebar.tsx';
import {Toast} from './components/toast/Toast.tsx';
import {translations} from './i18n.ts';
import {clearCachedProfile, readCachedProfile, saveCachedProfile} from './session/profile-cache.ts';
import type {CachedProfile} from './session/profile-cache.ts';
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
  const [username, setUsername] = useState<string | null>(() => cachedProfile?.username ?? null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'profile'>('chat');
  const [composingNew, setComposingNew] = useState(false);
  const [sendingNew, setSendingNew] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<{id: number; text: string; lang: string} | null>(null);
  const draftRef = useRef(draft);
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
  });
  const routingRef = useRef(routing);
  const service = useServiceStatus({
    auth,
    setSessions,
    setUsername,
    setLocale,
    setAvatarUrl,
    onClaimPath: (list) => routingRef.current.claimPath(list),
    onEnterLogin: enterLogin,
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
    setDraft,
    onEnterLogin: enterLogin,
    onConnectionWarning: service.showConnectionWarning,
  });
  const engineRef = useRef(engine);
  const password = usePasswordChange({
    locale,
    onPasswordChanged: () => setLoginNotice(text.passwordChanged),
    onEnterLogin: enterLogin,
    onConnectionWarning: service.showConnectionWarning,
  });
  const passwordRef = useRef(password);
  const profileApi = useProfileActions({
    locale,
    setLocale,
    setUsername,
    setAvatarUrl,
    onEnterLogin: enterLogin,
    onConnectionWarning: service.showConnectionWarning,
  });
  const profileApiRef = useRef(profileApi);
  const sessionActions = useSessionActions({
    locale,
    activeId,
    setSessions,
    setNotice,
    onShowToast: showToast,
    onEnterLogin: enterLogin,
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
  const inputLocked = sendingNew || activePending;
  const historyLocked = engine.historyLoadingId === active?.id && active.messages.length === 0;
  // 会话级的提示都在输入区分隔线上方的警示框里（聊天滚动区与输入区之间的流内节点），只有一种样子。
  const warnings: WarningItem[] = [];
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
          serviceRef.current.markService('unreachable');
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
    profileApiRef.current.setProfileError(null);
    passwordRef.current.setError(null);
    sessionActionsRef.current.titleSaves.current.clear();
    engineRef.current.resetForLogin();
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
    routingRef.current.claimPath(next);
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
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(null);
        return;
      }
      if (connectionFailure(error)) {
        service.showConnectionWarning();
        return;
      }
      profileApi.setProfileError(explain(error, text.connectionError));
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
        enterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        service.showConnectionWarning();
        return;
      }
      if (sessionId === '') {
        setNotice(explain(error, text.connectionError));
      }
    } finally {
      setSendingNew(false);
      if (sessionId !== '') {
        engine.sendingRef.current.delete(sessionId);
        engine.setPendingIds((current) => {
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
    if (!question || sendingNew || (active && engine.sendingRef.current.has(active.id))) {
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
        draft={draft}
        inputLocked={inputLocked}
        sendLocked={inputLocked || historyLocked}
        onDraft={setDraft}
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
