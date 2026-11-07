import {useEffect, useRef} from 'react';
import {clearAllDrafts} from '../session/drafts.ts';
import {
  avatarCacheKey,
  logoutMarkerKey,
  profileCacheKey,
  readCachedAvatarData,
  readCachedProfile,
} from '../session/profile-cache.ts';
import type {Locale} from '../type/locale.ts';

type MultiTabSyncDeps = {
  /** 登出广播要调的入口走 ref：监听只注册一次，不把它变成效果依赖。 */
  enterLoginGuardedRef: {current: ((detail: string | null) => void) | null};
  setLocale: (locale: Locale) => void;
  setUsername: (username: string) => void;
  setAvatarUrl: (url: string | null) => void;
};

/**
 * 多标签页同步：其他标签页改资料/头像、主动登出，经由 localStorage 的
 * storage 事件当场应用到本页。
 */
export function useMultiTabSync(deps: MultiTabSyncDeps) {
  // 异步流程可能跨渲染：依赖放进 ref，镜像在效果里做（渲染期间写 ref 被禁止）。
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  // 多标签页同步（N12 + P7）：其他标签页改语言/资料、主动登出，都经由
  // localStorage 的 storage 事件当场广播过来，立即应用，不靠轮询。storage
  // 事件只派发给「其他」标签页，写入方自己收不到，所以写了登出标记的
  // 标签页不会被自己二次触发。服务器侧吊销（会话过期、账号停用）不在这
  // 个监听的范围：它不写任何本地标记，仍由本页请求的 401 保底处理
  // （handleAuthError）——两者分工不同。
  useEffect(() => {
    const {enterLoginGuardedRef, setLocale, setUsername, setAvatarUrl} = depsRef.current;
    function onStorage(event: StorageEvent) {
      if (event.key === logoutMarkerKey) {
        // newValue 为 null 是登录方在清墓碑（openAccount），不是登出，不处理。
        if (event.newValue !== null) {
          // 别的标签页主动登出了：login cookie 全浏览器共享，本页的登录态
          // 随之作废，立即进入登录界面路径，不等下一次 401。已经在
          // 留在原页面的过期状态里时横幅挂着、输入锁着，就保持原地（enterLoginGuarded 的
          // 语义），不升级成整页清空。
          // 草稿存在 sessionStorage、按标签页各存各的：登出的那个标签页清不到
          // 这一份，每个标签页听到广播都清自己的（对齐 signOut 里 clearAllDrafts
          // 的「共用电脑不留半截字」）。
          clearAllDrafts();
          enterLoginGuardedRef.current?.(null);
        }
        return;
      }
      if (event.key === profileCacheKey || event.key === avatarCacheKey) {
        if (event.newValue === null) {
          // 清缓存只发生在登出/被强制下线路径：主动登出由上面的登出标记接管，
          // 服务器侧被强制下线照旧靠 401 保底处理。这里不做二次处理，更不会强制跳转页面。
          return;
        }
        const cached = readCachedProfile();
        if (cached !== null) {
          // 别的标签页改了语言或用户名：语言立即换，显示立即刷新。
          setLocale(cached.locale);
          setUsername(cached.username);
        }
        if (event.key === avatarCacheKey) {
          const avatar = readCachedAvatarData();
          if (avatar !== null) {
            setAvatarUrl(avatar);
          }
        }
      }
    }
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);
}
