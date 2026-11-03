import {useState} from 'react';
import type {ResetPasswordResult} from '../../api/admin.ts';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';
import {Modal} from '../shell/Modal.tsx';

/**
 * 重置成功的面板：新密码只回显这一次，关掉之后就再也拿不到，
 * 所以面板上明说「先抄下来」。关闭要先播退出动画，动画期间
 * 用记住的上一份内容，别当场清空。
 */
export function NewPasswordPanel({
  locale,
  result,
  onClose,
}: {
  locale: Locale;
  result: ResetPasswordResult | null;
  onClose: () => void;
}) {
  const text = translations[locale];
  const [shown, setShown] = useState<ResetPasswordResult | null>(result);
  if (result !== null && result !== shown) {
    setShown(result);
  }

  return (
    <Modal
      open={result !== null}
      titleId="admin-new-password-title"
      panelClass="w-full max-w-md p-8"
      onClose={onClose}
    >
      <div className="flex flex-col gap-6">
        <CloseButton label={text.close} onClick={onClose} />
        <h2 id="admin-new-password-title" className="m-0 pr-10 text-xl" lang={htmlLang[locale]}>
          {text.resetPassword}
        </h2>
        <div className="flex flex-col gap-1">
          <p className="m-0 text-sm text-stone-600" lang={htmlLang[locale]}>
            {text.username}
          </p>
          <p className="m-0 break-all">{shown?.username}</p>
        </div>
        <div className="flex flex-col gap-1">
          <p className="m-0 text-sm text-stone-600" lang={htmlLang[locale]}>
            {text.newPassword}
          </p>
          <p
            className="m-0 rounded-field border border-base-300 bg-base-200 px-3 py-2.5 font-mono text-lg break-all select-all"
            lang="en"
          >
            {shown?.password}
          </p>
        </div>
        <p className="m-0 text-sm text-stone-600" lang={htmlLang[locale]}>
          {text.passwordShownOnce}
        </p>
        <div className="flex justify-end">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {text.close}
          </button>
        </div>
      </div>
    </Modal>
  );
}
