import {type RefObject, useEffect, useRef, useState} from 'react';

/**
 * Turnstile widget 的接线：显式渲染、保留 widget ID、每次登录尝试结束后
 * reset 换一个新令牌（令牌一次性），组件卸载时移除 widget。学生登录和
 * 控制台登录两个表单各挂一个实例，action 值与后端约定一致
 *（server/src/server/turnstile.py）。
 *
 * 挂载容器的 ref 由调用方建好传进来，不随返回值流出：ref 混进渲染期间
 * 读取的值里，React Compiler 的 lint 会按「渲染中读 ref」拦下整个组件。
 *
 * sitekey 是公开信息（随页面源码下发），写成常量不违反「密钥只放 .env」
 * 的规矩——那条说的是 secret key，只在服务端 siteverify 时使用。
 */
export const TURNSTILE_SITEKEY = '0x4AAAAAAF3s6UAHLQBINHTO';

/** 等待脚本加载的轮询间隔与上限：脚本是异步的，挂载时 window.turnstile 可能还没就绪。 */
const scriptPollMs = 50;
const scriptPollLimit = 400;

export type TurnstileWidget = {
  /** 当前可用的令牌；widget 未就绪或还没通过验证时是 null。 */
  token: string | null;
  /** 作废当前令牌并让 widget 重新出验证（每次提交尝试结束后调用）。 */
  reset: () => void;
};

export function useTurnstile(
  action: string,
  containerRef: RefObject<HTMLDivElement | null>,
): TurnstileWidget {
  const widgetIdRef = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let polls = 0;
    let timer: number | undefined;

    function renderWidget() {
      const turnstile = window.turnstile;
      const container = containerRef.current;
      if (cancelled || turnstile === undefined || container === null) {
        return;
      }
      widgetIdRef.current = turnstile.render(container, {
        sitekey: TURNSTILE_SITEKEY,
        action,
        callback: (value) => {
          if (!cancelled) {
            setToken(value);
          }
        },
        'expired-callback': () => {
          if (!cancelled) {
            setToken(null);
          }
        },
        'error-callback': () => {
          if (!cancelled) {
            setToken(null);
          }
        },
      });
    }

    if (window.turnstile !== undefined) {
      renderWidget();
    } else {
      timer = window.setInterval(() => {
        polls += 1;
        if (window.turnstile !== undefined) {
          if (timer !== undefined) {
            window.clearInterval(timer);
            timer = undefined;
          }
          renderWidget();
        } else if (polls >= scriptPollLimit) {
          // 脚本一直加载不出来（断网或被拦截）：保持关闭，token 一直是
          // null，登录按钮持续禁用。登录界面自己的离线提示另行显示。
          if (timer !== undefined) {
            window.clearInterval(timer);
            timer = undefined;
          }
        }
      }, scriptPollMs);
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
      const turnstile = window.turnstile;
      const widgetId = widgetIdRef.current;
      if (turnstile !== undefined && widgetId !== null) {
        turnstile.remove(widgetId);
      }
      widgetIdRef.current = null;
    };
  }, [action, containerRef]);

  function reset() {
    setToken(null);
    const turnstile = window.turnstile;
    const widgetId = widgetIdRef.current;
    if (turnstile !== undefined && widgetId !== null) {
      turnstile.reset(widgetId);
    }
  }

  return {token, reset};
}
