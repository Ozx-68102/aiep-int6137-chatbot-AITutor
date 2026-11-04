import {CircleAlert, CircleStop, Pencil, RotateCcw} from 'lucide-react';
import type {Message} from '../../type/chat.ts';

/**
 * 气泡下方的脚注：常驻矮条，固定预留一小段高度——hover 型按钮出现时布局不跳动。
 * hover 触发区 = 气泡本身 + 脚注区域：调用方把两者放进同一个 .group，
 * hover 型按钮用 group-hover 淡入。
 *
 * 常驻内容：坏掉的轮次（failed / aborted）的状态提示和重试按钮，始终可见、
 * 不可关闭——坏掉的轮次必须始终留着恢复的入口。
 * hover 区：最后一轮用户提问上的编辑按钮（group-hover 淡入）；复制/点赞点踩
 * 第四期进驻。流式输出中的等待气泡（三个点）不挂脚注。
 */
export function MessageActions({
  message,
  failedText,
  stoppedText,
  retryLabel,
  entering = false,
  onRetry,
  onAnimationEnd,
  canEdit = false,
  editLabel,
  onEdit,
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
  /** 编辑按钮：只出现在最后一轮的用户提问下（docs/MESSAGE_ACTIONS.md 第三期）。 */
  canEdit?: boolean;
  /** 「编辑」popover 的文字（i18n edit）。 */
  editLabel?: string;
  onEdit?: () => void;
}) {
  const failed = message.failed === true;
  const stopped = message.aborted === true;
  return (
    <div className="chat-footer mt-2 flex min-h-8 flex-col gap-1" onAnimationEnd={onAnimationEnd}>
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
      {/* hover 区：触发区 = 气泡 + 脚注（调用方的 .group），按钮淡入。
          复制/点赞点踩（第四期）也进这里。 */}
      {canEdit && onEdit !== undefined ? (
        <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          <div className="tooltip tooltip-bottom" data-tip={editLabel}>
            <button
              type="button"
              className="btn btn-ghost btn-square btn-xs"
              aria-label={editLabel}
              onClick={onEdit}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
