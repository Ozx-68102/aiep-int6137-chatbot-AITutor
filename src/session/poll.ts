import {ApiError} from '../api/http.ts';
import {readPartial} from '../api/partial.ts';
import type {PartialReply} from '../api/partial.ts';

const intervalMs = 500;

export function startPartialPolling(
  sessionId: string,
  onPartial: (partial: PartialReply) => void,
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
        if (error instanceof ApiError && error.status === 404) {
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
