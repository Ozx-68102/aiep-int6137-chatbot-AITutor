import {X} from 'lucide-react';

export type WarningTone = 'error' | 'warning';

export type WarningItem = {
  id: string;
  tone: WarningTone;
  text: string;
  onDismiss?: () => void;
};

/**
 * 输入区分隔线上方的警示框：聊天滚动区与输入区之间的流内兄弟节点，
 * 分隔线固定在输入区顶上不动，警示框出现时压缩滚动区高度、不遮挡内容，
 * 多条纵向堆叠。会话级的问题都走这一个：服务降级、这场对话还有一条正在
 * 回答、停止没停住、操作失败/连不上。轮次级的状态（失败/被停）不在这里，
 * 在气泡下方的脚注里（docs/MESSAGE_ACTIONS.md）。
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
