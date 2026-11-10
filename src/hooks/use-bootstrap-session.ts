import {useEffect, useRef} from 'react';
import {connectionFailure, explain} from '../api/failure.ts';
import {ApiError, mustChangePasswordCode} from '../api/http.ts';
import {readProfile} from '../api/profile.ts';
import type {Profile} from '../api/profile.ts';
import {listSessions, sessionsFromList} from '../api/session.ts';
import {translations} from '../i18n/index.ts';
import {readDraft} from '../session/drafts.ts';
import {saveCachedProfile} from '../session/profile-cache.ts';
import type {Session} from '../type/chat.ts';
import {localeFromSystem, type Locale} from '../type/locale.ts';
import type {usePathRouting} from './use-path-routing.ts';
import type {useServiceStatus} from './use-service-status.ts';

type BootstrapSessionDeps = {
  setAuth: (auth: 'checking' | 'anonymous' | 'ready') => void;
  setMustChangePassword: (value: boolean) => void;
  setLoginOffline: (value: boolean) => void;
  setLoginDetail: (detail: string | null) => void;
  setSessions: (sessions: Session[]) => void;
  setUsername: (username: string) => void;
  setLocale: (locale: Locale) => void;
  setAvatarUrl: (url: string | null) => void;
  setComposingNew: (value: boolean) => void;
  setDraft: (value: string) => void;
  routingRef: {current: ReturnType<typeof usePathRouting> | null};
  serviceRef: {current: ReturnType<typeof useServiceStatus> | null};
};

/**
 * 启动引导：进页面时拉会话列表和用户资料。401 回登录界面；接口服务连不上
 * 按离线启动（登录态还在，只挂「连不上」横幅）；403 带「必须修改密码」
 * 标记时直接进入强制改密拦截；启动途中的其他错误回登录界面并带出错误文案。
 */
export function useBootstrapSession(deps: BootstrapSessionDeps) {
  // 异步流程可能跨渲染：依赖放进 ref，镜像在效果里做（渲染期间写 ref 被禁止）。
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  useEffect(() => {
    const {
      setAuth,
      setMustChangePassword,
      setLoginOffline,
      setLoginDetail,
      setSessions,
      setUsername,
      setLocale,
      setAvatarUrl,
      setComposingNew,
      setDraft,
      routingRef,
      serviceRef,
    } = depsRef.current;
    let cancelled = false;
    listSessions().then(
      async (items) => {
        if (cancelled) {
          return;
        }
        let profile: Profile | null = null;
        try {
          profile = await readProfile();
        } catch (error) {
          if (cancelled) {
            return;
          }
          if (error instanceof ApiError && error.status === 401) {
            setAuth('anonymous');
            return;
          }
        }
        if (cancelled) {
          return;
        }
        let next = sessionsFromList(items);
        if (cancelled) {
          return;
        }
        setSessions(next);
        // restore=true：这是登录态恢复（刷新、深链），不是一次新登录——
        // 自助改密页上刷新留在原页接着改；新登录（openAccount）不传 restore，
        // 落在密码地址一律归位根路径，不认领（死循环的根治）。
        routingRef.current?.claimPath(next, 'restore');
        if (profile) {
          setUsername(profile.username);
          setLocale(profile.locale);
          setAvatarUrl(profile.avatarUrl);
          saveCachedProfile({username: profile.username, locale: profile.locale});
          // 页面恢复时拿到「必须修改密码」标记：进入拦截。
          setMustChangePassword(profile.mustChangePassword);
        }
        setAuth('ready');
      },
      (error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          setAuth('anonymous');
          return;
        }
        if (
          error instanceof ApiError &&
          error.status === 403 &&
          error.code === mustChangePasswordCode
        ) {
          // 被标了「必须修改密码」的账号刷新页面：会话列表请求被拦成 403，
          // 但登录态还有效。直接进入强制修改密码的拦截，不回登录界面——改密、
          // 退出、资料这些入口都在服务器的豁免清单里，拦截期间这些入口照常可用。
          setMustChangePassword(true);
          setAuth('ready');
          return;
        }
        if (connectionFailure(error)) {
          // 接口服务连不上：登录状态还在（cookie 还在），聊天区照常开着，
          // 只在聊天区上方报一次连不上。用户名字和语言用本地记着的那份。
          setComposingNew(true);
          // 离线启动也恢复新对话自己的草稿：刷新不丢。
          setDraft(readDraft(null));
          serviceRef.current?.markService('unreachable');
          setAuth('ready');
          return;
        }
        setLoginOffline(false);
        setLoginDetail(
          explain(error, localeFromSystem(), translations[localeFromSystem()].connectionError),
        );
        setAuth('anonymous');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
}
