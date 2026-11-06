import {useEffect, useRef, useState} from 'react';
import {ApiError} from '../api/http.ts';
import {readProfile} from '../api/profile.ts';
import {listSessions, sessionsFromList} from '../api/session.ts';
import {readStatus} from '../api/status.ts';
import {translations} from '../i18n/index.ts';
import {saveCachedProfile} from '../session/profile-cache.ts';
import {networkOkEvent} from '../session/poll.ts';
import type {Session} from '../type/chat.ts';
import type {Locale} from '../type/locale.ts';

const statusIntervalMs = 30000;
// online 之后的确认重试退避：从 1 秒起、每次失败翻倍、封顶 15 秒——
// 确认不通就一直重试，但不会把请求发得太密。
const confirmStartMs = 1000;
const confirmMaxMs = 15000;

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
 * 服务健康状态：30 秒轮询 /api/status，标记连不上/数据库/回复存储三档降级，
 * 以及服务器从「连不上」回来时补齐工作区（refreshWorkspace）的动作。
 *
 * 浏览器的网络事件也接在这里（N10）：offline 立刻挂「无法连接到服务器」
 * 常驻横幅，不用等最坏 30 秒的下一个周期；online 不轻信（网卡通了不代表
 * 服务器够得着），主动探测 /api/status 确认，失败按 1s/2s/4s…封顶 15s
 * 指数退避重试。确认通过之后常规轮询的倒计时清零重新开始，并广播
 * networkOkEvent 唤醒进行中的半截回答轮询（src/session/poll.ts）和断线
 * 补查（use-turn-engine 的 catchUp），让它们也立刻以全新的周期开始。
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
    // 常规周期的定时器：同一时刻只存在这一个（confirm 成功分支先清再重新设置）。
    let timer = 0;
    // online 确认循环的退避定时器、进行中标记和世代编号。确认循环正在进行时，常规
    // 周期与可见性补查都让路：同一时刻只有一条探测链在请求 /api/status，
    // 不会双份探测互相冲突。世代编号用来作废旧的确认循环：offline 或新的 online 都把世代编号
    // 加一，旧的确认循环的进行中探测回来后发现世代编号不匹配就退出，不会再设置自己的
    // 退避定时器——不会出现两条确认循环并存。
    let retryTimer = 0;
    let confirming = false;
    let confirmGeneration = 0;
    let backoffMs = confirmStartMs;

    /**
     * 探测一次 /api/status，返回服务器是否够得着；顺带按响应设好降级档位，
     * 并在从「连不上」回到够得着的第一时间补齐工作区（refreshWorkspace）。
     */
    const probe = async (): Promise<boolean> => {
      try {
        const status = await readStatus();
        if (stopped) {
          return true;
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
        return true;
      } catch {
        if (!stopped) {
          markService('unreachable');
        }
        return false;
      }
    };

    const check = async () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      await probe();
    };

    const tick = async () => {
      // 确认循环正在进行（online 后的退避重试期间）：这个周期不探测，只把定时器排到下一个周期。
      // 确认成功后定时器会被整个清零后重新设置（见 confirm），不会剩半个周期在这等。
      if (!confirming) {
        await check();
      }
      if (!stopped) {
        timer = window.setTimeout(tick, statusIntervalMs);
      }
    };

    /**
     * online 之后的确认循环：探测成功 → 横幅撤下（probe 已按响应切档位、
     * 补工作区）、常规轮询倒计时清零重新开始、广播 networkOkEvent；
     * 探测失败 → 横幅留着，按 1s/2s/4s…封顶 15s 指数退避重试。
     */
    const confirm = async (generation: number) => {
      if (stopped || generation !== confirmGeneration) {
        // 效果已清理，或这条链已被 offline/新的 online 作废。
        return;
      }
      if (!navigator.onLine) {
        // 物理网络又断了：探测必然失败，不白白发请求，等下一次 online 事件
        // 重新启动确认。
        confirming = false;
        return;
      }
      const ok = await probe();
      if (stopped || generation !== confirmGeneration) {
        return;
      }
      if (!ok) {
        retryTimer = window.setTimeout(() => {
          void confirm(generation);
        }, backoffMs);
        backoffMs = Math.min(backoffMs * 2, confirmMaxMs);
        return;
      }
      confirming = false;
      backoffMs = confirmStartMs;
      // 常规轮询的倒计时清零重新开始：先清掉旧定时器再同步设置一个全新的
      // 完整周期。两行之间没有异步间隙，任何时刻都只有这一个 30 秒定时器，
      // 不存在新旧定时器并存、同一个周期被探测两次的窗口。
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, statusIntervalMs);
      // 唤醒进行中的半截回答轮询（src/session/poll.ts）和断线补查
      // （use-turn-engine）：让它们也立刻以全新的周期开始，不等各自的旧定时器。
      window.dispatchEvent(new Event(networkOkEvent));
    };

    const onOffline = () => {
      // 物理断网：立刻挂常驻横幅，不等最坏 30 秒的下一个周期。
      markService('unreachable');
      // 作废进行中/等待中的确认链：断网期间不发必然失败的请求，等 online 重来。
      confirmGeneration += 1;
      window.clearTimeout(retryTimer);
      confirming = false;
    };

    const onOnline = () => {
      // 浏览器报的 online 不轻信：网卡通了不代表服务器够得着，主动探测确认。
      // 已有确认循环正在进行就不开第二条（它的世代编号仍是当前值，继续跑）。
      if (confirming) {
        return;
      }
      confirming = true;
      backoffMs = confirmStartMs;
      confirmGeneration += 1;
      void confirm(confirmGeneration);
    };

    const onVisibility = () => {
      // 确认循环正在进行时让路给它，避免双份补查互相冲突。
      if (document.visibilityState === 'visible' && !confirming) {
        void check();
      }
    };

    void tick();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      stopped = true;
      confirmGeneration += 1;
      window.clearTimeout(timer);
      window.clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [auth]);

  return {serviceState, markService, showConnectionWarning};
}
