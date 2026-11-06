import {ApiError} from '../api/http.ts';
import {readPartial} from '../api/partial.ts';
import type {PartialReply} from '../api/partial.ts';

const intervalMs = 500;

/**
 * 服务器确认重新够得着之后广播的 window 事件名：浏览器 online 之后由
 * use-service-status 主动探测 /api/status 成功才派发。进行中的轮询循环收到
 * 它以全新的周期重新开始（见下面的 onNetworkOk）；断线补查（use-turn-engine
 * 的 catchUp）也以它为信号，不再直接监听 online。
 */
export const networkOkEvent = 'h2bot:network-ok';

/**
 * 轮询当前这一轮还在不在写。返回停止函数。
 *
 * 接口只回答「还在写吗」：200 就是还在写（onPartial，status 恒为
 * streaming）；404（服务器明确说没在写，或会话没了）和 401（会话过期）
 * 是终止条件，走 onEnd。401 必须当终止条件：轮着问只会每 500 毫秒
 * 空转一次，输入框一直锁着。网络错继续下一个周期：问不到服务器不等于没在写。
 *
 * onEnd 带上触发终止的那个 ApiError（404/401 都有）：调用方要分开处理
 * 「这一轮没在写了」（按数据库核对并修正）和「会话过期」（统一的 401 出口）。
 *
 * 页面切到后台（document.hidden）时不发请求，光等；回到前台立刻补查一次，
 * 不等下一个周期。服务器确认重新够得着（networkOkEvent）时同理：提前结束
 * 这个周期的等待，倒计时清零，立刻以全新的周期开始。500 毫秒的节奏和
 * 终止语义都不变。
 */
export function startPartialPolling(
  sessionId: string,
  onPartial: (partial: PartialReply) => void,
  onEnd?: (error?: ApiError) => void,
): () => void {
  let stopped = false;
  // waitTick 挂着的唤醒钩子：页面回到可见、或服务器确认重新够得着时，
  // 把等待提前结束，好立刻补查。
  let wake: (() => void) | null = null;

  function onVisibilityChange() {
    if (!document.hidden) {
      wake?.();
    }
  }

  function onNetworkOk() {
    // 服务器刚被确认够得着（online 之后 use-service-status 主动探测
    // /api/status 成功）：与回到可见同款，提前结束这个周期的等待，让循环
    // 立刻以全新的周期开始，而不是把旧的 500 毫秒等完。
    // 不会叠定时器：循环里永远只有一个 waitTick 的定时器；finish 幂等
    // （先清掉自己的定时器、把 wake 置 null 再 resolve），wake 被调多少次
    // 这个周期也只 resolve 一次；唤醒后先发请求，请求回来才创建下一个周期的
    // 定时器，不存在新旧定时器并存的窗口。
    wake?.();
  }

  /** 等一个周期：正常 500 毫秒；页面回到可见或网络确认恢复就提前结束。 */
  function waitTick(): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(finish, intervalMs);
      wake = finish;
      function finish() {
        window.clearTimeout(timer);
        wake = null;
        resolve();
      }
    });
  }

  async function poll() {
    while (!stopped) {
      await waitTick();
      if (stopped) {
        return;
      }
      if (document.hidden) {
        // 页面在后台：跳过这个周期的请求，光等。
        continue;
      }
      let partial: PartialReply;
      try {
        partial = await readPartial(sessionId);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 401)) {
          onEnd?.(error);
          return;
        }
        continue;
      }
      // 200 ⇒ 还在写，接着轮询；终止只从 404/401（onEnd）来。
      onPartial(partial);
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener(networkOkEvent, onNetworkOk);
  void poll();

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener(networkOkEvent, onNetworkOk);
    // 还在等这个周期的话提前放掉，循环立刻走到 stopped 检查退出。
    wake?.();
  };
}
