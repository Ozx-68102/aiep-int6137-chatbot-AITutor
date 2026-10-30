import {type SubmitEvent, useEffect, useRef, useState} from 'react';
import {useNarrowScreen} from './hooks/use-narrow-screen.ts';
import {streamReply} from './api/chat.ts';
import {connectionFailure, explain} from './api/failure.ts';
import {ApiError} from './api/http.ts';
import {readPartial} from './api/partial.ts';
import type {PartialReply} from './api/partial.ts';
import {readStatus} from './api/status.ts';
import {logout, readProfile, updateProfile} from './api/profile.ts';
import type {Profile} from './api/profile.ts';
import {
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
import {ChatMain} from './components/chat/ChatMain.tsx';
import {LoginScreen} from './components/login/LoginScreen.tsx';
import {ConfirmLogout} from './components/settings/ConfirmLogout.tsx';
import {SettingsModal} from './components/settings/SettingsModal.tsx';
import {chatFrameClass} from './components/shell/frame-class.ts';
import {Sidebar} from './components/sidebar/Sidebar.tsx';
import {ConnectionToast} from './components/toast/ConnectionToast.tsx';
import {translations} from './i18n.ts';
import {clearUnsent, readUnsent, saveUnsent} from './session/unsent.ts';
import {titleFromQuestion} from './session/title.ts';
import {loadThread} from './session/thread.ts';
import {startPartialPolling} from './session/poll.ts';
import {visibleText} from './session/text.ts';
import {pushSessionToUrl, readSessionFromUrl, replaceSessionToUrl} from './session/location.ts';
import type {Message, Session} from './type/chat.ts';
import {htmlLang, isLocale, localeFromSystem, type Locale} from './type/locale.ts';

const statusIntervalMs = 30000;

type ServiceState = 'ok' | 'unreachable' | 'database' | 'store';

function serviceNoticeText(
  state: ServiceState,
  copy: (typeof translations)[Locale],
): string | null {
  if (state === 'unreachable') {
    return copy.connectionError;
  }
  if (state === 'database') {
    return copy.serviceUnavailable;
  }
  if (state === 'store') {
    return copy.replyStoreUnavailable;
  }
  return null;
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(localeFromSystem);
  const [auth, setAuth] = useState<'checking' | 'anonymous' | 'ready'>('checking');
  const [loginOffline, setLoginOffline] = useState(false);
  const [loginDetail, setLoginDetail] = useState<string | null>(null);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia('(max-width: 767px)').matches,
  );
  const narrow = useNarrowScreen(() => setSidebarOpen(false));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'profile'>('chat');
  const [composingNew, setComposingNew] = useState(false);
  const [sendingNew, setSendingNew] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [savingLocale, setSavingLocale] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [enteringIds, setEnteringIds] = useState<string[]>([]);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<{id: number; text: string; lang: string} | null>(null);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [threadRetry, setThreadRetry] = useState(0);
  const [serviceState, setServiceState] = useState<ServiceState>('ok');
  const sendingRef = useRef<Set<string>>(new Set());
  const titleSaves = useRef(new Map<string, Promise<void>>());
  const pollers = useRef(new Map<string, () => void>());
  const sessionsRef = useRef(sessions);
  const draftRef = useRef(draft);
  const loadedThreads = useRef(new Set<string>());
  const threadFlight = useRef(new Set<string>());
  const connectionToastRef = useRef<() => void>(() => undefined);
  const connectionCopyRef = useRef('');
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
  const connectionToast =
    toast === null ? null : (
      <ConnectionToast
        key={toast.id}
        message={toast.text}
        lang={toast.lang}
        onDismiss={() => setToast(null)}
      />
    );

  useEffect(() => {
    document.documentElement.lang = htmlLang[locale];
    document.title = 'H^2 Bot';
  }, [locale]);

  useEffect(() => {
    sessionsRef.current = sessions;
    draftRef.current = draft;
    connectionToastRef.current = showConnectionToast;
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
    void loadThread(sessionId)
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
          connectionToastRef.current();
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
        applyUrlSession(next);
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
          const initial = localeFromSystem();
          setComposingNew(true);
          setToast({
            id: 1,
            text: translations[initial].connectionRetry,
            lang: htmlLang[initial],
          });
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
        if (status.reply_store === 'unavailable') {
          setServiceState('store');
        } else if (status.database === 'unavailable') {
          setServiceState('database');
        } else {
          setServiceState('ok');
        }
      } catch {
        if (!stopped) {
          setServiceState('unreachable');
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

  useEffect(() => {
    function onPopState() {
      const wanted = readSessionFromUrl();
      if (wanted === null) {
        showNewChat();
        return;
      }
      const found = sessionsRef.current.find((session) => session.id === wanted);
      if (found === undefined) {
        replaceSessionToUrl(null);
        showNewChat();
        return;
      }
      showSession(found.id);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const active = pollers.current;
    return () => {
      for (const stop of active.values()) {
        stop();
      }
      active.clear();
    };
  }, []);

  function applyUrlSession(list: Session[]): void {
    const wanted = readSessionFromUrl();
    if (wanted === null) {
      setComposingNew(true);
      setActiveId(null);
      return;
    }
    const found = list.find((session) => session.id === wanted);
    if (found === undefined) {
      replaceSessionToUrl(null);
      setComposingNew(true);
      setActiveId(null);
      return;
    }
    setComposingNew(false);
    setActiveId(found.id);
  }

  function showConnectionToast() {
    setToast((current) => ({
      id: (current?.id ?? 0) + 1,
      text: text.connectionRetry,
      lang: htmlLang[locale],
    }));
  }

  function enterLogin(detail: string | null) {
    setAuth('anonymous');
    setSessions([]);
    setActiveId(null);
    setDraft('');
    setNotice(null);
    setUsername(null);
    setView('chat');
    setComposingNew(false);
    setConfirmLogout(false);
    setProfileError(null);
    setPendingIds(new Set());
    setHistoryLoadingId(null);
    loadedThreads.current.clear();
    threadFlight.current.clear();
    titleSaves.current.clear();
    for (const stop of pollers.current.values()) {
      stop();
    }
    pollers.current.clear();
    setToast(null);
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
        showConnectionToast();
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
    applyUrlSession(next);
    setDraft('');
    setNotice(null);
    setView('chat');
    setAuth('ready');
    void readProfile()
      .then((profile) => {
        setUsername(profile.username);
        setLocale(profile.locale);
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
    pushSessionToUrl(id);
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
      if (connectionFailure(error)) {
        showConnectionToast();
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
      if (connectionFailure(error)) {
        showConnectionToast();
        return;
      }
      setProfileError(explain(error, text.connectionError));
    } finally {
      setLoggingOut(false);
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
        showConnectionToast();
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
        showConnectionToast();
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
        showConnectionToast();
        return false;
      }
      setNotice(explain(error, text.connectionError));
      return false;
    }
    setSessions((current) => current.filter((session) => session.id !== id));
    stopPolling(id);
    clearPending(id);
    if (!wasCurrent) {
      return true;
    }
    showNewChat();
    replaceSessionToUrl(null);
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
        showConnectionToast();
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
    pushSessionToUrl(null);
  }

  async function sendFirstMessage(question: string) {
    setSendingNew(true);
    setNotice(null);
    let sessionId = '';
    try {
      const title = titleFromQuestion(question);
      const created = emptySession(await createSession(title));
      sessionId = created.id;
      replaceSessionToUrl(created.id);
      loadedThreads.current.add(sessionId);
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        text: question,
        locale,
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
      await sendQuestion(sessionId, question);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        showConnectionToast();
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
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      text: question,
      locale,
    };
    sendingRef.current.add(sessionId);
    setPendingIds((current) => new Set(current).add(sessionId));
    setNotice(null);
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
    void sendQuestion(sessionId, question);
  }

  function addWaitingMessage(sessionId: string, messageId: string) {
    const message: Message = {id: messageId, role: 'assistant', text: '', locale, waiting: true};
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

  function applyPartialText(sessionId: string, messageId: string, partial: PartialReply) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message) => {
        if (message.id !== messageId) {
          return message;
        }
        if (!partial.text.startsWith(message.text)) {
          return message;
        }
        const waiting =
          partial.status === 'streaming' && visibleText(message.role, partial.text) === '';
        return {...message, text: partial.text, waiting};
      }),
    }));
  }

  function removeMessage(sessionId: string, messageId: string) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.filter((message) => message.id !== messageId),
    }));
  }

  function addErrorMessage(sessionId: string, content: string, messageLocale: Locale) {
    const message: Message = {
      id: crypto.randomUUID(),
      role: 'error',
      text: content,
      locale: messageLocale,
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

  function stopPolling(sessionId: string) {
    const stop = pollers.current.get(sessionId);
    if (stop === undefined) {
      return;
    }
    stop();
    pollers.current.delete(sessionId);
  }

  function startPolling(sessionId: string, messageId: string) {
    stopPolling(sessionId);
    const stop = startPartialPolling(sessionId, (partial) => {
      applyPartialText(sessionId, messageId, partial);
      if (partial.status === 'streaming') {
        return;
      }
      stopPolling(sessionId);
      clearPending(sessionId);
      if (partial.status === 'failed') {
        addErrorMessage(sessionId, text.replyInterrupted, locale);
      }
    });
    pollers.current.set(sessionId, stop);
  }

  function resumePartial(sessionId: string, messages: Message[]) {
    const waiting = messages.find((message) => message.waiting === true);
    if (waiting === undefined) {
      return;
    }
    setPendingIds((current) => new Set(current).add(sessionId));
    startPolling(sessionId, waiting.id);
  }

  async function recoverReply(sessionId: string, messageId: string) {
    let partial: PartialReply;
    try {
      partial = await readPartial(sessionId);
    } catch {
      // 问不到服务器：不知道这一轮到底怎么样，只能报连不上。
      removeMessage(sessionId, messageId);
      addErrorMessage(sessionId, text.connectionError, locale);
      return;
    }
    if (partial.status === 'streaming') {
      applyPartialText(sessionId, messageId, partial);
      startPolling(sessionId, messageId);
      return;
    }
    if (partial.status === 'failed') {
      applyPartialText(sessionId, messageId, partial);
      addErrorMessage(sessionId, text.replyInterrupted, locale);
      return;
    }
    if (partial.status === 'finished') {
      if (partial.text.trim() === lastAssistantText(sessionId)?.trim()) {
        // Redis 里留着的是上一轮的收尾，这一轮其实没开始。
        removeMessage(sessionId, messageId);
        addErrorMessage(sessionId, text.connectionError, locale);
        return;
      }
      applyPartialText(sessionId, messageId, partial);
      return;
    }
    removeMessage(sessionId, messageId);
    addErrorMessage(sessionId, text.replyInterrupted, locale);
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

  async function sendQuestion(sessionId: string, question: string) {
    const assistantId = crypto.randomUUID();
    try {
      addWaitingMessage(sessionId, assistantId);
      const outcome = await streamReply(sessionId, question, locale, (chunk) => {
        applyStreamText(sessionId, assistantId, chunk);
      });
      if (outcome === 'interrupted') {
        await recoverReply(sessionId, assistantId);
        return;
      }
      if (outcome === 'not-started') {
        removeMessage(sessionId, assistantId);
        addErrorMessage(sessionId, text.connectionError, locale);
      }
    } catch (error) {
      removeMessage(sessionId, assistantId);
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        showConnectionToast();
        return;
      }
      const detail = error instanceof ApiError ? error.detail : null;
      addErrorMessage(sessionId, detail ?? text.connectionError, detail ? 'zh-CN' : locale);
    } finally {
      sendingRef.current.delete(sessionId);
      if (!pollers.current.has(sessionId)) {
        clearPending(sessionId);
      }
    }
  }

  if (auth === 'checking') {
    return (
      <>
        <div className="h-full bg-stone-100" />
        {connectionToast}
      </>
    );
  }

  if (auth === 'anonymous') {
    return (
      <>
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
        {connectionToast}
      </>
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
        onCreate={addSession}
        onClose={() => setSidebarOpen(false)}
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
        onShowSidebar={() => setSidebarOpen(true)}
        active={active}
        notice={notice}
        serviceNotice={serviceNotice}
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
      {connectionToast}
    </div>
  );
}
