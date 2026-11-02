import {useEffect, useState} from 'react';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';
import {Modal} from '../shell/Modal.tsx';
import {PasswordStrength} from './PasswordStrength.tsx';

export function ChangePasswordModal({
  locale,
  open,
  username,
  error,
  busy,
  onSubmit,
  onCancel,
  onClose,
}: {
  locale: Locale;
  open: boolean;
  username: string | null;
  error: string | null;
  busy: boolean;
  onSubmit: (oldPassword: string, newPassword: string, confirmPassword: string) => Promise<void>;
  onCancel: () => void;
  onClose: () => void;
}) {
  const text = translations[locale];
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const blocked = busy || oldPassword === '' || newPassword === '' || confirmPassword === '';

  // 关掉就把三个输入框清空：下次打开不带上一回输的密码。
  useEffect(() => {
    if (!open) {
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    }
  }, [open]);

  return (
    <Modal
      open={open}
      titleId="change-password-title"
      panelClass="w-full max-w-md p-8"
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          // busy 时按钮已经禁用，这里再挡一道，防双击。
          if (blocked) {
            return;
          }
          void onSubmit(oldPassword, newPassword, confirmPassword);
        }}
      >
        <CloseButton label={text.close} onClick={onClose} />
        <h2 id="change-password-title" className="m-0 pr-10 text-xl" lang={htmlLang[locale]}>
          {text.changePassword}
        </h2>
        <label className="flex flex-col gap-1">
          {text.oldPassword}
          <input
            className="rounded-lg border border-stone-300 px-3 py-2.5"
            name="old-password"
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={(event) => setOldPassword(event.target.value)}
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
              onChange={(event) => setNewPassword(event.target.value)}
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
            onChange={(event) => setConfirmPassword(event.target.value)}
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
    </Modal>
  );
}
