import type {SessionInvalid} from '../../hooks/use-auth-flow.ts';
import type {Messages} from '../../i18n/index.ts';
import type {WarningItem} from './WarningBox.tsx';

/** 会话失效警示条的文案：每个原因配固定的本地化词条；unknown 退回服务器推来的 message。 */
export function sessionInvalidText(invalid: SessionInvalid, text: Messages): string {
  switch (invalid.reason) {
    case 'expired':
      return text.sessionExpired;
    case 'disabled':
      return text.accountDisabled;
    case 'password_changed':
      return text.passwordChanged;
    case 'admin_reset':
      return text.passwordResetByAdmin;
    case 'unknown':
      return invalid.message ?? text.sessionExpired;
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
    // 琥珀的「有状况」语气，可以就地重新登录。白底黑字，语义色只在图标上
    //（docs/UI_WARNINGS.md）。
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
