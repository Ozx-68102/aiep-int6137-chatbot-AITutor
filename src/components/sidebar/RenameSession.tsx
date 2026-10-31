import {useState} from 'react';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';
import {Modal} from '../shell/Modal.tsx';

export function RenameSession({
  locale,
  open,
  initialTitle,
  error,
  onCancel,
  onConfirm,
}: {
  locale: Locale;
  open: boolean;
  initialTitle: string;
  error: string | null;
  onCancel: () => void;
  onConfirm: (title: string) => Promise<boolean>;
}) {
  const text = translations[locale];
  const [draft, setDraft] = useState(initialTitle);
  const [pending, setPending] = useState(false);
  const trimmed = draft.trim();
  const unchanged = trimmed === '' || trimmed === initialTitle.trim();

  // 每次打开都把输入框里的内容换成当前名字。
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(initialTitle);
      setPending(false);
    }
  }

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

  return (
    <Modal open={open} titleId="rename-title" panelClass="w-full max-w-md p-8" onClose={onCancel}>
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <CloseButton label={text.close} onClick={onCancel} />
        <h2 id="rename-title" className="m-0 pr-10 text-xl" lang={htmlLang[locale]}>
          {text.rename}
        </h2>
        <input
          className="rounded-lg border border-stone-300 px-3 py-2.5"
          value={draft}
          lang={htmlLang[locale]}
          aria-label={text.rename}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
        />
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
            type="submit"
            className={
              unchanged
                ? 'inline-flex min-w-16 items-center justify-center rounded-lg border border-stone-300 bg-white px-3 py-2.5 opacity-50'
                : 'inline-flex min-w-16 items-center justify-center rounded-lg border border-emerald-900 bg-emerald-900 px-3 py-2.5 text-white transition-[filter] duration-150 ease-out enabled:hover:brightness-95 enabled:active:brightness-90 disabled:opacity-60'
            }
            disabled={unchanged || pending}
            aria-busy={pending}
          >
            {pending ? (
              <span
                className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
                aria-hidden="true"
              />
            ) : (
              text.renameSave
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
