import {useState, type SubmitEvent} from 'react';
import type {NavigateFunction} from 'react-router';
import {connectionFailure, explain} from '../api/failure.ts';
import {ApiError} from '../api/http.ts';
import {createSession, emptySession} from '../api/session.ts';
import type {Messages} from '../i18n/index.ts';
import {clearDraft, readDraft, saveDraft} from '../session/drafts.ts';
import {titleFromQuestion} from '../session/title.ts';
import {clearUnsent, readUnsent, saveUnsent} from '../session/unsent.ts';
import type {Message, Session} from '../type/chat.ts';
import type {Locale} from '../type/locale.ts';
import type {SessionInvalid} from './use-auth-flow.ts';
import type {useServiceStatus} from './use-service-status.ts';
import type {useSessionActions} from './use-session-actions.ts';
import type {useTurnEngine} from './use-turn-engine.ts';

type MessageSubmitDeps = {
  locale: Locale;
  text: Messages;
  draft: string;
  activeId: string | null;
  active: Session | undefined;
  sessionInvalid: SessionInvalid | null;
  navigate: NavigateFunction;
  setDraft: (value: string) => void;
  setActiveId: (id: string | null) => void;
  setSessions: (updater: (current: Session[]) => Session[]) => void;
  setNotice: (notice: string | null) => void;
  setView: (view: 'chat' | 'profile') => void;
  setComposingNew: (value: boolean) => void;
  markEntering: (id: string) => void;
  updateSession: (sessionId: string, change: (session: Session) => Session) => void;
  handleAuthError: (error: ApiError) => void;
  engineRef: {current: ReturnType<typeof useTurnEngine> | null};
  sessionActionsRef: {current: ReturnType<typeof useSessionActions> | null};
  serviceRef: {current: ReturnType<typeof useServiceStatus> | null};
};

/**
 * 发送消息：submitMessage 与它的守卫、首条消息建会话并发送（sendFirstMessage），
 * 以及切会话/新对话时的草稿与未发送句子的读写（handleDraft/showSession/showNewChat）。
 * 轮次引擎、会话动作和服务状态走传入的 ref 读（这几个 hook 在本 hook 之后才
 * 接线）：这里的函数都只在用户事件和异步回调里跑，触发时镜像早已填好，
 * 读到的是最新的一份。
 */
export function useMessageSubmit(deps: MessageSubmitDeps) {
  const {
    locale,
    text,
    draft,
    activeId,
    active,
    sessionInvalid,
    navigate,
    setDraft,
    setActiveId,
    setSessions,
    setNotice,
    setView,
    setComposingNew,
    markEntering,
    updateSession,
    handleAuthError,
    engineRef,
    sessionActionsRef,
    serviceRef,
  } = deps;
  const [sendingNew, setSendingNew] = useState(false);

  /**
   * 输入框变化：更新状态，同时存进当前会话自己的草稿（N3：sessionStorage
   * 按键 h2bot-draft:{会话id} 各存各的，新对话用固定键）。每次按键即写而
   * 不做防抖：sessionStorage 同步写开销可忽略，省掉「切会话/卸载时何时
   * flush」的时序隐患。引擎的 busy 回填（setDraft）也走这里，回填的文字
   * 同样写进对应会话的草稿。
   */
  function handleDraft(value: string) {
    setDraft(value);
    saveDraft(activeId, value);
  }

  function showSession(id: string) {
    setComposingNew(false);
    setActiveId(id);
    // 草稿按会话各存各的：切会话不互相清，切回来原样恢复。
    setDraft(readDraft(id));
    setNotice(null);
    setView('chat');
  }

  function showNewChat() {
    setComposingNew(true);
    setActiveId(null);
    // unsent 恢复优先于草稿：被强制下线、busy 回填存下的句子不能丢；
    // 没有存下的句子才用新对话自己的草稿。
    const unsent = readUnsent();
    setDraft(unsent !== '' ? unsent : readDraft(null));
    setNotice(null);
    setView('chat');
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
      engineRef.current?.markThreadLoaded(sessionId);
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
      // 发送成功：清掉新对话自己的草稿（问题已经进线程了）。
      clearDraft(null);
      setDraft('');
      markEntering(userMessage.id);
      engineRef.current?.sendingRef.current.add(sessionId);
      engineRef.current?.setPendingIds((current) => new Set(current).add(sessionId));
      engineRef.current?.clearSessionWarning(sessionId);
      await engineRef.current?.sendQuestion(sessionId, question, turnId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // 会话在发出前就过期了：这句提问存起来，登录后放回输入框。
        saveUnsent(question);
        handleAuthError(error);
        return;
      }
      if (connectionFailure(error)) {
        serviceRef.current?.showConnectionWarning();
        return;
      }
      if (sessionId === '') {
        setNotice(explain(error, locale, text.connectionError));
      }
    } finally {
      setSendingNew(false);
      if (sessionId !== '') {
        engineRef.current?.sendingRef.current.delete(sessionId);
        // 与引擎的 finally 对齐：断线恢复已经把轮询接过去时不清 pending，
        // 不然输入框被解锁，下一次发送会碰到 409。
        if (!engineRef.current?.hasLivePoller(sessionId)) {
          engineRef.current?.setPendingIds((current) => {
            const next = new Set(current);
            next.delete(sessionId);
            return next;
          });
        }
      }
    }
  }

  function submitMessage(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (
      !question ||
      sendingNew ||
      sessionInvalid !== null ||
      (active && engineRef.current?.sendingRef.current.has(active.id))
    ) {
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
    engineRef.current?.sendingRef.current.add(sessionId);
    engineRef.current?.setPendingIds((current) => new Set(current).add(sessionId));
    setNotice(null);
    engineRef.current?.clearSessionWarning(sessionId);
    clearUnsent();
    // 发送成功：清掉这场会话自己的草稿。
    clearDraft(sessionId);
    setDraft('');
    updateSession(sessionId, (session) => ({
      ...session,
      title: session.title ?? title,
      messages: [...session.messages, userMessage],
    }));
    markEntering(userMessage.id);
    if (missingTitle) {
      // 会话动作走 ref 拿最新的一份；titleSaves 这个 Map 跨渲染是同一个对象，
      // 什么时候读都一样。
      const actions = sessionActionsRef.current;
      if (actions !== null) {
        const saving = actions
          .saveTitle(sessionId, title)
          .then((saved) => {
            if (!saved) {
              updateSession(sessionId, (session) => ({...session, title: null}));
            }
          })
          .finally(() => {
            actions.titleSaves.current.delete(sessionId);
          });
        actions.titleSaves.current.set(sessionId, saving);
      }
    }
    void engineRef.current?.sendQuestion(sessionId, question, turnId);
  }

  return {sendingNew, handleDraft, showSession, showNewChat, submitMessage};
}
