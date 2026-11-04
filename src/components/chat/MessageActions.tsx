import {CircleAlert, CircleStop, RotateCcw} from 'lucide-react';
import type {Message} from '../../type/chat.ts';

/**
 * 气泡下方的脚注：常驻矮条，固定预留一小段高度——hover 型按钮出现时布局不跳动。
 * hover 触发区 = 气泡本身 + 脚注区域：调用方把两者放进同一个 .group，
 * hover 型按钮用 group-hover 淡入。
 *
 * 第一期（docs/MESSAGE_ACTIONS.md）只有常驻内容：坏掉的轮次（failed / aborted）
 * 的状态提示和重试按钮，始终可见、不可关闭——坏掉的轮次必须始终留着恢复的入口。
 * hover 区暂时是空的：编辑按钮第三期进、复制/点赞点踩第四期进。
 * 流式输出中的等待气泡（三个点）不挂脚注。
 */
export function MessageActions({
  message,
  failedText,
  stoppedText,
  retryLabel,
  entering = false,
  onRetry,
  onAnimationEnd,
}: {
  message: Message;
  /** 失败轮的状态提示文字（i18n replyInterrupted，「消息生成失败」）。 */
  failedText: string;
  /** 被停轮的状态提示文字（i18n replyStopped，「对话已停止」）。 */
  stoppedText: string;
  retryLabel: string;
  entering?: boolean;
  onRetry: (turnId: string) => void;
  onAnimationEnd?: () => void;
}) {
  const failed = message.failed === true;
  const stopped = message.aborted === true;
  return (
    <div className="chat-footer min-h-8" onAnimationEnd={onAnimationEnd}>
      {failed || stopped ? (
        <div
          className={
            entering
              ? 'flex animate-in items-center gap-2 fade-in duration-200'
              : 'flex items-center gap-2'
          }
        >
          {failed ? (
            <CircleAlert className="size-4 shrink-0 text-amber-500" aria-hidden="true" />
          ) : (
            <CircleStop className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="text-sm text-stone-500">{failed ? failedText : stoppedText}</span>
          <button
            type="button"
            className="btn btn-sm btn-outline btn-neutral"
            onClick={() => onRetry(message.turnId ?? '')}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            {retryLabel}
          </button>
        </div>
      ) : null}
      {/* hover 区：第一期是空的。编辑（第三期）、复制/点赞点踩（第四期）进这里，
          group-hover 淡入（触发区 = 气泡 + 脚注）。 */}
    </div>
  );
}
