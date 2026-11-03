import {X} from 'lucide-react';

export type WarningTone = 'error' | 'warning';

export type WarningItem = {
  id: string;
  tone: WarningTone;
  text: string;
  onDismiss?: () => void;
};

/**
 * 聊天区顶部的警示框。会话级的问题都走这一个：服务降级、这一轮被停止、
 * 操作失败。只有跟某一条消息有关的问题才留在消息流里。
 */
export function WarningBox({
  tone,
  text,
  dismissLabel,
  onDismiss,
}: {
  tone: WarningTone;
  text: string;
  dismissLabel: string;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={tone === 'error' ? 'alert alert-error mb-3' : 'alert alert-warning mb-3'}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="min-w-0 flex-1 wrap-break-word">{text}</span>
      {onDismiss === undefined ? null : (
        <button
          type="button"
          className="btn btn-ghost btn-square btn-xs ml-auto shrink-0"
          aria-label={dismissLabel}
          title={dismissLabel}
          onClick={onDismiss}
        >
          <X aria-hidden="true" size={16} />
        </button>
      )}
    </div>
  );
}
