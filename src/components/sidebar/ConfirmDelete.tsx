import {useState} from 'react';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';
import {Modal} from '../shell/Modal.tsx';

export function ConfirmDelete({
  locale,
  open,
  error,
  onCancel,
  onConfirm,
}: {
  locale: Locale;
  open: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<boolean>;
}) {
  const text = translations[locale];
  const [pending, setPending] = useState(false);

  // 每次打开都把上一次的等待状态清掉。
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPending(false);
    }
  }

  async function confirm() {
    if (pending) {
      return;
    }
    setPending(true);
    try {
      const removed = await onConfirm();
      if (!removed) {
        setPending(false);
      }
    } catch {
      setPending(false);
    }
  }

  return (
    <Modal open={open} titleId="delete-title" panelClass="w-full max-w-md p-8" onClose={onCancel}>
      <div className="flex flex-col gap-6">
        <CloseButton label={text.close} onClick={onCancel} />
        <h2 id="delete-title" className="m-0 pr-10 text-xl" lang={htmlLang[locale]}>
          {text.deleteSession}
        </h2>
        <p className="m-0" lang={htmlLang[locale]}>
          {text.deleteConfirm}
        </p>
        {error ? (
          <p className="m-0 text-red-600" role="alert">
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
            className="inline-flex min-w-16 items-center justify-center rounded-lg border border-red-600 bg-white px-3 py-2.5 text-red-600 transition-colors duration-150 ease-out enabled:hover:bg-red-600/10 enabled:active:bg-red-600/20 disabled:opacity-60"
            disabled={pending}
            aria-busy={pending}
            onClick={() => {
              void confirm();
            }}
          >
            {pending ? (
              <span
                className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
                aria-hidden="true"
              />
            ) : (
              text.deleteSession
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
