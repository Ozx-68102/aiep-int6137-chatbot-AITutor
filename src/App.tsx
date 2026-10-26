import {type SubmitEvent, useEffect, useRef, useState} from 'react';
import {useNarrowScreen} from './hooks/use-narrow-screen.ts';
import {streamReply} from './api/chat.ts';
import {connectionFailure, explain} from './api/failure.ts';
import {ApiError} from './api/http.ts';
import {logout, readProfile, updateProfile} from './api/profile.ts';
import type {Profile} from './api/profile.ts';
import {createSession, emptySession, listSessions, login, sessionsFromList} from './api/session.ts';
import type {LoginResult} from './api/session.ts';
import {ChatMain} from './components/chat/ChatMain.tsx';
import {LoginScreen} from './components/login/LoginScreen.tsx';
import {ConfirmLogout} from './components/settings/ConfirmLogout.tsx';
import {SettingsModal} from './components/settings/SettingsModal.tsx';
import {chatFrameClass} from './components/shell/frame-class.ts';
import {Sidebar} from './components/sidebar/Sidebar.tsx';
import {translations} from './i18n.ts';
import {isEmptySession} from './session/empty.ts';
import type {Message, Session} from './type/chat.ts';
import {htmlLang, isLocale, localeFromSystem, type Locale} from './type/locale.ts';

