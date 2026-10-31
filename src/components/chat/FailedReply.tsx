import {RotateCcw} from 'lucide-react';
import {bubbleClass} from './message-class.ts';

/**
 * 一轮回答失败以后，页面上是这两样：失败的原因，和一个重发按钮。
 * 重发的是同一句提问，服务器会把上一轮留下的记录删掉。
 */
export function FailedReply({
  text,
  retryLabel,
  entering,
  onRetry,
  onAnimationEnd,
}: {
  text: string;
  retryLabel: string;
  entering: boolean;
  onRetry: () => void;
  onAnimationEnd: () => void;
}) {
  return (
    <div className="mb-3 w-fit max-w-[600px]">
      <p className={bubbleClass('error', entering)} onAnimationEnd={onAnimationEnd}>
        {text}
      </p>
      <button
        type="button"
        className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-sm transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20"
        onClick={onRetry}
      >
        <RotateCcw className="size-4" aria-hidden="true" />
        {retryLabel}
      </button>
    </div>
  );
}
