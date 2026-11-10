import type {SessionInvalid} from '../../hooks/use-auth-flow.ts';
import type {Messages} from '../../i18n/index.ts';
import type {WarningItem} from './WarningBox.tsx';

/**
 * 会话失效警示条的文案（2026-11 维护者决定统一）：凭证被注销的原因不进
 * 横幅——expired、password_changed、admin_reset 一律「会话已过期，请重新
 * 登录」；「为什么被强制下线」的解释归强制改密页的横幅（被重置的账号重新登录就
 * 会撞见它，那里说「这个账号的密码是别人设置的」）。disabled 是终态，保留
 * 自己的文案；unknown 退回服务器推来的 message（缺失再退会话过期）。
 */
export function sessionInvalidText(invalid: SessionInvalid, text: Messages): string {
  switch (invalid.reason) {
    case 'disabled':
      return text.accountDisabled;
    case 'unknown':
      return invalid.message ?? text.sessionExpired;
    case 'expired':
    case 'password_changed':
    case 'admin_reset':
    default:
      return text.sessionExpired;
  }
}

/**
 * 组装输入区分隔线上方警示框的条目列表（聊天滚动区与输入区之间的流内节点）：
 * 会话失效常驻条、服务状态、操作出错、单场会话的可关提示。
 * onRelogin / onDismissSessionWarning 由调用方给（警示条上的按钮动作）。
 */
export function warningsFor({
  sessionInvalid,
  serviceNotice,
  notice,
  sessionWarning,
  activeId,
  text,
  onRelogin,
  onDismissSessionWarning,
}: {
  sessionInvalid: SessionInvalid | null;
  serviceNotice: string | null;
  notice: string | null;
  /** 单场会话的可关提示（engine.sessionWarning）：带所属会话 id。 */
  sessionWarning: {sessionId: string; text: string} | null;
  /** 当前打开的会话 id（active?.id）：提示只在自己的会话里显示。 */
  activeId: string | undefined;
  text: Messages;
  onRelogin: () => void;
  onDismissSessionWarning: () => void;
}): WarningItem[] {
  const warnings: WarningItem[] = [];
  if (sessionInvalid !== null) {
    // 会话失效的常驻警示条，不可关闭：disabled 用红色出错语气（终态，登录也
    // 没用，不给按钮）；其余原因（含推送来的密码已修改、被管理员重置）都是
    // 琥珀的「有状况」语气，可以就地重新登录，文案统一「会话已过期」（见
    // sessionInvalidText）。白底黑字，语义色只在图标上（docs/UI_WARNINGS.md）。
    const terminal = sessionInvalid.reason === 'disabled';
    warnings.push({
      id: 'session-invalid',
      tone: terminal ? 'error' : 'warning',
      text: sessionInvalidText(sessionInvalid, text),
      ...(terminal
        ? {}
        : {
            action: {
              label: text.logInAgain,
              onClick: () => {
                onRelogin();
              },
            },
          }),
    });
  }
  if (serviceNotice !== null) {
    warnings.push({id: 'service', tone: 'warning', text: serviceNotice});
  }
  if (notice !== null) {
    warnings.push({id: 'notice', tone: 'error', text: notice});
  }
  if (sessionWarning !== null && sessionWarning.sessionId === activeId) {
    warnings.push({
      id: 'session',
      tone: 'warning',
      text: sessionWarning.text,
      onDismiss: () => {
        onDismissSessionWarning();
      },
    });
  }
  return warnings;
}
