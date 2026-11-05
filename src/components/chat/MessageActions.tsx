import {
  Check,
  CircleAlert,
  CircleStop,
  Copy,
  Pencil,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import type {FeedbackValue} from '../../api/feedback.ts';
import type {Message} from '../../type/chat.ts';

/**
 * 气泡下方的脚注：常驻矮条，固定预留一小段高度——hover 型按钮出现时布局不跳动。
 * hover 触发区 = 气泡本身 + 脚注区域：调用方把两者放进同一个 .group，
 * hover 型按钮用 group-hover 淡入。
 *
 * 常驻内容：坏掉的轮次（failed / aborted）的状态提示和重试按钮，始终可见、
 * 不可关闭——坏掉的轮次必须始终留着恢复的入口。
 * hover 区：编辑（只给最后一轮用户提问，第三期）、复制、点赞点踩（第四期，
 * docs/MESSAGE_ACTIONS.md 内容矩阵）。流式输出中的等待气泡（三个点）不挂脚注。
 *
 * 点赞点踩的状态是会话内组件级状态，不跨刷新持久：设计文档没要求持久化，
 * 上游也没有「读回我这一轮反馈」的接口给我们，刷新后按钮回到未选的样子
 * （上游那边其实记着）。
 */
export function MessageActions({
  message,
  failedText,
  stoppedText,
  retryLabel,
  entering = false,
  retryBusy = false,
  onRetry,
  onAnimationEnd,
  canEdit = false,
  editLabel,
  onEdit,
  copyLabel,
  copiedLabel,
  canFeedback = false,
  likeLabel,
  dislikeLabel,
  onFeedback,
}: {
  message: Message;
  /** 失败轮的状态提示文字（i18n replyInterrupted，「消息生成失败」）。 */
  failedText: string;
  /** 被停轮的状态提示文字（i18n replyStopped，「对话已停止」）。 */
  stoppedText: string;
  retryLabel: string;
  entering?: boolean;
  /** 会话有一轮在飞（pending）：重试按钮一律禁用——服务器同一场会话只跑一轮，再点只会撞 409。 */
  retryBusy?: boolean;
  onRetry: (turnId: string) => void;
  onAnimationEnd?: () => void;
  /** 编辑按钮：只出现在最后一轮的用户提问下（docs/MESSAGE_ACTIONS.md 第三期）。 */
  canEdit?: boolean;
  /** 「编辑」popover 的文字（i18n edit）。 */
  editLabel?: string;
  onEdit?: () => void;
  /** 复制按钮的文字（i18n copy / copied）。 */
  copyLabel: string;
  copiedLabel: string;
  /** 环境是否允许点赞点踩（流式输出期间调用方给 false）。 */
  canFeedback?: boolean;
  /** 「点赞」的文字（i18n like）。 */
  likeLabel?: string;
  /** 「点踩」的文字（i18n dislike）。 */
  dislikeLabel?: string;
  /** 发送一次点赞/点踩，返回成没成。失败时本组件把按钮状态回退。 */
  onFeedback?: (turnId: string, feedback: FeedbackValue) => Promise<boolean>;
}) {
  const failed = message.failed === true;
  const stopped = message.aborted === true;
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackValue>(null);
  const copyTimer = useRef<number | null>(null);
  // 一次只允许一个在飞的反馈请求：请求期间再点忽略，避免回退互相覆盖。
  const votingRef = useRef(false);
  // 重试按钮的本地加载态（P8）：点击立即转圈/禁用，防止连点被 sendingRef
  // 静默吞掉、看着像没点上。正常情况下这条气泡马上被重试流程移除，组件
  // 自然卸载；引擎没接（比如找不到提问原文直接拒绝）时靠下面的兜底还原。
  const [retryClicked, setRetryClicked] = useState(false);
  useEffect(() => {
    if (!retryClicked) {
      return;
    }
    const timer = window.setTimeout(() => {
      setRetryClicked(false);
    }, 2000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [retryClicked]);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
    },
    [],
  );
  // 复制：用户提问（最后一轮和更早轮都有）复制纯文本，助手正常轮复制
  // message.text 原始 Markdown（不序列化 DOM——复制渲染结果会把表格、
  // 公式的排版带走）。失败/被停轮不出 hover 区（内容矩阵）。
  const canCopy = message.role === 'user' || (!failed && !stopped);
  // 点赞点踩只在助手气泡、正常轮（failed/aborted 不显示——没答完的东西
  // 没什么可评价）、且 message.turnId 非空时显示：从上游回填的老会话消息
  // 没有我们的轮次编号，映射不到上游的 dataId（responseChatItemId 那条），
  // 发过去也是打空——干脆不出按钮。
  const showFeedback =
    canFeedback &&
    onFeedback !== undefined &&
    message.role === 'assistant' &&
    !failed &&
    !stopped &&
    message.turnId !== undefined;
  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message.text);
    } catch {
      // clipboard 不可用/没权限时静默失败（本部署 https/localhost，正常可用）。
      return;
    }
    setCopied(true);
    if (copyTimer.current !== null) {
      window.clearTimeout(copyTimer.current);
    }
    // 1.5 秒后还原：icon 和文字都回到「复制」。
    copyTimer.current = window.setTimeout(() => {
      setCopied(false);
    }, 1500);
  }
  async function vote(next: 'good' | 'bad') {
    if (onFeedback === undefined || message.turnId === undefined || votingRef.current) {
      return;
    }
    const previous = feedback;
    // 当前激活的再点一次发送 null：取消这条反馈（上游语义「不传就删」）。
    const request: FeedbackValue = feedback === next ? null : next;
    votingRef.current = true;
    setFeedback(request);
    try {
      const sent = await onFeedback(message.turnId, request);
      if (!sent) {
        // 请求失败（actionFailed 的提示由调用方进横幅）：状态回退。
        setFeedback(previous);
      }
    } finally {
      votingRef.current = false;
    }
  }
  const showHoverRow = (canEdit && onEdit !== undefined) || canCopy || showFeedback;
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
            disabled={retryBusy || retryClicked}
            onClick={() => {
              setRetryClicked(true);
              onRetry(message.turnId ?? '');
            }}
          >
            {retryClicked ? (
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : (
              <RotateCcw className="size-4" aria-hidden="true" />
            )}
            {retryLabel}
          </button>
        </div>
      ) : null}
      {/* hover 区：触发区 = 气泡 + 脚注（调用方的 .group），按钮淡入。 */}
      {showHoverRow ? (
        <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          {canEdit && onEdit !== undefined ? (
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
          ) : null}
          {canCopy ? (
            <div className="tooltip tooltip-bottom" data-tip={copied ? copiedLabel : copyLabel}>
              <button
                type="button"
                className="btn btn-ghost btn-square btn-xs"
                aria-label={copied ? copiedLabel : copyLabel}
                onClick={() => {
                  void copyMessage();
                }}
              >
                {copied ? (
                  <Check className="size-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="size-3.5" aria-hidden="true" />
                )}
              </button>
            </div>
          ) : null}
          {showFeedback ? (
            <>
              <div className="tooltip tooltip-bottom" data-tip={likeLabel}>
                <button
                  type="button"
                  className={
                    feedback === 'good'
                      ? 'btn btn-ghost btn-square btn-xs btn-active'
                      : 'btn btn-ghost btn-square btn-xs'
                  }
                  aria-label={likeLabel}
                  aria-pressed={feedback === 'good'}
                  onClick={() => {
                    void vote('good');
                  }}
                >
                  <ThumbsUp className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <div className="tooltip tooltip-bottom" data-tip={dislikeLabel}>
                <button
                  type="button"
                  className={
                    feedback === 'bad'
                      ? 'btn btn-ghost btn-square btn-xs btn-active'
                      : 'btn btn-ghost btn-square btn-xs'
                  }
                  aria-label={dislikeLabel}
                  aria-pressed={feedback === 'bad'}
                  onClick={() => {
                    void vote('bad');
                  }}
                >
                  <ThumbsDown className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
