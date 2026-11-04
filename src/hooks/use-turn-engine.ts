import {useEffect, useRef, useState} from 'react';
import {streamReply} from '../api/chat.ts';
import {connectionFailure, explain} from '../api/failure.ts';
import {ApiError} from '../api/http.ts';
import {readPartial} from '../api/partial.ts';
import type {PartialReply} from '../api/partial.ts';
import {abortReply} from '../api/session.ts';
import {translations} from '../i18n.ts';
import {startPartialPolling} from '../session/poll.ts';
import {visibleText} from '../session/text.ts';
import {loadThread} from '../session/thread.ts';
import {saveUnsent} from '../session/unsent.ts';
import type {Message, Session} from '../type/chat.ts';
import type {Locale} from '../type/locale.ts';

type TurnEngineDeps = {
  locale: Locale;
  auth: 'checking' | 'anonymous' | 'ready';
  activeId: string | null;
  composingNew: boolean;
  sessions: Session[];
  setSessions: (updater: (current: Session[]) => Session[]) => void;
  updateSession: (sessionId: string, change: (session: Session) => Session) => void;
  markEntering: (id: string) => void;
  setNotice: (notice: string | null) => void;
  setDraft: (draft: string) => void;
  onEnterLogin: (detail: string | null) => void;
  onConnectionWarning: () => void;
};

/**
 * 流式回答引擎：发送一轮问答、把流式文本应用到气泡、停止、重试、续传，
 * 以及线程加载（切到还没加载历史的会话时拉记录）和在飞状态登记
 * （pending 标记、加载标记、aborter/poller 注册表）。
 *
 * 依赖放进 ref、在效果里镜像：流式回答是跨渲染的长异步流程，回调和
 * 会话列表都要拿最新的一份；渲染期间写 ref 是被禁止的（react/refs）。
 */
