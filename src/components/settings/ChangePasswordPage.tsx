import {useState} from 'react';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {PasswordStrength} from './PasswordStrength.tsx';

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
  const blocked = busy || oldPassword === '' || newPassword === '' || confirmPassword === '';

  return (
    <main className="flex h-full items-center justify-center bg-stone-100 px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-stone-300 bg-white p-6"
        onSubmit={(event) => {
          event.preventDefault();
          // busy 时按钮已经禁用，这里再挡一道，防双击。
          if (blocked) {
            return;
          }
          void onSubmit(oldPassword, newPassword, confirmPassword);
        }}
      >
        <h1 className="m-0 text-lg" lang={htmlLang[locale]}>
          {text.changePassword}
        </h1>
        <label className="flex flex-col gap-1">
          {text.oldPassword}
          <input
            className="rounded-lg border border-stone-300 px-3 py-2.5"
            name="old-password"
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={(event) => setOldPassword(allowedChars(event.target.value))}
          />
        </label>
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            {text.newPassword}
            <input
              className="rounded-lg border border-stone-300 px-3 py-2.5"
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
        </div>
        <label className="flex flex-col gap-1">
          {text.confirmPassword}
          <input
            className="rounded-lg border border-stone-300 px-3 py-2.5"
            name="new-password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(allowedChars(event.target.value))}
          />
        </label>
        {error ? (
          <p
            className="m-0 text-red-600"
            role="alert"
            lang={error === text.connectionError ? htmlLang[locale] : 'zh-Hans'}
          >
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-stone-300 bg-white px-3 py-2.5 transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20"
            onClick={onCancel}
          >
            {text.cancel}
          </button>
          <button
            type="submit"
            className="rounded-lg border border-emerald-900 bg-emerald-900 px-3 py-2.5 text-white transition-[filter] duration-150 ease-out enabled:hover:brightness-95 enabled:active:brightness-90 disabled:opacity-50"
            disabled={blocked}
          >
            {text.changePassword}
          </button>
        </div>
      </form>
    </main>
  );
}
