import {useEffect, useRef, useState} from 'react';
import {streamReply} from '../api/chat.ts';
import {connectionFailure, explain} from '../api/failure.ts';
import {ApiError} from '../api/http.ts';
import {probePartial} from '../api/partial.ts';
import type {PartialReply} from '../api/partial.ts';
import {abortReply} from '../api/session.ts';
import {translations} from '../i18n/index.ts';
import {networkOkEvent, startPartialPolling} from '../session/poll.ts';
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
  /** 会话类 401 的统一出口：ApiError 透传给 App 层（带 reason 进入留在原页面的过期状态，不带回退整页登录）。 */
  onAuthError: (error: ApiError) => void;
  onConnectionWarning: () => void;
};

/**
 * 流式回答引擎：发送一轮问答、把流式文本应用到气泡、停止、重试、续传，
 * 以及线程加载（切到还没加载历史的会话时拉取记录）和进行中状态登记
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
  // 要「打字机播放」的消息 id 集合：本轮流的第一个内容增量到达时登记
  // （见 sendQuestion 的 onDelta），播放组件放完自己把 id 移出登记；轮次以中止/断流/
  // 发送失败收场时由引擎移出登记——播放组件的 present 变 false，立刻全部显示。
  // 播放只是视觉层，动画状态不进 sessions。
  const [presentIds, setPresentIds] = useState<Set<string>>(() => new Set());
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [threadRetry, setThreadRetry] = useState(0);
  const sendingRef = useRef<Set<string>>(new Set());
  const aborters = useRef(new Map<string, {controller: AbortController; turnId: string}>());
  const stoppers = useRef(new Map<string, Promise<void>>());
  // 登录世代编号：resetForLogin 每次把它加一。跨 await 的流程出发时记下当时的
  // 编号，回来写任何状态之前先核对编号没变；变了说明中间退出或重新登录过，
  // 这段流程整个放弃，旧登录态的在途请求就不会把结果写进新登录的会话里。
  // 与 use-service-status 里确认循环用的世代编号是两个各自独立的计数。
  const loginGeneration = useRef(0);
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
        if (thread.partial.kind === 'streaming') {
          resumePartial(sessionId, thread.messages);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          depsRef.current.onAuthError(error);
          return;
        }
        if (connectionFailure(error)) {
          depsRef.current.onConnectionWarning();
          return;
        }
        depsRef.current.setNotice(
          explain(error, depsRef.current.locale, textRef.current.connectionError),
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

  // 服务器确认够得着 / 页面回到可见：还在等回答的会话可能在断线期间有了
  // 进展，挨个补查一次线程（refreshThread 里带着续传逻辑）。
  // 断线补查不再直接监听浏览器的 online：online 只说明网卡通了，服务器未必
  // 够得着，那时补查多半白白失败一趟，还会和 use-service-status 的主动探测
  // 形成双份补查。改为监听探测确认成功后广播的 networkOkEvent（见
  // src/session/poll.ts）：补查与横幅撤销发生在同一时刻。
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
    window.addEventListener(networkOkEvent, catchUp);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener(networkOkEvent, catchUp);
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
        // 按轮次编号找不到气泡：用消息 id 保底，只认还在等待中的那条。
        index = session.messages.findIndex(
          (message) => message.id === fallbackKey && message.waiting === true,
        );
      }
      if (index === -1) {
        if (turnId === '') {
          // 没有轮次编号、保底也没找到：不补气泡，等下一个周期。
          return session;
        }
        // 这一轮还没进到页面里（比如刚刷新完），先补一个气泡。
        // 走到这里的一定是「还在写」的 partial（接口 200 只回 streaming）。
        const message: Message = {
          id: turnId,
          role: 'assistant',
          text: partial.text,
          locale: depsRef.current.locale,
          turnId,
          waiting: true,
        };
        return {...session, messages: [...session.messages, message]};
      }
      const message = session.messages[index];
      if (message === undefined) {
        // index 来自 findIndex 且已排除 -1，元素必然存在，这里只是类型上的保底处理
        return session;
      }
      if (!partial.text.startsWith(message.text)) {
        return session;
      }
      const waiting = visibleText(message.role, partial.text) === '';
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
   * 自身的标志驱动（docs/MESSAGE_ACTIONS.md），实时流程里就打上标记，不只靠
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
   * （409 繁忙、请求没有生效、后端没接下）时按 Gemini 的做法整轮回滚：新文字
   * 回输入框（busy 路径的 setDraft 负责），提问恢复原文，被去掉的回答连同
   * 状态提示恢复——动手改界面之前先把这一轮快照下来。请求已经生效的（流
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
      const message = messages[index];
      if (message !== undefined && message.role === 'user') {
        return message.text;
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

  function markPresent(messageId: string) {
    setPresentIds((current) =>
      current.has(messageId) ? current : new Set(current).add(messageId),
    );
  }

  /** 播放收尾（组件放完）或取消（停止、断流、发送失败）：id 移出登记。幂等。 */
  function endPresent(messageId: string) {
    setPresentIds((current) => {
      if (!current.has(messageId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(messageId);
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
        // 200 ⇒ 服务器说还在写（接口只回答「还在写吗」）：补半截文字即可。
        applyPartialText(sessionId, turnId, partial, fallbackKey);
      },
      (error?: ApiError) => {
        // 404（服务器明确说没在写，或会话没了）或 401（会话过期）：轮询
        // 到此为止，输入框解锁。404 去数据库核对并修正——结局标志（failed/aborted）
        // 在消息上，脚注照标志渲染；401 交给 App 层的统一出口（带 reason
        // 进入留在原页面的过期状态，不带的回退整页登录路径）。
        stopPolling(sessionId);
        clearPending(sessionId);
        if (error !== undefined && error.status === 401) {
          depsRef.current.onAuthError(error);
          return;
        }
        void refreshThread(sessionId);
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
    // 等待的气泡上没带轮次编号（比如是刷新线程带回来的）：拿消息 id 当保底定位键。
    startPolling(sessionId, turnId, turnId === '' ? waiting.id : '');
  }

  /**
   * 流断掉且没收到结局帧：问服务器「还在写吗」这一个问题。
   *
   * 还在写（200）→ 补上半截文字，接着轮询；明确说没在写（404，包括
   * 「Redis 里追的是别的轮次」）→ 以数据库为准核对并修正：结局标志（failed/aborted）
   * 已经在消息上，脚注照标志渲染；问不到服务器（网络错）→ 保留现场，
   * 不删已收到的文字，归常驻的连接警示横幅，不替服务器下结论；
   * 会话死了（401）→ 走统一的 401 出口（onAuthError），进入会话过期后
   * 留在原页面的状态，不归连接横幅。
   */
  async function recoverReply(sessionId: string, turnId: string) {
    const generation = loginGeneration.current;
    const probe = await probePartial(sessionId);
    if (generation !== loginGeneration.current) {
      // 已经退出登录：不再恢复，免得补出等待气泡、开启轮询去接管新会话。
      return;
    }
    if (probe.kind === 'unauthorized') {
      // 会话死了：与 sendQuestion 的 401 同一个出口（带 reason 进入会话过期后
      // 留在原页面的状态），不走连接横幅，也不静默忽略。
      depsRef.current.onAuthError(probe.error);
      return;
    }
    if (probe.kind === 'unreachable') {
      depsRef.current.onConnectionWarning();
      return;
    }
    if (
      probe.kind === 'streaming' &&
      (probe.partial.turnId === null || probe.partial.turnId === turnId)
    ) {
      applyPartialText(sessionId, turnId, probe.partial);
      startPolling(sessionId, turnId);
      return;
    }
    // idle（或 Redis 里追的是别的轮次）：这一轮已经不在写了，以数据库为准。
    await refreshThread(sessionId);
  }

  async function sendQuestion(
    sessionId: string,
    question: string,
    turnId: string,
    retryOf?: string,
    onRollback?: () => void,
  ) {
    // 出发时的登录世代编号：后面每次写状态之前都核对它，退出/重新登录后整段放弃。
    const generation = loginGeneration.current;
    const assistantId = crypto.randomUUID();
    const controller = new AbortController();
    aborters.current.set(sessionId, {controller, turnId});
    // 本轮播放有没有登记过：第一个内容增量到达就登记，不等 done 帧——
    // done 帧到达时全文已经渲染过一帧，晚登记会先闪现全文再退回播放。
    let presentMarked = false;
    try {
      addWaitingMessage(sessionId, assistantId, turnId);
      const outcome = await streamReply(
        sessionId,
        question,
        turnId,
        (chunk) => {
          if (generation !== loginGeneration.current) {
            // 已经退出登录：这条流的内容不再属于当前会话，放弃。
            return;
          }
          // 第一个内容增量到达：进度文本完成使命（清空是幂等的，
          // 后续增量拿到同一份引用，不再触发重渲染）。
          clearProgress(sessionId);
          if (!presentMarked) {
            presentMarked = true;
            markPresent(assistantId);
          }
          applyStreamText(sessionId, assistantId, chunk);
        },
        controller.signal,
        retryOf,
        (name) => {
          if (generation !== loginGeneration.current) {
            return;
          }
          setSessionProgress(sessionId, name);
        },
      );
      if (generation !== loginGeneration.current) {
        // 流的期间退出过登录：三张表已被 resetForLogin 清空，下面所有分支都
        // 不再执行，免得旧一轮的结局写进刚登录的新会话。
        return;
      }
      // 流结束（五种结局都一样）：进度文本不再有意义。
      clearProgress(sessionId);
      if (outcome === 'busy') {
        // 这场会话已经有一轮在写，这一次没发出去。把问题放回输入框，等答完再发。
        endPresent(assistantId);
        removeTurn(sessionId, turnId);
        depsRef.current.setDraft(question);
        saveUnsent(question);
        setSessionWarning({sessionId, text: textRef.current.roundBusy});
        await refreshThread(sessionId);
        if (generation !== loginGeneration.current) {
          // 读线程的期间退出过登录：回滚不再执行，免得把旧消息快照插进新会话。
          return;
        }
        // 重发（重试/编辑重发）没发出去：把旧轮次放回来。refreshThread 一般已经
        // 从服务器带回旧轮次，这里是读线程失败时的保底处理；恢复本身是幂等的。
        onRollback?.();
        return;
      }
      if (outcome === 'aborted') {
        // 被停的轮次不播放：半截文字立即全部显示。
        endPresent(assistantId);
        // 用户按了停止。停止流程负责收尾：它去问服务器这一轮到底怎么样，
        // 页面上打上的标记要跟服务器一致。
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
        // 断流补回的回答一律立即全部显示，不走播放。
        endPresent(assistantId);
        await recoverReply(sessionId, turnId);
        return;
      }
      if (outcome === 'not-started') {
        // 请求没有生效，服务器上没有这一轮。这一轮不能悬空——用户永远要有
        // 下一次机会：连不上照旧归横幅报，轮次级重试入口按场景保住。
        endPresent(assistantId);
        if (onRollback !== undefined) {
          // 重试/编辑重发没发出去：空的气泡去掉，旧轮次放回原样——旧轮次的
          // 状态提示和重试按钮跟着回来。
          removeTurnAnswer(sessionId, turnId);
          onRollback();
        } else {
          // 第一次发送没有生效：空气泡留下并标成 failed——气泡带着 turnId，
          // 脚注里就给得出重试按钮（P2）。
          markTurnStatus(sessionId, turnId, 'failed');
        }
        depsRef.current.setNotice(textRef.current.connectionError);
      }
    } catch (error) {
      if (generation !== loginGeneration.current) {
        // 已经退出登录：不存草稿、不挂提示、也不调 401 出口，别弄脏新登录的会话。
        return;
      }
      endPresent(assistantId);
      if (error instanceof ApiError && error.status === 401) {
        // 发送时被强制下线：发送前草稿已经清了，这句提问存起来，
        // 登录后放回输入框。
        removeTurnAnswer(sessionId, turnId);
        onRollback?.();
        saveUnsent(question);
        depsRef.current.onAuthError(error);
        return;
      }
      if (onRollback !== undefined) {
        // 重发没成功：旧轮次放回原样（请求几乎可以肯定没有生效；万一生效了，
        // 下一次读线程会用服务器的版本盖掉）。重试按钮跟着旧轮脚注回来，
        // 碰到「连不上」这一轮也不悬空（P1）。
        removeTurnAnswer(sessionId, turnId);
        onRollback();
      } else {
        // 第一次发送没成功：空气泡留下并标成 failed——气泡带着 turnId，
        // 脚注里给得出重试按钮，这一轮不悬空。
        markTurnStatus(sessionId, turnId, 'failed');
      }
      if (connectionFailure(error)) {
        depsRef.current.onConnectionWarning();
        return;
      }
      // 后端没接下（ApiError 带 detail）或别的异常：归横幅报，不再往消息流里插错误消息。
      // 统一走 explain：简中原样显示 detail，英文/繁中优先按状态码映射（裁决规则在 src/api/failure.ts）。
      depsRef.current.setNotice(
        explain(error, depsRef.current.locale, textRef.current.connectionError),
      );
    } finally {
      // 世代编号变了就不清：resetForLogin 已经把三张表清空，重新登录后同一场
      // 会话可能已经登记了新一轮，在这里误删会把新一轮的发送锁放开。
      if (generation === loginGeneration.current) {
        aborters.current.delete(sessionId);
        stoppers.current.delete(sessionId);
        sendingRef.current.delete(sessionId);
        clearProgress(sessionId);
        if (!pollers.current.has(sessionId)) {
          clearPending(sessionId);
        }
      }
    }
  }

  /** 重新读一次线程：这一轮是在别的页面发出去的，本页还不知道。 */
  async function refreshThread(sessionId: string) {
    const generation = loginGeneration.current;
    try {
      const thread = await loadThread(sessionId);
      if (generation !== loginGeneration.current) {
        // 已经退出登录：旧线程不再覆盖新登录会话的消息列表。
        return;
      }
      depsRef.current.updateSession(sessionId, (session) => ({
        ...session,
        messages: thread.messages,
        messagesKnown: true,
      }));
      if (thread.partial.kind === 'streaming') {
        resumePartial(sessionId, thread.messages);
      }
    } catch (error) {
      if (generation !== loginGeneration.current) {
        // 已经退出登录：旧请求的 401 不再经 onAuthError 压到新登录的会话上。
        return;
      }
      // 会话过期走统一的 401 出口（和历史加载同款）；其余读不到就算了，
      // 页面照常用。
      if (error instanceof ApiError && error.status === 401) {
        depsRef.current.onAuthError(error);
      }
    }
  }

  /**
   * 用户按了停止之后的收尾。
   *
   * 先让服务器记下停止（服务器写停止标记，再取消正在跑的任务），
   * 再问服务器「这一轮还在写吗」这一个问题：还在写就接着等；明确说
   * 没在写（404）就以数据库为准核对并修正，停了/写完/失败的标志在消息上，
   * 气泡下方的脚注照标志渲染；会话死了（401）走统一的 401 出口。
   * 页面不自己宣布停了。
   */
  async function finishStop(sessionId: string, turnId: string, fallbackKey: string = '') {
    const generation = loginGeneration.current;
    try {
      await abortReply(sessionId, turnId);
    } catch {
      // 服务器那边收不到也不碍事：页面已经不等这一轮了。
    }
    if (generation !== loginGeneration.current) {
      // 已经退出登录：停止的收尾不再做，免得把旧轮次的状态写进新会话、开新轮询。
      return;
    }

    const probe = await probePartial(sessionId);
    if (generation !== loginGeneration.current) {
      return;
    }
    if (probe.kind === 'unauthorized') {
      // 会话死了：走统一的 401 出口（与 recoverReply 同款）。不挂连接横幅，
      // 也不就地标 aborted——会话已失效，服务器那边停没停成，页面不知道，
      // 不替服务器下结论。
      depsRef.current.onAuthError(probe.error);
      return;
    }
    if (
      probe.kind === 'streaming' &&
      (probe.partial.turnId === null || probe.partial.turnId === turnId)
    ) {
      // 服务器那边还在写：接着等，别骗用户说停了。
      startPolling(sessionId, turnId, fallbackKey);
      setSessionWarning({sessionId, text: textRef.current.replyStopFailed});
      return;
    }
    if (probe.kind === 'unreachable') {
      // 问不到服务器：保留已收到的文字，就地把这一轮标成 aborted
      // （用户确实按了停止，页面不替服务器下别的结论），连接问题归
      // 常驻横幅。
      markTurnStatus(sessionId, turnId, 'aborted');
      depsRef.current.onConnectionWarning();
      return;
    }
    // 明确说没在写（404，包括「Redis 里追的是别的轮次」）：以数据库为准
    // 核对并修正，停了/写完/失败的标志在消息上，脚注照标志渲染。
    await refreshThread(sessionId);
  }

  /** 等待中的气泡没有轮次编号时，拿它的消息 id 当轮询的保底定位键；否则给空串。 */
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

  /** 这个会话的线程既没加载过、也没有正在进行的加载：由调用方决定要不要触发重载。 */
  function shouldReloadThread(sessionId: string): boolean {
    return !loadedThreads.current.has(sessionId) && !threadFlight.current.has(sessionId);
  }

  function bumpThreadRetry() {
    setThreadRetry((current) => current + 1);
  }

  /**
   * 退出登录/被强制退回登录页：把进行中的加载、轮询和等待标记一次清干净，
   * 中止还在进行的发送请求，清空「正在发送」集合、取消器表和停止器表，
   * 并把登录世代编号加一——还挂在 await 上的旧流程回来时发现编号变了，
   * 会整段放弃，不再写任何状态（见 loginGeneration 的注释）。
   */
  function resetForLogin() {
    loginGeneration.current += 1;
    for (const {controller} of aborters.current.values()) {
      controller.abort();
    }
    aborters.current.clear();
    stoppers.current.clear();
    sendingRef.current.clear();
    setPendingIds(new Set());
    setPresentIds(new Set());
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

  /** 这个会话的轮询器还活着吗：App 侧清理与引擎 finally 对齐锁语义用。 */
  function hasLivePoller(sessionId: string): boolean {
    return pollers.current.has(sessionId);
  }

  return {
    pendingIds,
    setPendingIds,
    presentIds,
    endPresent,
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
    hasLivePoller,
    markThreadLoaded,
    shouldReloadThread,
    bumpThreadRetry,
    resetForLogin,
  };
}
