import {useEffect, useRef, useState} from 'react';
import {ApiError} from '../api/http.ts';
import {readProfile} from '../api/profile.ts';
import {listSessions, sessionsFromList} from '../api/session.ts';
import {readStatus} from '../api/status.ts';
import {translations} from '../i18n/index.ts';
import {saveCachedProfile} from '../session/profile-cache.ts';
import type {Session} from '../type/chat.ts';
import type {Locale} from '../type/locale.ts';

const statusIntervalMs = 30000;

export type ServiceState = 'ok' | 'unreachable' | 'database' | 'store';

export function serviceNoticeText(
  state: ServiceState,
  copy: (typeof translations)[Locale],
): string | null {
  if (state === 'unreachable') {
    return copy.connectionRetry;
  }
  if (state === 'database') {
    return copy.serviceUnavailable;
  }
  if (state === 'store') {
    return copy.replyStoreUnavailable;
  }
  return null;
}

type ServiceStatusDeps = {
  auth: 'checking' | 'anonymous' | 'ready';
  setSessions: (sessions: Session[]) => void;
  setUsername: (username: string) => void;
  setLocale: (locale: Locale) => void;
  setAvatarUrl: (url: string | null) => void;
  onClaimPath: (list: Session[]) => void;
  onEnterLogin: (detail: string | null) => void;
};

/**
 * 服务健康状态：30 秒轮询 /api/status，标记连不上/数据库/回复库三档降级，
 * 以及服务器从「连不上」回来时补齐工作区（refreshWorkspace）的动作。
 */
export function useServiceStatus(deps: ServiceStatusDeps) {
  const {auth} = deps;
  const [serviceState, setServiceState] = useState<ServiceState>('ok');
  const serviceStateRef = useRef<ServiceState>('ok');
  // 异步流程可能跨渲染：依赖放进 ref，镜像在效果里做（渲染期间写 ref 被禁止）。
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  function markService(state: ServiceState) {
    serviceStateRef.current = state;
    setServiceState(state);
  }

  function showConnectionWarning() {
    // 连不上服务器归到服务状态里：聊天区上方只出一个框，不重复报两遍。
    markService('unreachable');
  }

  /** 服务器回来了：把会话列表和用户信息补上，不用用户手动刷新页面。 */
  async function refreshWorkspace(): Promise<void> {
    const current = depsRef.current;
    try {
      const items = await listSessions();
      const next = sessionsFromList(items);
      current.setSessions(next);
      // 按当前地址重新认领状态：离线期间停在 /chat/<id> 的，把会话重新打开。
      current.onClaimPath(next);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        current.onEnterLogin(error.detail);
      }
      return;
    }
    try {
      const profile = await readProfile();
      current.setUsername(profile.username);
      current.setLocale(profile.locale);
      current.setAvatarUrl(profile.avatarUrl);
      saveCachedProfile({username: profile.username, locale: profile.locale});
    } catch {
      return;
    }
  }

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
        const wasDown = serviceStateRef.current === 'unreachable';
        if (status.reply_store === 'unavailable') {
          markService('store');
        } else if (status.database === 'unavailable') {
          markService('database');
        } else {
          markService('ok');
        }
        if (wasDown) {
          // 服务器刚回来：把会话列表和用户信息补上。
          void refreshWorkspace();
        }
      } catch {
        if (!stopped) {
          markService('unreachable');
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

  return {serviceState, markService, showConnectionWarning};
}
