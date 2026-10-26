import {useEffect} from 'react';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';

export function ConfirmDelete({
  locale,
  onCancel,
  onConfirm,
}: {
  locale: Locale;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const text = translations[locale];

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

  return (
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
        <CloseButton label={text.close} onClick={onCancel}/>
        <h2 id="delete-title" className="m-0 pr-10 text-xl" lang={htmlLang[locale]}>{text.deleteSession}</h2>
        <p className="m-0" lang={htmlLang[locale]}>{text.deleteConfirm}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-stone-300 bg-white px-3 py-2.5"
            onClick={onCancel}
          >
            {text.cancel}
          </button>
          <button
            type="button"
            className="rounded-lg border border-red-600 bg-white px-3 py-2.5 text-red-600"
            onClick={onConfirm}
          >
            {text.deleteSession}
          </button>
        </div>
      </div>
    </div>
  );
}
