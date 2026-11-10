import type {Dispatch, RefObject, SetStateAction} from 'react';
import {probePartial} from '../api/partial.ts';
import type {PartialReply} from '../api/partial.ts';
import {applyPartialText as applyPartialTextToMessages} from '../session/turn-actions.ts';
import type {Message} from '../type/chat.ts';
import type {TurnEngineDeps} from './use-turn-engine.ts';

/**
 * 断流恢复的编排：recoverReply（流断掉且没收到结局帧时问服务器「还在写吗」）、
 * resumePartial（线程里有等待中的气泡时接着轮询）和 applyPartialText（把半截
 * 文字写进气泡，消息变换本体在 session/turn-actions.ts）。
 * 这一层从 use-turn-engine.ts 拆出来；登录世代编号、轮询登记入口和
 * refreshThread 都由引擎显式传入。
 */

export type ReplyRecoveryDeps = {
  depsRef: RefObject<TurnEngineDeps>;
  loginGeneration: RefObject<number>;
  setPendingIds: Dispatch<SetStateAction<Set<string>>>;
  /** 轮询器登记表的入口（session/poller-registry.ts，由引擎持有）。 */
  startPolling: (sessionId: string, turnId: string, fallbackKey?: string) => void;
  refreshThread: (sessionId: string) => Promise<void>;
};

export function useReplyRecovery(deps: ReplyRecoveryDeps) {
  const {depsRef, loginGeneration, setPendingIds, startPolling, refreshThread} = deps;

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
      const messages = applyPartialTextToMessages(
        session.messages,
        turnId,
        partial,
        depsRef.current.locale,
        fallbackKey,
      );
      // 变换交回同一份数组时（拆分前 updater 里原样 return session 的几条路径）
      // 这里也原样交回 session，不无谓产生一个新对象。
      if (messages === session.messages) {
        return session;
      }
      return {...session, messages};
    });
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

  return {applyPartialText, resumePartial, recoverReply};
}
