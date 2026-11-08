import {type RefObject, useEffect, useRef} from 'react';

/**
 * Turnstile widget 的接线：点「登录」才渲染（显式渲染可以在任意时刻调用），
 * 平时不显示。失败或成功的现场都原地保留，用户改动用户名或密码时才移除
 * （hide）；下一次点击重新渲染一个全新的 widget、跑一轮全新验证——令牌
 * 一次性，旧 widget 不论成败都不能复用。学生登录和控制台登录两个表单各挂
 * 一个实例，action 值与后端约定一致（server/src/server/turnstile.py）。
 *
 * 挂载容器的 ref 由调用方建好传进来，不随返回值流出：ref 混进渲染期间
 * 读取的值里，React Compiler 的 lint 会按「渲染中读 ref」拦下整个组件。
 * 这个 hook 也因此不带任何 React 状态：控制器只有 start/hide 两个命令式
 * 动作，界面由表单自己的 working/locked 状态驱动。
 *
 * sitekey 是公开信息（随页面源码下发），写成常量不违反「密钥只放 .env」
 * 的规矩——那条说的是 secret key，只在服务端 siteverify 时使用。
 */
export const TURNSTILE_SITEKEY = '0x4AAAAAAF3s6UAHLQBINHTO';

/** 点击后等待脚本的轮询间隔与上限：脚本从打开页面起就在异步加载，正常
 * 点不到它没就绪的时候；等到上限（10 秒）还没就绪，按连不上验证服务处理。 */
const scriptPollMs = 50;
const scriptPollLimit = 200;

export type TurnstileStartHandlers = {
  /** 验证通过、拿到令牌：表单应立即拿它提交登录（令牌 300 秒过期、一次性）。 */
  onToken: (token: string) => void;
  /** 验证没通过。reason 为 'verify'：挑战出错/超时/令牌过期，widget 留在
   * 失败现场；'script'：点击后等脚本超时，widget 根本没出现，按连接类失败处理。 */
  onFailed: (reason: 'verify' | 'script') => void;
};

export type TurnstileController = {
  /** 点「登录」时调用：移除旧 widget，必要时等脚本，然后渲染全新 widget 开始验证。 */
  start: (handlers: TurnstileStartHandlers) => void;
  /** 用户名或密码变动时调用：移除 widget、取消没完成的等待，回到「没出现过」的状态。 */
  hide: () => void;
};

export function useTurnstile(
  action: string,
  containerRef: RefObject<HTMLDivElement | null>,
): TurnstileController {
  const widgetIdRef = useRef<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  function stopTimer() {
    if (timerRef.current !== undefined) {
      window.clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
  }

  function removeWidget() {
    stopTimer();
    const turnstile = window.turnstile;
    if (turnstile !== undefined && widgetIdRef.current !== null) {
      turnstile.remove(widgetIdRef.current);
    }
    widgetIdRef.current = null;
  }

  function start(handlers: TurnstileStartHandlers) {
    removeWidget();

    function tryRender(): boolean {
      const turnstile = window.turnstile;
      const container = containerRef.current;
      if (turnstile === undefined || container === null) {
        return false;
      }
      widgetIdRef.current = turnstile.render(container, {
        sitekey: TURNSTILE_SITEKEY,
        action,
        callback: (token) => {
          handlers.onToken(token);
        },
        // 三种「没通过」一个待遇：现场留着，表单锁按钮，改动用户名或密码
        // 才移除现场。retry 用默认值 auto：临时性故障由 widget 自己先重试，
        // 重试耗尽才轮到 error-callback。
        'expired-callback': () => {
          handlers.onFailed('verify');
        },
        'error-callback': () => {
          handlers.onFailed('verify');
        },
        'timeout-callback': () => {
          handlers.onFailed('verify');
        },
      });
      return true;
    }

    if (tryRender()) {
      return;
    }
    let polls = 0;
    timerRef.current = window.setInterval(() => {
      polls += 1;
      if (tryRender()) {
        stopTimer();
        return;
      }
      if (polls >= scriptPollLimit) {
        stopTimer();
        handlers.onFailed('script');
      }
    }, scriptPollMs);
  }

  // 卸载时的清理：逻辑与 removeWidget 相同，但必须内联写——effect 的清理
  // 函数引用组件体里的函数会被依赖收集盯上，效果变成每次渲染都重跑。
  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) {
        window.clearInterval(timerRef.current);
        timerRef.current = undefined;
      }
      const turnstile = window.turnstile;
      if (turnstile !== undefined && widgetIdRef.current !== null) {
        turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
    };
  }, []);

  return {start, hide: removeWidget};
}
