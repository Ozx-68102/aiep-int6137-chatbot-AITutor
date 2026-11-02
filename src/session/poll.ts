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
 */
export function startPartialPolling(
  sessionId: string,
  onPartial: (partial: PartialReply) => void,
  onEnd?: () => void,
): () => void {
  let stopped = false;

  async function poll() {
    while (!stopped) {
      await wait(intervalMs);
      if (stopped) {
        return;
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

  void poll();

  return () => {
    stopped = true;
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
