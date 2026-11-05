import {CircleAlert} from 'lucide-react';
import {useState} from 'react';
import {translations} from '../../i18n/index.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';
import {Modal} from '../shell/Modal.tsx';

/** 重置密码前的确认，交互照删除会话的确认弹窗。 */
export function ConfirmResetPassword({
  locale,
  open,
  username,
  error,
  onCancel,
  onConfirm,
}: {
  locale: Locale;
  open: boolean;
  username: string | null;
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
      const done = await onConfirm();
      if (!done) {
        setPending(false);
      }
    } catch {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      titleId="admin-reset-title"
      panelClass="w-full max-w-md p-8"
      onClose={onCancel}
    >
      <div className="flex flex-col gap-6">
        <CloseButton label={text.close} onClick={onCancel} />
        <h2 id="admin-reset-title" className="m-0 pr-10 text-xl" lang={htmlLang[locale]}>
          {text.resetPassword}
        </h2>
        <p className="m-0 break-all font-medium">{username}</p>
        <p className="m-0" lang={htmlLang[locale]}>
          {text.resetConfirm}
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
              <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            ) : (
              text.resetPassword
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
