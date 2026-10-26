import {Languages, PanelLeftClose, PanelLeftOpen, Send, SquarePlus} from 'lucide-react';
import {type SubmitEvent, useEffect, useRef, useState} from 'react';
import logoUrl from './assets/H-Squared_Bot_Vector.svg';
import {streamReply} from './api/chat.ts';
import {ApiError} from './api/http.ts';
import {createSession, emptySession, listSessions, login, sessionsFromList} from './api/session.ts';
import type {LoginResult} from './api/session.ts';
import {locales, translations} from './i18n.ts';
import type {Message, Session} from './type/chat.ts';
import {isLocale, localeFromSystem, type Locale} from './type/locale.ts';

const htmlLang: Record<Locale, string> = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  'en': 'en',
};

function isEmptySession(session: Session): boolean {
  return session.messagesKnown && session.messages.length === 0;
}

function sessionTitle(session: Session, fallback: string): string {
  return session.title ?? fallback;
}

function explain(error: unknown, connection: string): string {
  if (error instanceof ApiError && error.detail) {
    return error.detail;
  }
  return connection;
}

function connectionFailure(error: unknown): boolean {
  return !(error instanceof ApiError) || error.detail === null;
}

function bubbleClass(role: Message['role'], entering: boolean): string {
  if (role === 'user') {
    return entering
      ? 'mb-3 ml-auto max-w-xl animate-in rounded-xl bg-emerald-900 px-3.5 py-2.5 whitespace-pre-wrap text-white fade-in slide-in-from-bottom-2 duration-200'
      : 'mb-3 ml-auto max-w-xl rounded-xl bg-emerald-900 px-3.5 py-2.5 whitespace-pre-wrap text-white';
  }
  if (role === 'error') {
    return entering
      ? 'mb-3 max-w-xl animate-in rounded-xl border border-stone-300 bg-stone-50 px-3.5 py-2.5 whitespace-pre-wrap text-red-600 fade-in slide-in-from-bottom-2 duration-200'
      : 'mb-3 max-w-xl rounded-xl border border-stone-300 bg-stone-50 px-3.5 py-2.5 whitespace-pre-wrap text-red-600';
  }
  return entering
    ? 'mb-3 max-w-xl animate-in rounded-xl bg-stone-100 px-3.5 py-2.5 whitespace-pre-wrap fade-in slide-in-from-bottom-2 duration-200'
    : 'mb-3 max-w-xl rounded-xl bg-stone-100 px-3.5 py-2.5 whitespace-pre-wrap';
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(localeFromSystem);
  const [auth, setAuth] = useState<'checking' | 'anonymous' | 'ready'>('checking');
  const [loginOffline, setLoginOffline] = useState(false);
  const [loginDetail, setLoginDetail] = useState<string | null>(null);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
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
      (items) => {
        if (cancelled) {
          return;
        }
        const next = sessionsFromList(items);
        setSessions(next);
        setActiveId(next[0]?.id ?? null);
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

  async function submitLogin(username: string, password: string) {
    if (loginOffline) {
      return;
    }
    setLoginSubmitting(true);
    setLoginOffline(false);
    setLoginDetail(null);
    try {
      const result = await login(username, password);
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
    setLocale(isLocale(result.locale) ? result.locale : localeFromSystem());
    setSessions(next);
    setActiveId(next[0]?.id ?? null);
    setDraft('');
    setNotice(null);
    setAuth('ready');
  }

  function openSession(id: string) {
    setActiveId(id);
    setNotice(null);
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
        onSubmit={(username, password) => {
          void submitLogin(username, password);
        }}
      />
    );
  }

  return (
    <div
      className={
        sidebarOpen
          ? 'grid h-full grid-cols-[20rem_minmax(0,1fr)] transition-[grid-template-columns] duration-200 ease-out'
          : 'grid h-full grid-cols-[0_minmax(0,1fr)] transition-[grid-template-columns] duration-200 ease-out'
      }
    >
      <aside
        className={
          sidebarOpen
            ? 'flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden border-r border-stone-300 bg-stone-200 p-3'
            : 'flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden border-r-0 bg-stone-200 px-0 py-3'
        }
        aria-label={text.sessions}
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen}
      >
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              className="shrink-0 cursor-pointer border-0 bg-transparent p-0"
              aria-label={text.createSession}
              title={text.createSession}
              onClick={() => {
                void addSession();
              }}
            >
              <img src={logoUrl} alt="" className="h-12 w-auto"/>
            </button>
            <p lang="en" className="min-w-0 text-xs leading-tight text-stone-600">
              Help × Higher Understanding
            </p>
          </div>
          <button
            type="button"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit"
            aria-label={text.hideSidebar}
            title={text.hideSidebar}
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose aria-hidden="true"/>
          </button>
        </div>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 text-left"
          onClick={() => {
            void addSession();
          }}
        >
          <SquarePlus aria-hidden="true" className="size-4 shrink-0"/>
          {text.createSession}
        </button>
        <ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-0">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className={
                  session.id === active?.id
                    ? 'mb-1 w-full truncate rounded-lg border border-emerald-900 bg-emerald-50 px-3 py-2 text-left'
                    : 'mb-1 w-full truncate rounded-lg border border-transparent bg-transparent px-3 py-2 text-left'
                }
                lang={session.titleLocale ? htmlLang[session.titleLocale] : undefined}
                aria-current={session.id === active?.id ? 'true' : undefined}
                onClick={() => openSession(session.id)}
              >
                {sessionTitle(session, text.newChat)}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-col bg-white">
        <header className="flex items-center justify-between gap-2 border-b border-stone-300 px-4 py-3">
          {sidebarOpen ? null : (
            <button
              type="button"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit"
              aria-label={text.showSidebar}
              title={text.showSidebar}
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen aria-hidden="true"/>
            </button>
          )}
          <h1
            lang={active?.titleLocale ? htmlLang[active.titleLocale] : undefined}
            className="m-0 min-w-0 flex-1 truncate text-lg"
          >
            {active ? sessionTitle(active, text.newChat) : text.newChat}
          </h1>
          <LanguageMenu locale={locale} onChange={setLocale}/>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4" aria-live="polite" aria-busy={activePending}>
          {notice ? (
            <p
              className="mb-3 text-red-600"
              role="alert"
              lang={notice === text.connectionError ? htmlLang[locale] : 'zh-Hans'}
            >
              {notice}
            </p>
          ) : null}
          {active && active.messages.length > 0 ? (
            active.messages.map((message) => (
              <p
                key={message.id}
                lang={message.locale ? htmlLang[message.locale] : undefined}
                className={bubbleClass(message.role, enteringIds.includes(message.id))}
                onAnimationEnd={() => {
                  setEnteringIds((current) => current.filter((id) => id !== message.id));
                }}
              >
                {message.text}
              </p>
            ))
          ) : null}
          {active && active.messagesKnown && active.messages.length === 0 ? (
            <p className="m-0 text-stone-500">{text.empty}</p>
          ) : null}
        </div>
        <form className="flex items-center gap-2 border-t border-stone-300 px-4 pt-3 pb-4" onSubmit={submitMessage}>
          <input
            className={
              composerLocked
                ? 'min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2.5 opacity-50'
                : 'min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2.5'
            }
            value={draft}
            placeholder={text.placeholder}
            aria-label={text.placeholder}
            disabled={composerLocked}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className={
              composerLocked || draft.trim() === ''
                ? 'inline-flex size-9 shrink-0 cursor-default items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit opacity-50'
                : 'inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-emerald-900 bg-emerald-900 text-white'
            }
            aria-label={text.send}
            title={text.send}
            disabled={composerLocked || draft.trim() === ''}
          >
            <Send aria-hidden="true"/>
          </button>
        </form>
      </main>
    </div>
  );
}

