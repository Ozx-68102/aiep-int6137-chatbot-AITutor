import {CircleAlert} from 'lucide-react';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';
import {Modal} from '../shell/Modal.tsx';

/** 控制台退出登录的确认，交互照聊天端退出登录的弹窗。 */
export function ConfirmAdminLogout({
  locale,
  open,
  error,
  loggingOut,
  onCancel,
  onConfirm,
}: {
  locale: Locale;
  open: boolean;
  error: string | null;
  loggingOut: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const text = translations[locale];

  return (
    <Modal
      open={open}
      titleId="admin-logout-title"
      panelClass="w-full max-w-md p-8"
      onClose={onCancel}
    >
      <div className="flex flex-col gap-6">
        <CloseButton label={text.close} onClick={onCancel} />
        <h2 id="admin-logout-title" className="m-0 pr-10 text-xl" lang={htmlLang[locale]}>
          {text.logOut}
        </h2>
        <p className="m-0" lang={htmlLang[locale]}>
          {text.logOutConfirm}
        </p>
        {error ? (
          <p
            className="m-0 flex items-center gap-1.5"
            role="alert"
            lang={error === text.connectionError ? htmlLang[locale] : 'zh-Hans'}
          >
            <CircleAlert className="size-4 shrink-0 text-error" aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-outline" onClick={onCancel}>
            {text.cancel}
          </button>
          <button type="button" className="btn btn-error" disabled={loggingOut} onClick={onConfirm}>
            {text.logOut}
          </button>
        </div>
      </div>
    </Modal>
  );
}
