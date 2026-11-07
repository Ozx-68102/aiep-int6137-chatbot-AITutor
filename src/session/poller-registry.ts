import type {ApiError} from '../api/http.ts';
import type {PartialReply} from '../api/partial.ts';
import {startPartialPolling} from './poll.ts';

/**
 * 轮询器登记表：会话 id → 停止函数，管理「还在写吗」轮询的登记、停止和查询。
 * 轮询循环本身在 poll.ts；这一层从 use-turn-engine.ts 拆出来，由引擎创建并持有
 * （createPollerRegistry 只在组件挂载时调用一次，表在渲染之间保持不变）。
 */

export type PollerHandlers = {
  /** 200 ⇒ 服务器说还在写：把半截文字交给谁处理（引擎接到 applyPartialText）。 */
  applyPartial: (
    sessionId: string,
    turnId: string,
    partial: PartialReply,
    fallbackKey: string,
  ) => void;
  /** 轮询到此为止后解锁输入框：把会话从「还在等回答」的集合里去掉。 */
  clearPending: (sessionId: string) => void;
  /** 会话过期（401）：交给 App 层的统一出口。 */
  onAuthError: (error: ApiError) => void;
  /** 服务器明确说没在写（404）：去数据库核对并修正。 */
  refreshThread: (sessionId: string) => Promise<void>;
};

export type PollerRegistry = {
  startPolling: (sessionId: string, turnId: string, fallbackKey?: string) => void;
  stopPolling: (sessionId: string) => void;
  /** 这个会话的轮询器还活着吗：App 侧清理与引擎 finally 对齐锁语义用。 */
  hasLivePoller: (sessionId: string) => boolean;
  /** 停掉并注销全部轮询器：退出登录的清理和组件卸载用。 */
  stopAll: () => void;
};

export function createPollerRegistry(handlers: PollerHandlers): PollerRegistry {
  const pollers = new Map<string, () => void>();

  function stopPolling(sessionId: string) {
    const stop = pollers.get(sessionId);
    if (stop === undefined) {
      return;
    }
    stop();
    pollers.delete(sessionId);
  }

  function startPolling(sessionId: string, turnId: string, fallbackKey: string = '') {
    stopPolling(sessionId);
    const stop = startPartialPolling(
      sessionId,
      (partial) => {
        // 200 ⇒ 服务器说还在写（接口只回答「还在写吗」）：补半截文字即可。
        handlers.applyPartial(sessionId, turnId, partial, fallbackKey);
      },
      (error?: ApiError) => {
        // 404（服务器明确说没在写，或会话没了）或 401（会话过期）：轮询
        // 到此为止，输入框解锁。404 去数据库核对并修正——结局标志（failed/aborted）
        // 在消息上，脚注照标志渲染；401 交给 App 层的统一出口（带 reason
        // 进入留在原页面的过期状态，不带的回退整页登录路径）。
        stopPolling(sessionId);
        handlers.clearPending(sessionId);
        if (error !== undefined && error.status === 401) {
          handlers.onAuthError(error);
          return;
        }
        void handlers.refreshThread(sessionId);
      },
    );
    pollers.set(sessionId, stop);
  }

  function hasLivePoller(sessionId: string): boolean {
    return pollers.has(sessionId);
  }

  function stopAll() {
    for (const stop of pollers.values()) {
      stop();
    }
    pollers.clear();
  }

  return {startPolling, stopPolling, hasLivePoller, stopAll};
}
