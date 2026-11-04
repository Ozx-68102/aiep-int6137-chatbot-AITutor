import {CircleAlert, TriangleAlert, X} from 'lucide-react';

export type WarningTone = 'error' | 'warning';

export type WarningAction = {
  label: string;
  onClick: () => void;
};

export type WarningItem = {
  id: string;
  tone: WarningTone;
  text: string;
  onDismiss?: () => void;
  /** 常驻横幅可以带一个动作按钮（比如会话过期的「重新登录」）：中性描边，不用语义色。 */
  action?: WarningAction;
};

/**
 * 输入区分隔线上方的警示框：聊天滚动区与输入区之间的流内兄弟节点，
 * 分隔线固定在输入区顶上不动，警示框出现时压缩滚动区高度、不遮挡内容，
 * 多条纵向堆叠。会话级的问题都走这一个：服务降级、这场对话还有一条正在
 * 回答、停止没停住、操作失败/连不上。轮次级的状态（失败/被停）不在这里，
 * 在气泡下方的脚注里（docs/MESSAGE_ACTIONS.md）。
 *
 * 白底黑字，语气只由左侧图标的颜色表达（全局规则见 docs/UI_WARNINGS.md）。
 */
export function WarningBox({
  tone,
  text,
  dismissLabel,
  onDismiss,
  action,
}: {
  tone: WarningTone;
  text: string;
  dismissLabel: string;
  onDismiss?: () => void;
  action?: WarningAction;
}) {
  return (
    <div className="alert mb-3 bg-base-100" role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'error' ? (
        <CircleAlert className="size-5 shrink-0 text-error" aria-hidden="true" />
      ) : (
        <TriangleAlert className="size-5 shrink-0 text-warning" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 wrap-break-word">{text}</span>
      {action === undefined ? null : (
        <button
          type="button"
          className="btn btn-sm btn-outline btn-neutral ml-auto shrink-0"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
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
