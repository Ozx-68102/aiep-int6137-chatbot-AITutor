import {CircleAlert, TriangleAlert} from 'lucide-react';
import {useState} from 'react';
import {format, translations} from '../../i18n/index.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {PasswordStrength} from './PasswordStrength.tsx';
import {allowedChars, MAX_PASSWORD_LENGTH, passwordRejected} from './password-strength.ts';

/** 聊天侧（学生）账号的密码最小长度：跟后端 min_length_for_role('chat') 同一道门槛。 */
const MIN_PASSWORD_LENGTH = 6;

/**
 * 修改密码，独立的一页，不是弹窗：弹窗点一下背景就关，密码输一半全丢
 * （密码框的内容也不进草稿缓存，救不回来）。页面没有背景可误点，
 * 离开只有「取消」按钮这一条显式的路。
 *
 * 组件随页面切换整个卸载后重新挂载，三个输入框天然清空，不用手写清理逻辑。
 *
 * 强制模式（forced）：账号被服务器标了「必须修改密码」时由 App.tsx 的拦截
 * 渲染——顶部挂一条说明横幅解释为什么被拦，其余与普通模式完全一样。
 * 「取消」两种模式都有，含义不同：普通模式返回来路；强制模式是放弃这次
 * 登录（被标记的登录不算登录成功，见 use-auth-flow 的 cancelGatedLogin），
 * 具体动作由调用方传入的 onCancel 决定。
 */
export function ChangePasswordPage({
  locale,
  username,
  error,
  busy,
  onSubmit,
  onCancel,
  forced = false,
}: {
  locale: Locale;
  username: string | null;
  error: string | null;
  busy: boolean;
  onSubmit: (oldPassword: string, newPassword: string, confirmPassword: string) => Promise<void>;
  onCancel?: (() => void) | undefined;
  /** 强制模式：顶部挂说明横幅；「取消」＝放弃这次登录，由调用方的 onCancel 给。 */
  forced?: boolean | undefined;
}) {
  const text = translations[locale];
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [gateError, setGateError] = useState<string | null>(null);
  const blocked = busy || oldPassword === '' || newPassword === '' || confirmPassword === '';
  // 门槛错误优先于可能残留的服务端错误：它是最近一次提交尝试的结果。
  const shownError = gateError ?? error;
  // 门槛错误和连接保底文案都是本地三语文案，按界面语言标注；其余的服务端
  // 消息（detail）固定是简体中文，标 zh-Hans 让浏览器按中文字体渲染。
  const localizedError = shownError === gateError || shownError === text.connectionError;
  const shownErrorLang = localizedError ? htmlLang[locale] : 'zh-Hans';

  return (
    <main className="flex h-full items-center justify-center bg-base-200 px-4">
      <form
        className="card w-full max-w-sm border border-base-300 bg-base-100"
        onSubmit={(event) => {
          event.preventDefault();
          // busy 时按钮已经禁用，这里再挡一道，防双击。
          if (blocked) {
            return;
          }
          // 客户端硬门槛：本地就能判定的拒绝，不发请求；文案按语言本地化。
          const rejected = passwordRejected(newPassword, MIN_PASSWORD_LENGTH);
          if (rejected === 'tooShort') {
            setGateError(
              format(text.passwordTooShort, {min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH}),
            );
            return;
          }
          if (rejected === 'tooCommon') {
            setGateError(text.passwordTooCommon);
            return;
          }
          setGateError(null);
          void onSubmit(oldPassword, newPassword, confirmPassword);
        }}
      >
        <div className="card-body gap-4">
          <h1 className="card-title" lang={htmlLang[locale]}>
            {text.changePassword}
          </h1>
          {forced ? (
            // 强制模式的说明横幅：说清楚为什么被拦在这里。白底黑字，
            // 语义色只在图标上（docs/UI_WARNINGS.md）。
            <div className="alert bg-base-100" role="status">
              <TriangleAlert className="size-5 shrink-0 text-warning" aria-hidden="true" />
              <span className="min-w-0 flex-1 wrap-break-word" lang={htmlLang[locale]}>
                {text.mustChangePasswordNotice}
              </span>
            </div>
          ) : null}
          <label className="fieldset">
            <span className="fieldset-label">{text.oldPassword}</span>
            <input
              className="input w-full"
              name="old-password"
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(event) => setOldPassword(allowedChars(event.target.value))}
            />
          </label>
          <fieldset className="fieldset gap-2">
            <label className="fieldset">
              <span className="fieldset-label">{text.newPassword}</span>
              <input
                className="input w-full"
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(allowedChars(event.target.value))}
              />
            </label>
            <p className="m-0 text-xs text-stone-500" lang={htmlLang[locale]}>
              {text.passwordHint}
            </p>
            <PasswordStrength locale={locale} password={newPassword} username={username} />
          </fieldset>
          <label className="fieldset">
            <span className="fieldset-label">{text.confirmPassword}</span>
            <input
              className="input w-full"
              name="new-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(allowedChars(event.target.value))}
            />
          </label>
          {shownError ? (
            <p className="m-0 flex items-center gap-1.5" role="alert" lang={shownErrorLang}>
              <CircleAlert className="size-4 shrink-0 text-error" aria-hidden="true" />
              <span>{shownError}</span>
            </p>
          ) : null}
          <div className="card-actions justify-end">
            {/* 「取消」两种模式都有：普通模式返回来路；强制模式放弃这次登录、
                作废受限会话回登录页（见 use-auth-flow 的 cancelGatedLogin）。 */}
            {onCancel === undefined ? null : (
              <button type="button" className="btn btn-outline" onClick={onCancel}>
                {text.cancel}
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={blocked}>
              {text.changePassword}
            </button>
          </div>
        </div>
      </form>
    </main>
  );
}
