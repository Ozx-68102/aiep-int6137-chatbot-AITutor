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
  const classes = bubbleClass('error', entering);
  return (
    <div className={classes.wrap}>
      <p className={classes.bubble} onAnimationEnd={onAnimationEnd}>
        {text}
      </p>
      <div className="chat-footer">
        <button type="button" className="btn btn-sm btn-outline btn-error" onClick={onRetry}>
          <RotateCcw className="size-4" aria-hidden="true" />
          {retryLabel}
        </button>
      </div>
    </div>
  );
}
