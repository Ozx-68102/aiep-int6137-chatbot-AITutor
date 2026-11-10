import {CircleAlert, CircleCheck, Eye, EyeOff, TriangleAlert} from 'lucide-react';
import {useState} from 'react';
import {format, translations} from '../../i18n/index.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {PasswordStrength} from './PasswordStrength.tsx';
import {allowedChars, MAX_PASSWORD_LENGTH, passwordRejected} from './password-strength.ts';

/** 聊天侧（学生）账号的密码最小长度：跟后端 min_length_for_role('chat') 同一道门槛。 */
const MIN_PASSWORD_LENGTH = 6;

/**
 * 修改密码，独立的一页，不是弹窗：弹窗点一下背景就关，密码输一半全丢
 * （密码框的内容也不进草稿缓存，无法恢复）。页面没有背景可误点，
 * 离开只有「取消」按钮这一条显式的路。
 *
 * 组件随页面切换整个卸载后重新挂载，三个输入框天然清空，不用手写清理逻辑。
 *
 * 三个密码框右侧各有一个「显示密码」开关：点一下明文显示（图标换成睁开的
 * 眼睛），再点一下恢复掩码。选点按切换而不是长按显示：键盘和触屏都能用，
 * 也不用一直按着。
 *
 * 两种模式走两条 URL、两副面孔（2026-11 拆分，维护者决定）：强制改密
 * （/force-change-pwd，重置密码后的闸门）标题「设置新密码」、顶部挂一条
 * 说明横幅解释为什么被拦；自助改密（/change-pwd，从设置进来）标题
 * 「修改密码」。退出按钮的文案也分开：强制模式的「放弃本次登录」是放弃
 * 这条受限会话回登录页（use-auth-flow 的 cancelGatedLogin）；普通模式的
 * 「取消」返回来路。同一个表单本体两处共用，区别只在这几处文案与横幅。
 *
 * 提交反馈（2026-11 补）：点击后按钮禁用加转圈直到请求完成；成功先就地
 * 亮一条「密码已修改」的提示（success），片刻后由 App 收尾跳登录；失败就地
 * 显示错误。成功期间按钮保持禁用，跳转不会被第二次提交打断。
 */
export function ChangePasswordPage({
  locale,
  username,
  error,
  busy,
  success = false,
  onSubmit,
  onCancel,
  forced = false,
}: {
  locale: Locale;
  username: string | null;
  error: string | null;
  busy: boolean;
  /** 改密已生效：顶部亮成功提示、按钮保持转圈，等 App 收尾跳登录。 */
  success?: boolean | undefined;
  onSubmit: (oldPassword: string, newPassword: string, confirmPassword: string) => Promise<void>;
  onCancel?: (() => void) | undefined;
  /** 强制模式：顶部挂说明横幅；「放弃本次登录」＝放弃这条受限会话，由调用方的 onCancel 给。 */
  forced?: boolean | undefined;
}) {
  const text = translations[locale];
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // 三个密码框各自的「显示密码」开关：点一下明文显示，再点一下恢复掩码。
  const [oldShown, setOldShown] = useState(false);
  const [newShown, setNewShown] = useState(false);
  const [confirmShown, setConfirmShown] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const working = busy || success;
  const blocked = working || oldPassword === '' || newPassword === '' || confirmPassword === '';
  // 门槛错误优先于可能残留的服务端错误：它是最近一次提交尝试的结果。
  const shownError = gateError ?? error;
  // 门槛错误和连接保底文案都是本地三语文案，按界面语言标注；其余的服务端
  // 消息（detail）固定是简体中文，标 zh-Hans 让浏览器按中文字体渲染。
  const localizedError = shownError === gateError || shownError === text.connectionError;
  const shownErrorLang = localizedError ? htmlLang[locale] : 'zh-Hans';

  // 密码框右侧的「显示密码」开关。type=button：别把表单提交带出去。
  function revealToggle(shown: boolean, toggle: () => void) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label={shown ? text.hidePassword : text.showPassword}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 grid place-items-center px-3 text-stone-500 hover:text-stone-800"
      >
        {shown ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </button>
    );
  }

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
            {forced ? text.setNewPassword : text.changePassword}
          </h1>
          {success ? (
            // 改密成功：就地先亮一条提示再收尾跳登录。白底黑字，语义色只在
            // 图标上（docs/UI_WARNINGS.md）；role=status 让读屏也报得出「成了」。
            <div className="alert bg-base-100" role="status">
              <CircleCheck className="size-5 shrink-0 text-success" aria-hidden="true" />
              <span className="min-w-0 flex-1 wrap-break-word" lang={htmlLang[locale]}>
                {text.passwordChanged}
              </span>
            </div>
          ) : forced ? (
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
            <span className="relative block">
              <input
                className="input w-full pr-11"
                name="old-password"
                type={oldShown ? 'text' : 'password'}
                autoComplete="current-password"
                value={oldPassword}
                onChange={(event) => setOldPassword(allowedChars(event.target.value))}
              />
              {revealToggle(oldShown, () => setOldShown((value) => !value))}
            </span>
          </label>
          <fieldset className="fieldset gap-2">
            <label className="fieldset">
              <span className="fieldset-label">{text.newPassword}</span>
              <span className="relative block">
                <input
                  className="input w-full pr-11"
                  name="new-password"
                  type={newShown ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(allowedChars(event.target.value))}
                />
                {revealToggle(newShown, () => setNewShown((value) => !value))}
              </span>
            </label>
            <p className="m-0 text-xs text-stone-500" lang={htmlLang[locale]}>
              {text.passwordHint}
            </p>
            <PasswordStrength locale={locale} password={newPassword} username={username} />
          </fieldset>
          <label className="fieldset">
            <span className="fieldset-label">{text.confirmPassword}</span>
            <span className="relative block">
              <input
                className="input w-full pr-11"
                name="new-password-confirm"
                type={confirmShown ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(allowedChars(event.target.value))}
              />
              {revealToggle(confirmShown, () => setConfirmShown((value) => !value))}
            </span>
          </label>
          {shownError ? (
            <p className="m-0 flex items-center gap-1.5" role="alert" lang={shownErrorLang}>
              <CircleAlert className="size-4 shrink-0 text-error" aria-hidden="true" />
              <span>{shownError}</span>
            </p>
          ) : null}
          <div className="card-actions justify-end">
            {/* 退出按钮两种模式都有、文案分开：普通模式「取消」返回来路；
                强制模式「放弃本次登录」作废受限会话回登录页（cancelGatedLogin）。
                提交中/成功期间禁用——别把进行中的流程打断。 */}
            {onCancel === undefined ? null : (
              <button
                type="button"
                className="btn btn-outline"
                onClick={onCancel}
                disabled={working}
              >
                {forced ? text.abandonLogin : text.cancel}
              </button>
            )}
            {/* 提交按钮：点击即禁用加转圈直到请求完成（维护者 2026-11 要求的
                最低反馈——不能让用户面对一个毫无反应的按钮连点两次）。 */}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={blocked}
              aria-busy={working}
            >
              {working ? (
                <span className="loading loading-spinner loading-sm" aria-hidden="true" />
              ) : forced ? (
                text.setNewPassword
              ) : (
                text.changePassword
              )}
            </button>
          </div>
        </div>
      </form>
    </main>
  );
}