function LanguageMenu({locale, onChange}: {locale: Locale; onChange: (locale: Locale) => void}) {
  const text = translations[locale];
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="relative ml-auto shrink-0" ref={menuRef}>
      <button
        type="button"
        className="inline-flex size-9 items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit"
        aria-label={text.language}
        aria-expanded={open}
        aria-haspopup="menu"
        title={text.language}
        onClick={() => setOpen((current) => !current)}
      >
        <Languages aria-hidden="true"/>
      </button>
      <div
        className={
          open
            ? 'absolute top-[calc(100%+0.35rem)] right-0 z-10 flex min-w-36 animate-in flex-col rounded-lg border border-stone-300 bg-white p-1.5 fade-in slide-in-from-top-2 duration-200'
            : 'absolute top-[calc(100%+0.35rem)] right-0 z-10 hidden'
        }
        role="menu"
        aria-label={text.language}
        aria-hidden={!open}
        inert={!open}
      >
        {locales.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            lang={htmlLang[item.id]}
            className={
              item.id === locale
                ? 'rounded-md border border-emerald-900 bg-emerald-50 px-2.5 py-1.5 text-left'
                : 'rounded-md border border-transparent bg-transparent px-2.5 py-1.5 text-left'
            }
            aria-checked={item.id === locale}
            onClick={() => {
              onChange(item.id);
              setOpen(false);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function LoginScreen({
  locale,
  error,
  offline,
  submitting,
  onLocale,
  onSubmit,
}: {
  locale: Locale;
  error: string | null;
  offline: boolean;
  submitting: boolean;
  onLocale: (locale: Locale) => void;
  onSubmit: (username: string, password: string) => void;
}) {
  const text = translations[locale];
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const blocked = offline || submitting || username.trim() === '' || password === '';

  return (
    <main className="flex h-full items-center justify-center bg-stone-100 px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-stone-300 bg-white p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (blocked) {
            return;
          }
          onSubmit(username.trim(), password);
        }}
      >
        <div className="flex items-center gap-2">
          <img src={logoUrl} alt="" className="h-12 w-auto"/>
          <p lang="en" className="min-w-0 text-xs leading-tight text-stone-600">
            Help × Higher Understanding
          </p>
          <LanguageMenu locale={locale} onChange={onLocale}/>
        </div>
        <h1 className="m-0 text-lg" lang={htmlLang[locale]}>{text.logIn}</h1>
        <label className="flex flex-col gap-1">
          {text.username}
          <input
            className="rounded-lg border border-stone-300 px-3 py-2.5"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          {text.password}
          <input
            className="rounded-lg border border-stone-300 px-3 py-2.5"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? (
          <p
            className="m-0 text-red-600"
            role="alert"
            lang={error === text.connectionError ? htmlLang[locale] : 'zh-Hans'}
          >
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className={
            blocked
              ? 'rounded-lg border border-stone-300 bg-white px-3 py-2.5 opacity-50'
              : 'rounded-lg border border-emerald-900 bg-emerald-900 px-3 py-2.5 text-white'
          }
          disabled={blocked}
        >
          {text.logIn}
        </button>
      </form>
    </main>
  );
}
