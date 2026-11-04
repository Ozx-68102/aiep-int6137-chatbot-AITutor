import {ApiError} from '../api/http.ts';
import {readPartial} from '../api/partial.ts';
import type {PartialReply} from '../api/partial.ts';

const intervalMs = 500;

/**
 * 轮询当前这一轮的半截回答。返回停止函数。
 *
 * 三种终止：状态不再是 streaming（这一轮落定了）、404（会话没了）、
 * 401（会话过期）。前一种走 onPartial；后两种走 onEnd。
 * 401 必须当终止条件：轮着问只会每 500 毫秒空转一次，输入框一直锁着。
 *
 * 页面切到后台（document.hidden）时不发请求，光等；回到前台立刻补查一次，
 * 不等下一拍。500 毫秒的节奏和终止语义都不变。
 */
export function startPartialPolling(
  sessionId: string,
  onPartial: (partial: PartialReply) => void,
  onEnd?: () => void,
): () => void {
  let stopped = false;
  // waitTick 挂着的唤醒钩子：页面回到可见时把等待提前结束，好立刻补查。
  let wake: (() => void) | null = null;

  function onVisibilityChange() {
    if (!document.hidden) {
      wake?.();
    }
  }

  /** 等一拍：正常 500 毫秒；页面回到可见就提前结束。 */
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
        // 页面在后台：跳过这一拍的请求，光等。
        continue;
      }
      let partial: PartialReply;
      try {
        partial = await readPartial(sessionId);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 401)) {
          onEnd?.();
          return;
        }
        continue;
      }
      onPartial(partial);
      if (partial.status !== 'streaming') {
        return;
      }
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  void poll();

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    // 还在等这一拍的话提前放掉，循环立刻走到 stopped 检查退出。
    wake?.();
  };
}
