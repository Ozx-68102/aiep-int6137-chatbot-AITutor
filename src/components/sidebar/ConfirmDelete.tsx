import {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';

export function ConfirmDelete({
  locale,
  error,
  onCancel,
  onConfirm,
}: {
  locale: Locale;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<boolean>;
}) {
  const text = translations[locale];
  const [pending, setPending] = useState(false);

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

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      event.stopPropagation();
      onCancel();
    }

    document.addEventListener('keydown', closeOnEscape, true);
    return () => document.removeEventListener('keydown', closeOnEscape, true);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onCancel}
    >
      <div
        className="relative flex w-full max-w-md flex-col gap-6 rounded-xl border border-stone-300 bg-white p-8 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        onClick={(event) => event.stopPropagation()}
      >
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
    </div>,
    document.body,
  );
}