export default function App() {
  const [locale, setLocale] = useState<Locale>(localeFromSystem);
  const [auth, setAuth] = useState<'checking' | 'anonymous' | 'ready'>('checking');
  const [loginOffline, setLoginOffline] = useState(false);
  const [loginDetail, setLoginDetail] = useState<string | null>(null);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia('(max-width: 767px)').matches);
  const narrow = useNarrowScreen(() => setSidebarOpen(false));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'profile'>('chat');
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [savingLocale, setSavingLocale] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [enteringIds, setEnteringIds] = useState<string[]>([]);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const creatingRef = useRef(false);
  const sendingRef = useRef<Set<string>>(new Set());
  const text = translations[locale];
  const loginError = loginOffline ? text.connectionError : loginDetail;
  const active = sessions.find((session) => session.id === activeId);
  const activePending = active ? pendingIds.has(active.id) : false;
  const composerLocked = !active || !active.messagesKnown || activePending;

  useEffect(() => {
    document.documentElement.lang = htmlLang[locale];
    document.title = 'H^2 Bot';
  }, [locale]);

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
        const next = sessionsFromList(items);
        setSessions(next);
        setActiveId(next[0]?.id ?? null);
        if (profile) {
          setUsername(profile.username);
          setLocale(profile.locale);
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
          setLoginOffline(true);
          setLoginDetail(null);
        } else {
          setLoginOffline(false);
          setLoginDetail(explain(error, translations[localeFromSystem()].connectionError));
        }
        setAuth('anonymous');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  function enterLogin(detail: string | null) {
    setAuth('anonymous');
    setSessions([]);
    setActiveId(null);
    setDraft('');
    setNotice(null);
    setUsername(null);
    setView('chat');
    setConfirmLogout(false);
    setProfileError(null);
    setPendingIds(new Set());
    setLoginOffline(false);
    setLoginDetail(detail);
    setLoginSubmitting(false);
  }

  function updateSession(sessionId: string, change: (session: Session) => Session) {
    setSessions((current) => current.map((session) => (session.id === sessionId ? change(session) : session)));
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
    try {
      const result = await login(usernameValue, password);
      openAccount(result);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setLoginDetail(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        setLoginOffline(true);
        return;
      }
      setLoginDetail(explain(error, text.connectionError));
    } finally {
      setLoginSubmitting(false);
    }
  }

  function openAccount(result: LoginResult) {
    const next = sessionsFromList(result.sessions);
    if (isLocale(result.locale)) {
      setLocale(result.locale);
    }
    setSessions(next);
    setActiveId(next[0]?.id ?? null);
    setDraft('');
    setNotice(null);
    setView('chat');
    setAuth('ready');
    void readProfile().then((profile) => {
      setUsername(profile.username);
      setLocale(profile.locale);
    }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
      }
    });
  }

  function openSession(id: string) {
    setActiveId(id);
    setNotice(null);
    setView('chat');
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
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return;
      }
      setProfileError(explain(error, text.connectionError));
    } finally {
      setSavingLocale(false);
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
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(null);
        return;
      }
      setProfileError(explain(error, text.connectionError));
    } finally {
      setLoggingOut(false);
    }
  }

  async function addSession() {
    if (creatingRef.current || sessions.some(isEmptySession)) {
      return;
    }
    creatingRef.current = true;
    setNotice(null);
    try {
      const session = emptySession(await createSession());
      setSessions((current) => [session, ...current]);
      setActiveId(session.id);
      setDraft('');
      setView('chat');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return;
      }
      setNotice(explain(error, text.connectionError));
    } finally {
      creatingRef.current = false;
    }
  }

  function submitMessage(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || !active || !active.messagesKnown || sendingRef.current.has(active.id)) {
      return;
    }
    const sessionId = active.id;
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      text: question,
      locale,
    };
    sendingRef.current.add(sessionId);
    setPendingIds((current) => new Set(current).add(sessionId));
    setNotice(null);
    setDraft('');
    updateSession(sessionId, (session) => ({
      ...session,
      title: session.title ?? question,
      titleLocale: session.titleLocale ?? locale,
      messages: [...session.messages, userMessage],
    }));
    markEntering(userMessage.id);
    void sendQuestion(sessionId, question);
  }

  async function sendQuestion(sessionId: string, question: string) {
    try {
      let assistantId: string | null = null;
      await streamReply(sessionId, question, locale, (chunk) => {
        if (assistantId === null) {
          assistantId = crypto.randomUUID();
          const messageId = assistantId;
          updateSession(sessionId, (session) => ({
            ...session,
            messages: [
              ...session.messages,
              {id: messageId, role: 'assistant', text: chunk, locale},
            ],
          }));
          markEntering(messageId);
          return;
        }
        const messageId = assistantId;
        updateSession(sessionId, (session) => ({
          ...session,
          messages: session.messages.map((message) => (
            message.id === messageId ? {...message, text: message.text + chunk} : message
          )),
        }));
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return;
      }
      const detail = error instanceof ApiError ? error.detail : null;
      const errorMessage: Message = {
        id: crypto.randomUUID(),
        role: 'error',
        text: detail ?? text.connectionError,
        locale: detail ? 'zh-CN' : locale,
      };
      updateSession(sessionId, (session) => ({
        ...session,
        messages: [...session.messages, errorMessage],
      }));
      markEntering(errorMessage.id);
    } finally {
      sendingRef.current.delete(sessionId);
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }

  if (auth === 'checking') {
    return <div className="h-full bg-stone-100"/>;
  }

  if (auth === 'anonymous') {
    return (
      <LoginScreen
        locale={locale}
        error={loginError}
        offline={loginOffline}
        submitting={loginSubmitting}
        onLocale={setLocale}
        onSubmit={(usernameValue, password) => {
          void submitLogin(usernameValue, password);
        }}
      />
    );
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
        onCreate={() => {
          void addSession();
        }}
        onClose={() => setSidebarOpen(false)}
        onOpenSession={openSession}
        onOpenSettings={() => {
          setConfirmLogout(false);
          setProfileError(null);
          setView('profile');
        }}
      />
      <ChatMain
        locale={locale}
        sidebarOpen={sidebarOpen}
        onShowSidebar={() => setSidebarOpen(true)}
        active={active}
        notice={notice}
        enteringIds={enteringIds}
        onAnimationEnd={(id) => {
          setEnteringIds((current) => current.filter((item) => item !== id));
        }}
        pending={activePending}
        draft={draft}
        composerLocked={composerLocked}
        onDraft={setDraft}
        onSubmit={submitMessage}
      />
      {view === 'profile' ? (
        <SettingsModal
          locale={locale}
          username={username}
          error={confirmLogout ? null : profileError}
          saving={savingLocale}
          onLocale={(next) => {
            void changeLocale(next);
          }}
          onLogout={() => setConfirmLogout(true)}
          onClose={() => {
            setConfirmLogout(false);
            setProfileError(null);
            setView('chat');
          }}
        />
      ) : null}
      {confirmLogout ? (
        <ConfirmLogout
          locale={locale}
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
      ) : null}
    </div>
  );
}
