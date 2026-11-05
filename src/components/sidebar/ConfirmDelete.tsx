import {CircleAlert} from 'lucide-react';
import {useState} from 'react';
import {translations} from '../../i18n/index.ts';
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
            type="button"
            className="btn btn-error min-w-16"
            disabled={pending}
            aria-busy={pending}
            onClick={() => {
              void confirm();
            }}
          >
            {pending ? (
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : (
              text.deleteSession
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
