import {CircleAlert} from 'lucide-react';
import {useState} from 'react';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {PasswordStrength} from './PasswordStrength.tsx';
import {isWeakPassword} from './password-strength.ts';

/**
 * 三个框都只收英文键盘上打得出来的连续字符（可打印 ASCII，不含空格）：
 * 空格、中文、emoji、全角符号在输入时直接滤掉，不报错。中文多半是粘贴
 * 或输入法误触带进来的，静默丢掉比弹一句红字友好。
 * 后端 check_password_policy 有同一条硬门槛。
 *
 * 旧密码框也过滤：库里的密码都是经过策略存进去的，不含空格和非 ASCII，
 * 过滤不会把人锁在外面。登录页的密码框才是真不能过滤的那个——它要能
 * 原样对上任何历史密码，所以那边不动。
 */
function allowedChars(value: string): string {
  return value.replace(/[^\x21-\x7E]/g, '');
}

/**
 * 客户端硬门槛，提交前拦截：消息跟后端 check_password_policy 一字不差
 * （分工见 docs/ACCOUNT_MANAGEMENT.md，前端是提示、后端是门槛；能在本地
 * 判定的提前拦掉，省一个来回，后端仍然会再拦一道）。这个页面是聊天侧
 * 学生用的，最小长度 6。空格和非 ASCII 在输入时就被 allowedChars 滤掉了，
 * 到不了这里；含用户名由后端拦，它的消息经 error 原样显示。
 * 弱口令拒绝名单从 password-strength.ts 导入，不在这里再写一份。
 */
function newPasswordRejected(password: string): string | null {
  if (password.length < 6 || password.length > 128) {
    return '密码长度要在 6 到 128 之间';
  }
  if (isWeakPassword(password)) {
    return '这个密码太常见了，换一个';
  }
  return null;
}

/**
 * 修改密码，独立的一页，不是弹窗：弹窗点一下背景就关，密码输一半全丢
 * （密码框的内容也不进草稿缓存，救不回来）。页面没有背景可误点，
 * 离开只有「取消」按钮这一条显式的路。
 *
 * 组件随页面切换整个卸载重挂，三个输入框天然清空，不用手写清理逻辑。
 */
export function ChangePasswordPage({
  locale,
  username,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  locale: Locale;
  username: string | null;
  error: string | null;
  busy: boolean;
  onSubmit: (oldPassword: string, newPassword: string, confirmPassword: string) => Promise<void>;
  onCancel: () => void;
}) {
  const text = translations[locale];
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [gateError, setGateError] = useState<string | null>(null);
  const blocked = busy || oldPassword === '' || newPassword === '' || confirmPassword === '';
  // 门槛错误优先于可能残留的服务端错误：它是最近一次提交尝试的结果。
  const shownError = gateError ?? error;

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
          // 客户端硬门槛：本地就能判定的拒绝，不发请求。
          const rejected = newPasswordRejected(newPassword);
          if (rejected !== null) {
            setGateError(rejected);
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
            <p
              className="m-0 flex items-center gap-1.5"
              role="alert"
              lang={shownError === text.connectionError ? htmlLang[locale] : 'zh-Hans'}
            >
              <CircleAlert className="size-4 shrink-0 text-error" aria-hidden="true" />
              <span>{shownError}</span>
            </p>
          ) : null}
          <div className="card-actions justify-end">
            <button type="button" className="btn btn-outline" onClick={onCancel}>
              {text.cancel}
            </button>
            <button type="submit" className="btn btn-primary" disabled={blocked}>
              {text.changePassword}
            </button>
          </div>
        </div>
      </form>
    </main>
  );
}
