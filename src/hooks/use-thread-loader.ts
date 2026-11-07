import {useEffect, useRef, useState} from 'react';
import type {RefObject} from 'react';
import {connectionFailure, explain} from '../api/failure.ts';
import {ApiError} from '../api/http.ts';
import {translations} from '../i18n/index.ts';
import {loadThread} from '../session/thread.ts';
import type {Message} from '../type/chat.ts';
import type {TurnEngineDeps} from './use-turn-engine.ts';

/**
 * 线程加载：切到还没加载历史的会话时拉取记录（loadedThreads/threadFlight
 * 两张表），以及重新读一次线程（refreshThread，里面带着续传逻辑）。
 * 这一层从 use-turn-engine.ts 拆出来，依赖用参数显式传入：引擎的全部依赖
 * （deps）在本层镜像进 ref，登录世代编号共用引擎的那一个 ref。
 */

export type ThreadLoaderDeps = {
  deps: TurnEngineDeps;
  loginGeneration: RefObject<number>;
};

export function useThreadLoader(params: ThreadLoaderDeps) {
  const {deps, loginGeneration} = params;
  const {auth, activeId, composingNew} = deps;
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [threadRetry, setThreadRetry] = useState(0);
  const loadedThreads = useRef(new Set<string>());
  const threadFlight = useRef(new Set<string>());
  const depsRef = useRef(deps);
  const textRef = useRef(translations[deps.locale]);
  /**
   * 断流续传的入口在 use-reply-recovery，那一层在引擎里晚于本层创建，
   * 所以经 ref 传递：引擎在镜像效果里把最新的函数放进来，本层的调用点
   * 都在异步回调里，执行时镜像早已就位。
   */
  const resumePartialRef = useRef<((sessionId: string, messages: Message[]) => void) | null>(null);
  // 依赖放进 ref、在效果里镜像：与 use-turn-engine 同一个理由——加载回调是
  // 跨渲染的长异步流程，要拿最新的一份；渲染期间写 ref 是被禁止的（react/refs）。
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
          resumePartialRef.current?.(sessionId, thread.messages);
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
        resumePartialRef.current?.(sessionId, thread.messages);
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
   * 退出登录的清理：加载标记和两张线程表一次清掉。由 use-turn-engine 的
   * resetForLogin 调用，三步的先后顺序与拆分前一致。
   */
  function clearForLogin() {
    setHistoryLoadingId(null);
    loadedThreads.current.clear();
    threadFlight.current.clear();
  }

  return {
    historyLoadingId,
    resumePartialRef,
    refreshThread,
    markThreadLoaded,
    shouldReloadThread,
    bumpThreadRetry,
    clearForLogin,
  };
}
