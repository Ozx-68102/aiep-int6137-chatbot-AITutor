/**
 * Turnstile 脚本（index.html 里异步加载）注入的 window.turnstile 对象的
 * 最小类型声明：只收录本项目用到的四个方法，不求覆盖完整 API。脚本还没
 * 加载完时 window.turnstile 是 undefined，等待和渲染在 use-turnstile.ts。
 */

export type TurnstileRenderOptions = {
  sitekey: string;
  /** 所在界面的约定 action 值（比如 login）；后端按 siteverify 的返回核对。 */
  action?: string;
  /** widget 拿到令牌时回调。 */
  callback?: (token: string) => void;
  /** 令牌过期时回调；调用方应把令牌视为不可用。 */
  'expired-callback'?: () => void;
  /** widget 出错（比如当前域名没登记在 widget 上）时回调。 */
  'error-callback'?: () => void;
};

export type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  getResponse: (widgetId: string) => string | undefined;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}