export function useTurnEngine(deps: TurnEngineDeps) {
  const {auth, activeId, composingNew} = deps;
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [sessionWarning, setSessionWarning] = useState<{sessionId: string; text: string} | null>(
    null,
  );
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [threadRetry, setThreadRetry] = useState(0);
  const sendingRef = useRef<Set<string>>(new Set());
  const aborters = useRef(new Map<string, {controller: AbortController; turnId: string}>());
  const stoppers = useRef(new Map<string, Promise<void>>());
  const pollers = useRef(new Map<string, () => void>());
  const loadedThreads = useRef(new Set<string>());
  const threadFlight = useRef(new Set<string>());
  const depsRef = useRef(deps);
  const textRef = useRef(translations[deps.locale]);
  useEffect(() => {
    depsRef.current = deps;
    textRef.current = translations[deps.locale];
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
    const existing = depsRef.current.sessions.find((session) => session.id === sessionId);
    if (existing && existing.messages.length > 0) {
      loadedThreads.current.add(sessionId);
      return;
    }
    let cancelled = false;
    flights.add(sessionId);
    setHistoryLoadingId(sessionId);
    void loadThread(sessionId, depsRef.current.locale)
      .then((thread) => {
        if (cancelled) {
          return;
        }
        loadedThreads.current.add(sessionId);
        depsRef.current.setSessions((current) =>
          current.map((session) => {
            if (session.id !== sessionId || session.messages.length > 0) {
              return session;
            }
            return {...session, messages: thread.messages, messagesKnown: true};
          }),
        );
        if (thread.partial.status === 'streaming') {
          resumePartial(sessionId, thread.messages);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          depsRef.current.onEnterLogin(error.detail);
          return;
        }
        if (connectionFailure(error)) {
          depsRef.current.onConnectionWarning();
          return;
        }
        depsRef.current.setNotice(
          explain(error, translations[depsRef.current.locale].connectionError),
        );
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
    const active = pollers.current;
    return () => {
      for (const stop of active.values()) {
        stop();
      }
      active.clear();
    };
  }, []);

  function addWaitingMessage(sessionId: string, messageId: string, turnId: string) {
    const message: Message = {
      id: messageId,
      role: 'assistant',
      text: '',
      locale: depsRef.current.locale,
      waiting: true,
      turnId,
    };
    depsRef.current.updateSession(sessionId, (session) => ({
      ...session,
      messages: [...session.messages, message],
    }));
    depsRef.current.markEntering(messageId);
  }

  function applyStreamText(sessionId: string, messageId: string, chunk: string) {
    depsRef.current.updateSession(sessionId, (session) => ({
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
    depsRef.current.updateSession(sessionId, (session) => {
      const index = session.messages.findIndex((message) => message.turnId === turnId);
      if (index === -1) {
        // 这一轮还没进到页面里（比如刚刷新完），先补一个气泡。
        const message: Message = {
          id: turnId,
          role: 'assistant',
          text: partial.text,
          locale: depsRef.current.locale,
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
    depsRef.current.updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.filter(
        (message) => !(message.turnId === turnId && message.role === 'assistant'),
      ),
    }));
  }

  /** 把这一轮的提问和气泡一起去掉（这一轮根本没发出去）。 */
  function removeTurn(sessionId: string, turnId: string) {
    depsRef.current.updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.filter((message) => message.turnId !== turnId),
    }));
  }

  /** 把这一轮的错误提示去掉（重发之前）。 */
  function removeFailedNotice(sessionId: string, turnId: string) {
    depsRef.current.updateSession(sessionId, (session) => ({
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
      depsRef.current.setNotice(textRef.current.actionFailed);
      return;
    }
    removeTurnAnswer(sessionId, turnId);
    removeFailedNotice(sessionId, turnId);
    const newTurnId = crypto.randomUUID();
    sendingRef.current.add(sessionId);
    setPendingIds((current) => new Set(current).add(sessionId));
    depsRef.current.setNotice(null);
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
    const messages = depsRef.current.sessions.find((item) => item.id === sessionId)?.messages ?? [];
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
    depsRef.current.updateSession(sessionId, (session) => ({
      ...session,
      messages: [...session.messages, message],
    }));
    depsRef.current.markEntering(message.id);
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
          addErrorMessage(
            sessionId,
            textRef.current.replyInterrupted,
            depsRef.current.locale,
            turnId,
          );
        }
        if (partial.status === 'aborted') {
          setSessionWarning({sessionId, text: textRef.current.replyStopped});
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
      addErrorMessage(sessionId, textRef.current.connectionError, depsRef.current.locale);
      return;
    }
    if (partial.turnId !== null && partial.turnId !== turnId) {
      // Redis 里留着的是别的轮次，这一轮其实没写出来。
      removeTurnAnswer(sessionId, turnId);
      addErrorMessage(sessionId, textRef.current.connectionError, depsRef.current.locale);
      return;
    }
    if (partial.status === 'streaming') {
      applyPartialText(sessionId, turnId, partial);
      startPolling(sessionId, turnId);
      return;
    }
    if (partial.status === 'failed') {
      applyPartialText(sessionId, turnId, partial);
      addErrorMessage(sessionId, textRef.current.replyInterrupted, depsRef.current.locale, turnId);
      return;
    }
    if (partial.status === 'aborted') {
      applyPartialText(sessionId, turnId, partial);
      setSessionWarning({sessionId, text: textRef.current.replyStopped});
      return;
    }
    if (partial.status === 'finished') {
      if (partial.turnId === null && partial.text.trim() === lastAssistantText(sessionId)?.trim()) {
        // Redis 里没有编号，只能靠文字分辨：留着的是上一轮的收尾，这一轮其实没开始。
        removeTurnAnswer(sessionId, turnId);
        addErrorMessage(sessionId, textRef.current.connectionError, depsRef.current.locale);
        return;
      }
      applyPartialText(sessionId, turnId, partial);
      return;
    }
    // 这一轮根本没写出来（上游还没接上就断了）：提示照样给，
    // 也照样能重发 —— 这一轮在上游没有留下什么，重发就是重新问一遍。
    removeTurnAnswer(sessionId, turnId);
    addErrorMessage(sessionId, textRef.current.replyInterrupted, depsRef.current.locale, turnId);
  }

  /** 这一场会话里最后一条助手回答，用来分辨 Redis 里那份是上一轮留下的还是这一轮的。 */
  function lastAssistantText(sessionId: string): string | null {
    const session = depsRef.current.sessions.find((item) => item.id === sessionId);
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
        depsRef.current.locale,
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
        depsRef.current.setDraft(question);
        saveUnsent(question);
        setSessionWarning({sessionId, text: textRef.current.roundBusy});
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
        setSessionWarning({sessionId, text: textRef.current.replyStopped});
        return;
      }
      if (outcome === 'interrupted') {
        await recoverReply(sessionId, turnId);
        return;
      }
      if (outcome === 'not-started') {
        removeTurnAnswer(sessionId, turnId);
        addErrorMessage(sessionId, textRef.current.connectionError, depsRef.current.locale);
      }
    } catch (error) {
      removeTurnAnswer(sessionId, turnId);
      if (error instanceof ApiError && error.status === 401) {
        // 发送时被踢：发送前草稿已经清了，这句提问存起来，
        // 登录后放回输入框。
        saveUnsent(question);
        depsRef.current.onEnterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        depsRef.current.onConnectionWarning();
        return;
      }
      const detail = error instanceof ApiError ? error.detail : null;
      addErrorMessage(
        sessionId,
        detail ?? textRef.current.connectionError,
        detail ? 'zh-CN' : depsRef.current.locale,
        turnId,
      );
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
      const thread = await loadThread(sessionId, depsRef.current.locale);
      depsRef.current.updateSession(sessionId, (session) => ({
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
      setSessionWarning({sessionId, text: textRef.current.replyStopped});
      return;
    }
    if (partial.status === 'streaming') {
      // 服务器那边还在写：接着等，别骗用户说停了。
      startPolling(sessionId, turnId);
      setSessionWarning({sessionId, text: textRef.current.replyStopFailed});
      return;
    }
    if (partial.status === 'failed') {
      applyPartialText(sessionId, turnId, partial);
      addErrorMessage(sessionId, textRef.current.replyInterrupted, depsRef.current.locale, turnId);
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
    setSessionWarning({sessionId, text: textRef.current.replyStopped});
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

  function markThreadLoaded(sessionId: string) {
    loadedThreads.current.add(sessionId);
  }

  /** 这个会话的线程既没加载过、也没有在飞的加载：由调用方决定要不要触发重载。 */
  function shouldReloadThread(sessionId: string): boolean {
    return !loadedThreads.current.has(sessionId) && !threadFlight.current.has(sessionId);
  }

  function bumpThreadRetry() {
    setThreadRetry((current) => current + 1);
  }

  /** 退出登录/被踢回登录页：把在飞的加载、轮询和等待标记一次清干净。 */
  function resetForLogin() {
    setPendingIds(new Set());
    setHistoryLoadingId(null);
    loadedThreads.current.clear();
    threadFlight.current.clear();
    for (const stop of pollers.current.values()) {
      stop();
    }
    pollers.current.clear();
    setSessionWarning(null);
  }

  return {
    pendingIds,
    setPendingIds,
    sessionWarning,
    setSessionWarning,
    historyLoadingId,
    sendingRef,
    sendQuestion,
    stopSending,
    retryTurn,
    clearPending,
    clearSessionWarning,
    stopPolling,
    markThreadLoaded,
    shouldReloadThread,
    bumpThreadRetry,
    resetForLogin,
  };
}
