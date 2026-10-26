import {useEffect, useState} from 'react';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';

export function RenameSession({
  locale,
  initialTitle,
  onCancel,
  onConfirm,
}: {
  locale: Locale;
  initialTitle: string;
  onCancel: () => void;
  onConfirm: (title: string) => Promise<boolean>;
}) {
  const text = translations[locale];
  const [draft, setDraft] = useState(initialTitle);
  const [pending, setPending] = useState(false);
  const trimmed = draft.trim();
  const unchanged = trimmed === '' || trimmed === initialTitle.trim();

  async function confirm() {
    if (pending || unchanged) {
      return;
    }
    setPending(true);
    try {
      const saved = await onConfirm(trimmed);
      if (!saved) {
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onCancel}
    >
      <form
        className="relative flex w-full max-w-md flex-col gap-6 rounded-xl border border-stone-300 bg-white p-8 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <CloseButton label={text.close} onClick={onCancel}/>
        <h2 id="rename-title" className="m-0 pr-10 text-xl" lang={htmlLang[locale]}>{text.rename}</h2>
        <input
          className="rounded-lg border border-stone-300 px-3 py-2.5"
          value={draft}
          lang={htmlLang[locale]}
          aria-label={text.rename}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-stone-300 bg-white px-3 py-2.5"
            onClick={onCancel}
          >
            {text.cancel}
          </button>
          <button
            type="submit"
            className={
              unchanged
                ? 'inline-flex min-w-16 items-center justify-center rounded-lg border border-stone-300 bg-white px-3 py-2.5 opacity-50'
                : 'inline-flex min-w-16 items-center justify-center rounded-lg border border-emerald-900 bg-emerald-900 px-3 py-2.5 text-white disabled:opacity-60'
            }
            disabled={unchanged || pending}
            aria-busy={pending}
          >
            {pending ? <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true"/> : text.renameSave}
          </button>
        </div>
      </form>
    </div>
  );
}
