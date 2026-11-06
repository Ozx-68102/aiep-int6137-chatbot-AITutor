import {useEffect, useRef} from 'react';
import {useNavigate} from 'react-router';
import {connectionFailure, explain} from '../api/failure.ts';
import {ApiError} from '../api/http.ts';
import {deleteSession, pinSession, renameSession} from '../api/session.ts';
import {translations} from '../i18n/index.ts';
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
 * 命名的保存（saveTitle）。titleSaves 记着正在进行的改名请求，新的改名
 * 先等旧的完成，避免乱序互相覆盖。
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
      setNotice(explain(error, locale, text.connectionError));
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
      setNotice(explain(error, locale, translations[locale].connectionError));
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
      setNotice(explain(error, locale, translations[locale].connectionError));
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

  /**
   * 置顶/取消置顶走乐观更新：点下去界面立刻生效，请求在后台发，
   * 成功后把本地值换成服务端的权威值；失败回滚界面，并用现有的
   * toast 服务弹出错误（成功不提示）。
   */
  async function pinOpenSession(id: string, pinned: boolean) {
    const {locale, setSessions, onShowToast, onEnterLogin, onConnectionWarning} = depsRef.current;
    const text = translations[locale];
    // 先本地生效：pinnedAt 先用本地时间，服务端回来再换成权威值。
    setSessions((current) =>
      current.map((session) =>
        session.id === id
          ? {...session, pinned, pinnedAt: pinned ? new Date().toISOString() : null}
          : session,
      ),
    );
    try {
      const item = await pinSession(id, pinned, pinned ? new Date().toISOString() : null);
      setSessions((current) =>
        current.map((session) =>
          session.id === id ? {...session, pinned: item.pinned, pinnedAt: item.pinned_at} : session,
        ),
      );
    } catch (error) {
      // 回滚：pinned 恢复成点击时的样子（!pinned）。原来的 pinnedAt 没有
      // 快照，恢复成 null——罕见的回滚场景下只影响这条会话在置顶组里的
      // 先后，可忽略（docs/improvement-research/frontend-app.md 的 O11）。
      setSessions((current) =>
        current.map((session) =>
          session.id === id ? {...session, pinned: !pinned, pinnedAt: null} : session,
        ),
      );
      if (error instanceof ApiError && error.status === 401) {
        // 登录过期：登录界面会带着服务器给的说法接住，这里不再弹 toast。
        onEnterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        // 连接类失败照旧走全局服务警示，保持和其他动作一致。
        onConnectionWarning();
      }
      // 失败反馈改走 toast：菜单点完就关了，输入区上方的警示框容易被漏看。
      onShowToast(explain(error, locale, text.connectionError));
    }
  }

  return {titleSaves, renameOpenSession, saveTitle, removeSession, pinOpenSession};
}
