import {CircleAlert} from 'lucide-react';
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
          className="input w-full"
          value={draft}
          lang={htmlLang[locale]}
          aria-label={text.rename}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
        />
        {error ? (
          <p className="m-0 flex items-center gap-1.5" role="alert">
            <CircleAlert className="size-4 shrink-0 text-error" aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-outline" onClick={onCancel}>
            {text.cancel}
          </button>
          <button
            type="submit"
            className="btn btn-primary min-w-16"
            disabled={unchanged || pending}
            aria-busy={pending}
          >
            {pending ? (
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : (
              text.renameSave
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
