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
      className={
        tone === 'error'
          ? 'mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800'
          : 'mb-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900'
      }
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="min-w-0 flex-1 wrap-break-word">{text}</span>
      {onDismiss === undefined ? null : (
        <button
          type="button"
          className="-mr-1 shrink-0 cursor-pointer rounded p-0.5 opacity-60 transition-opacity duration-150 hover:opacity-100"
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
