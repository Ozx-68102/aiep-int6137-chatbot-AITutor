import type {Locale} from '../../type/locale.ts';
import {LoginScreen} from '../login/LoginScreen.tsx';
import {Modal} from './Modal.tsx';

type ReloginModalProps = {
  open: boolean;
  locale: Locale;
  error: string | null;
  offline: boolean;
  submitting: boolean;
  onLocale: (locale: Locale) => void;
  onSubmit: (usernameValue: string, password: string) => Promise<void>;
  onClose: () => void;
};

/**
 * 会话过期后的就地重新登录弹窗：Modal 里放 LoginScreen 同款卡片。开不开、
 * 什么时候关都由调用方决定（disabled 是终态，不提供就地重新登录）。
 */
export function ReloginModal({
  open,
  locale,
  error,
  offline,
  submitting,
  onLocale,
  onSubmit,
  onClose,
}: ReloginModalProps) {
  return (
    <Modal open={open} titleId="relogin-title" panelClass="w-full max-w-sm p-0" onClose={onClose}>
      <LoginScreen
        locale={locale}
        error={error}
        offline={offline}
        submitting={submitting}
        embedded
        headingId="relogin-title"
        onLocale={onLocale}
        onSubmit={(usernameValue, password) => {
          void onSubmit(usernameValue, password);
        }}
      />
    </Modal>
  );
}
