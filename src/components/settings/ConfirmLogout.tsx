import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';
import {Modal} from '../shell/Modal.tsx';

export function ConfirmLogout({
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
    <Modal open={open} titleId="logout-title" panelClass="w-full max-w-md p-8" onClose={onCancel}>
      <div className="flex flex-col gap-6">
        <CloseButton label={text.close} onClick={onCancel} />
        <h2 id="logout-title" className="m-0 pr-10 text-xl" lang={htmlLang[locale]}>
          {text.logOut}
        </h2>
        <p className="m-0" lang={htmlLang[locale]}>
          {text.logOutConfirm}
        </p>
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
            type="button"
            className="rounded-lg border border-red-600 bg-white px-3 py-2.5 text-red-600 transition-colors duration-150 ease-out enabled:hover:bg-red-600/10 enabled:active:bg-red-600/20 disabled:border-red-600 disabled:text-red-600"
            disabled={loggingOut}
            onClick={onConfirm}
          >
            {text.logOut}
          </button>
        </div>
      </div>
    </Modal>
  );
}
