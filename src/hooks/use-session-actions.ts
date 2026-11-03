import {useEffect, useRef} from 'react';
import {useNavigate} from 'react-router';
import {connectionFailure, explain} from '../api/failure.ts';
import {ApiError} from '../api/http.ts';
import {deleteSession, pinSession, renameSession} from '../api/session.ts';
import {translations} from '../i18n.ts';
import type {Session} from '../type/chat.ts';
import type {Locale} from '../type/locale.ts';

type SessionActionsDeps = {
  locale: Locale;
  activeId: string | null;
  setSessions: (updater: (current: Session[]) => Session[]) => void;
  setNotice: (notice: string | null) => void;
  onShowToast: (message: string) => void;
  onEnterLogin: (detail: string | null) => void;
  onConnectionWarning: () => void;
  showNewChat: () => void;
  onStopPolling: (sessionId: string) => void;
  onClearPending: (sessionId: string) => void;
};

/**
 * 会话列表上的四个动作：改名、删会话、置顶/取消置顶，以及首问自动
 * 命名的保存（saveTitle）。titleSaves 记着在飞的改名请求，新的改名
 * 先等旧的落定，避免乱序互相覆盖。
 */
export function useSessionActions(deps: SessionActionsDeps) {
  const navigate = useNavigate();
  const titleSaves = useRef(new Map<string, Promise<void>>());
  // 异步流程可能跨渲染：依赖放进 ref，镜像在效果里做（渲染期间写 ref 被禁止）。
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  async function renameOpenSession(id: string, title: string): Promise<boolean> {
    const {locale, setSessions, setNotice, onShowToast, onEnterLogin, onConnectionWarning} =
      depsRef.current;
    const text = translations[locale];
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
      onShowToast(text.renameDone);
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
        onEnterLogin(error.detail);
        return false;
      }
      if (connectionFailure(error)) {
        onConnectionWarning();
        return false;
      }
      setNotice(explain(error, text.connectionError));
      return false;
    }
  }

  async function saveTitle(sessionId: string, title: string): Promise<boolean> {
    const {locale, setNotice, onEnterLogin, onConnectionWarning} = depsRef.current;
    try {
      await renameSession(sessionId, title);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return false;
      }
      if (error instanceof ApiError && error.status === 401) {
        onEnterLogin(error.detail);
        return false;
      }
      if (connectionFailure(error)) {
        onConnectionWarning();
        return false;
      }
      setNotice(explain(error, translations[locale].connectionError));
      return false;
    }
  }

  async function removeSession(id: string): Promise<boolean> {
    const {
      locale,
      activeId,
      setSessions,
      setNotice,
      onShowToast,
      onEnterLogin,
      onConnectionWarning,
      showNewChat,
      onStopPolling,
      onClearPending,
    } = depsRef.current;
    const wasCurrent = activeId === id;
    try {
      await deleteSession(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onEnterLogin(error.detail);
        return false;
      }
      if (connectionFailure(error)) {
        onConnectionWarning();
        return false;
      }
      setNotice(explain(error, translations[locale].connectionError));
      return false;
    }
    setSessions((current) => current.filter((session) => session.id !== id));
    onShowToast(translations[locale].deleteDone);
    onStopPolling(id);
    onClearPending(id);
    if (!wasCurrent) {
      return true;
    }
    showNewChat();
    void navigate('/', {replace: true});
    return true;
  }

  async function pinOpenSession(id: string, pinned: boolean) {
    const {locale, setSessions, setNotice, onEnterLogin, onConnectionWarning} = depsRef.current;
    try {
      const item = await pinSession(id, pinned, pinned ? new Date().toISOString() : null);
      setSessions((current) =>
        current.map((session) =>
          session.id === id ? {...session, pinned: item.pinned, pinnedAt: item.pinned_at} : session,
        ),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onEnterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        onConnectionWarning();
        return;
      }
      setNotice(explain(error, translations[locale].connectionError));
    }
  }

  return {titleSaves, renameOpenSession, saveTitle, removeSession, pinOpenSession};
}
