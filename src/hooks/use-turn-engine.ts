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
  // 会话 id → 上游工作流最新节点名：等待气泡里显示；第一个内容增量到达、
  // 这一轮结束（所有结局）时清掉。
  const [progressBySession, setProgressBySession] = useState<Record<string, string>>({});
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
  // pending 会话集合的镜像：断线补查的监听器注册一次，要能读到最新的一份。
  const pendingIdsRef = useRef(pendingIds);
  useEffect(() => {
    depsRef.current = deps;
    textRef.current = translations[deps.locale];
    pendingIdsRef.current = pendingIds;
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
    void loadThread(sessionId)
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

  // 网络回来 / 页面回到可见：还在等回答的会话可能在断线期间有了进展，
  // 挨个补查一次线程（refreshThread 里带着续传逻辑）。
  useEffect(() => {
    function catchUp() {
      for (const sessionId of pendingIdsRef.current) {
        if (sendingRef.current.has(sessionId)) {
          // 这场会话正由本页流式回答：让流自己收尾，别在这儿换掉消息列表。
          continue;
        }
        void refreshThread(sessionId);
      }
    }
    function onVisibilityChange() {
      if (!document.hidden) {
        catchUp();
      }
    }
    window.addEventListener('online', catchUp);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', catchUp);
      document.removeEventListener('visibilitychange', onVisibilityChange);
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

  function applyPartialText(
    sessionId: string,
    turnId: string,
    partial: PartialReply,
    fallbackKey: string = '',
  ) {
    if (turnId === '' && fallbackKey === '') {
      return;
    }
    depsRef.current.updateSession(sessionId, (session) => {
      let index = session.messages.findIndex((message) => message.turnId === turnId);
      if (index === -1 && fallbackKey !== '') {
        // 按轮次编号找不到气泡：拿消息 id 兜底，只认还在等待中的那条。
        index = session.messages.findIndex(
          (message) => message.id === fallbackKey && message.waiting === true,
        );
      }
      if (index === -1) {
        if (turnId === '') {
          // 没有轮次编号、兜底也没找到：不补气泡，等下一拍。
          return session;
        }
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

  /**
   * 把这一轮的回答标成失败/被停：脚注里的常驻状态提示和重试按钮由消息
   * 自身的标志驱动（docs/MESSAGE_ACTIONS.md），实时流程里就打标，不只靠
   * 刷新后的服务器标志。waiting 一并清掉，零文字的轮次不再显示三个点；
   * 气泡不去掉——没有文字时只渲染脚注。
   */
  function markTurnStatus(sessionId: string, turnId: string, status: 'failed' | 'aborted') {
    if (turnId === '') {
      return;
    }
    const mark = status === 'failed' ? {failed: true} : {aborted: true};
    depsRef.current.updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message) =>
        message.turnId === turnId && message.role === 'assistant'
          ? {...message, waiting: false, ...mark}
          : message,
      ),
    }));
  }

  /**
   * 重发一轮：重新答一遍同一句提问（重试），或者用改过的文字重新问一遍
   * （编辑重发，docs/MESSAGE_ACTIONS.md 第三期）。
   *
   * 提问留在原处，旧的回答（连同脚注里的状态提示）去掉。新的回答算新的一轮，
   * 服务器会把上一轮在上游留下的记录删掉，历史里不会出现两遍问答。
   *
   * 传了 editedText 就是编辑重发：提问气泡的文字就地换成新的。发送没有成功
   * （409 繁忙、请求没落地、后端没接下）时按 Gemini 的做法整轮回滚：新文字
   * 回输入框（busy 路径的 setDraft 负责），提问恢复原文，被去掉的回答连同
   * 状态提示恢复——动手改界面之前先把这一轮快照下来。请求已经落地的（流
   * 中途断了）不回滚：服务器那边旧轮已经删了，回滚反而是骗人。
   */
  async function retryTurn(sessionId: string, turnId: string, editedText?: string) {
    if (sendingRef.current.has(sessionId)) {
      return;
    }
    const question = editedText ?? questionOfTurn(sessionId, turnId);
    if (question === null || question.trim() === '') {
      depsRef.current.setNotice(textRef.current.actionFailed);
      return;
    }
    const messages = depsRef.current.sessions.find((item) => item.id === sessionId)?.messages ?? [];
    const indexStart = messages.findIndex((message) => message.turnId === turnId);
    const snapshot = messages.filter((message) => message.turnId === turnId);
    if (editedText !== undefined) {
      depsRef.current.updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.role === 'user' && message.turnId === turnId
            ? {...message, text: editedText}
            : message,
        ),
      }));
    }
    removeTurnAnswer(sessionId, turnId);
    const newTurnId = crypto.randomUUID();
    sendingRef.current.add(sessionId);
    setPendingIds((current) => new Set(current).add(sessionId));
    depsRef.current.setNotice(null);
    clearSessionWarning(sessionId);
    await sendQuestion(sessionId, question, newTurnId, turnId, () => {
      restoreTurn(sessionId, turnId, indexStart, snapshot);
    });
  }

  /** 发送没成功：把这一轮恢复成重发之前的样子（提问文字、回答、状态标志都在内）。 */
  function restoreTurn(sessionId: string, turnId: string, indexStart: number, snapshot: Message[]) {
    if (snapshot.length === 0) {
      return;
    }
    depsRef.current.updateSession(sessionId, (session) => {
      const existing = session.messages.findIndex((message) => message.turnId === turnId);
      const without = session.messages.filter((message) => message.turnId !== turnId);
      const at = Math.min(existing === -1 ? indexStart : existing, without.length);
      return {
        ...session,
        messages: [...without.slice(0, at), ...snapshot, ...without.slice(at)],
      };
    });
  }

  /**
   * 某一轮问的是什么。
   *
   * 先按轮次编号认提问那条。提问不一定带这一轮的编号：刷新以后看到的
   * 提问是上游的记录，上游不知道我们的编号。那就按位置找 —— 这一轮的
   * 回答前面最近的一条提问。
   */
  function questionOfTurn(sessionId: string, turnId: string): string | null {
    const messages = depsRef.current.sessions.find((item) => item.id === sessionId)?.messages ?? [];
    const own = messages.find((message) => message.role === 'user' && message.turnId === turnId);
    if (own !== undefined) {
      return own.text;
    }
    const answer = messages.findIndex(
      (message) => message.role === 'assistant' && message.turnId === turnId,
    );
    for (let index = answer - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') {
        return messages[index].text;
      }
    }
    return null;
  }

  /** 记下这场会话最新的进度节点名（等待气泡里显示）。 */
  function setSessionProgress(sessionId: string, name: string) {
    setProgressBySession((current) => ({...current, [sessionId]: name}));
  }

  /** 清掉这场会话的进度文本：本来就没有时返回同一份引用，不触发重渲染。 */
  function clearProgress(sessionId: string) {
    setProgressBySession((current) => {
      if (current[sessionId] === undefined) {
        return current;
      }
      const next = {...current};
      delete next[sessionId];
      return next;
    });
  }

  function clearPending(sessionId: string) {
    setPendingIds((current) => {
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }

  /** 新的一轮开始了：上一轮的横幅（比如「这场对话还有一条正在回答」）不再占着位置。 */
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

  function startPolling(sessionId: string, turnId: string, fallbackKey: string = '') {
    stopPolling(sessionId);
    const stop = startPartialPolling(
      sessionId,
      (partial) => {
        applyPartialText(sessionId, turnId, partial, fallbackKey);
        if (partial.status === 'streaming') {
          return;
        }
        stopPolling(sessionId);
        clearPending(sessionId);
        if (partial.status === 'failed') {
          markTurnStatus(sessionId, turnId, 'failed');
        }
        if (partial.status === 'aborted') {
          markTurnStatus(sessionId, turnId, 'aborted');
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
    const turnId = waiting.turnId ?? '';
    // 等待的气泡上没挂轮次编号（比如是刷新线程带回来的）：拿消息 id 当兜底定位键。
    startPolling(sessionId, turnId, turnId === '' ? waiting.id : '');
  }

  async function recoverReply(sessionId: string, turnId: string) {
    let partial: PartialReply;
    try {
      partial = await readPartial(sessionId);
    } catch {
      // 问不到服务器：不知道这一轮到底怎么样，只能报连不上（归横幅）。
      removeTurnAnswer(sessionId, turnId);
      depsRef.current.setNotice(textRef.current.connectionError);
      return;
    }
    if (partial.turnId !== null && partial.turnId !== turnId) {
      // Redis 里留着的是别的轮次，这一轮其实没写出来。归横幅。
      removeTurnAnswer(sessionId, turnId);
      depsRef.current.setNotice(textRef.current.connectionError);
      return;
    }
    if (partial.status === 'streaming') {
      applyPartialText(sessionId, turnId, partial);
      startPolling(sessionId, turnId);
      return;
    }
    if (partial.status === 'failed') {
      applyPartialText(sessionId, turnId, partial);
      markTurnStatus(sessionId, turnId, 'failed');
      return;
    }
    if (partial.status === 'aborted') {
      applyPartialText(sessionId, turnId, partial);
      markTurnStatus(sessionId, turnId, 'aborted');
      return;
    }
    if (partial.status === 'finished') {
      if (partial.turnId === null && partial.text.trim() === lastAssistantText(sessionId)?.trim()) {
        // Redis 里没有编号，只能靠文字分辨：留着的是上一轮的收尾，这一轮其实没开始。归横幅。
        removeTurnAnswer(sessionId, turnId);
        depsRef.current.setNotice(textRef.current.connectionError);
        return;
      }
      applyPartialText(sessionId, turnId, partial);
      return;
    }
    // 这一轮根本没写出来（上游还没接上就断了）：标成失败，照样能重发 ——
    // 这一轮在上游没有留下什么，重发就是重新问一遍。零文字的回答气泡留着
    // （只渲染脚注），提示落在用户提问下方。
    markTurnStatus(sessionId, turnId, 'failed');
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
    onRollback?: () => void,
  ) {
    const assistantId = crypto.randomUUID();
    const controller = new AbortController();
    aborters.current.set(sessionId, {controller, turnId});
    try {
      addWaitingMessage(sessionId, assistantId, turnId);
      const outcome = await streamReply(
        sessionId,
        question,
        depsRef.current.locale,
        turnId,
        (chunk) => {
          // 第一个内容增量到达：进度文本完成使命（清空是幂等的，
          // 后续增量拿到同一份引用，不再触发重渲染）。
          clearProgress(sessionId);
          applyStreamText(sessionId, assistantId, chunk);
        },
        controller.signal,
        retryOf,
        (name) => {
          setSessionProgress(sessionId, name);
        },
      );
      // 流结束（五种结局都一样）：进度文本不再有意义。
      clearProgress(sessionId);
      if (outcome === 'busy') {
        // 这场会话已经有一轮在写，这一次没发出去。把问题放回输入框，等答完再发。
        removeTurn(sessionId, turnId);
        depsRef.current.setDraft(question);
        saveUnsent(question);
        setSessionWarning({sessionId, text: textRef.current.roundBusy});
        await refreshThread(sessionId);
        // 重发（重试/编辑重发）没发出去：把旧轮放回来。refreshThread 一般已经
        // 从服务器带回旧轮，这里是读线程失败时的兜底；恢复本身是幂等的。
        onRollback?.();
        return;
      }
      if (outcome === 'aborted') {
        // 用户按了停止。停止流程负责收尾：它去问服务器这一轮到底怎么样，
        // 页面上打的标记要跟服务器一致。
        const stop = stoppers.current.get(sessionId);
        if (stop) {
          await stop;
          return;
        }
        // 没有收尾流程可等（理论上不会发生）：就地把这一轮标成被停。
        markTurnStatus(sessionId, turnId, 'aborted');
        return;
      }
      if (outcome === 'interrupted') {
        await recoverReply(sessionId, turnId);
        return;
      }
      if (outcome === 'not-started') {
        // 请求没落地，服务器上没有这一轮：空的气泡去掉，连不上归横幅报，
        // 重发的旧轮放回原样。
        removeTurnAnswer(sessionId, turnId);
        depsRef.current.setNotice(textRef.current.connectionError);
        onRollback?.();
      }
    } catch (error) {
      removeTurnAnswer(sessionId, turnId);
      // 发送没成功：重发的旧轮放回原样（请求几乎可以肯定没落地；万一落了，
      // 下一次读线程会用服务器的版本盖掉）。
      onRollback?.();
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
      // 后端没接下（ApiError 带 detail）或别的异常：归横幅报，不再往消息流里插错误消息。
      const detail = error instanceof ApiError ? error.detail : null;
      depsRef.current.setNotice(detail ?? textRef.current.connectionError);
    } finally {
      aborters.current.delete(sessionId);
      stoppers.current.delete(sessionId);
      sendingRef.current.delete(sessionId);
      clearProgress(sessionId);
      if (!pollers.current.has(sessionId)) {
        clearPending(sessionId);
      }
    }
  }

  /** 重新读一次线程：这一轮是在别的页面发出去的，本页还不知道。 */
  async function refreshThread(sessionId: string) {
    try {
      const thread = await loadThread(sessionId);
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
   * 再问服务器这一轮到底怎么样：服务器说还在写就接着等，说停了就把
   * 这一轮的回答标成 aborted（气泡下方的脚注显示「对话已停止」）。
   * 页面不自己宣布停了。
   */
  async function finishStop(sessionId: string, turnId: string, fallbackKey: string = '') {
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
      // 问不到服务器，或者 Redis 里留着的是别的轮次：按停掉了处理，
      // 把这一轮的回答标成 aborted（零文字也留着，只渲染脚注）。
      markTurnStatus(sessionId, turnId, 'aborted');
      return;
    }
    if (partial.status === 'streaming') {
      // 服务器那边还在写：接着等，别骗用户说停了。
      startPolling(sessionId, turnId, fallbackKey);
      setSessionWarning({sessionId, text: textRef.current.replyStopFailed});
      return;
    }
    if (partial.status === 'failed') {
      applyPartialText(sessionId, turnId, partial, fallbackKey);
      markTurnStatus(sessionId, turnId, 'failed');
      return;
    }
    if (partial.status === 'finished') {
      // 回答其实已经写完了：把答案补上，不显示「对话已停止」。
      applyPartialText(sessionId, turnId, partial, fallbackKey);
      return;
    }
    // aborted，或者这一轮根本没开始：把这一轮的回答标成 aborted，
    // 零文字也留着气泡（只渲染脚注），不再进横幅。
    markTurnStatus(sessionId, turnId, 'aborted');
  }

  /** 等待中的气泡没有轮次编号时，拿它的消息 id 当轮询的兜底定位键；否则给空串。 */
  function fallbackKeyOf(sessionId: string): string {
    const messages = depsRef.current.sessions.find((item) => item.id === sessionId)?.messages ?? [];
    const waiting = messages.find((message) => message.waiting === true);
    if (waiting === undefined || (waiting.turnId ?? '') !== '') {
      return '';
    }
    return waiting.id;
  }

  async function stopSending(sessionId: string) {
    const entry = aborters.current.get(sessionId);
    const turnId = entry?.turnId ?? '';
    const operation = finishStop(sessionId, turnId, fallbackKeyOf(sessionId));
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
    setProgressBySession({});
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
    progressBySession,
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
