import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';
import {LanguageMenu} from '../language/LanguageMenu.tsx';
import {Modal} from '../shell/Modal.tsx';
import {AvatarPicker} from './AvatarPicker.tsx';

export function SettingsModal({
  locale,
  open,
  username,
  avatarUrl,
  avatarBusy,
  hasCustomAvatar,
  error,
  saving,
  onLocale,
  onAvatarPick,
  onChangePassword,
  onLogout,
  onClose,
}: {
  locale: Locale;
  open: boolean;
  username: string | null;
  avatarUrl: string | null;
  avatarBusy: boolean;
  hasCustomAvatar: boolean;
  error: string | null;
  saving: boolean;
  onLocale: (locale: Locale) => void;
  onAvatarPick: (file: File) => void;
  onChangePassword: () => void;
  onLogout: () => void;
  onClose: () => void;
}) {
  const text = translations[locale];

  return (
    <Modal
      open={open}
      titleId="settings-title"
      panelClass="min-h-80 w-full max-w-2xl p-8"
      onClose={onClose}
    >
      <div className="flex flex-col gap-8">
        <CloseButton label={text.close} onClick={onClose} />
        <h2 id="settings-title" className="m-0 pr-10 text-2xl" lang={htmlLang[locale]}>
          {text.profile}
        </h2>
        <div className="flex flex-col">
          <AvatarPicker
            locale={locale}
            username={username}
            avatarUrl={avatarUrl}
            busy={avatarBusy}
            custom={hasCustomAvatar}
            onPick={onAvatarPick}
          />
          <div className="flex items-center justify-between gap-4 border-b border-stone-300 py-4">
            <p className="m-0" lang={htmlLang[locale]}>
              {text.language}
            </p>
            <LanguageMenu
              locale={locale}
              variant="current"
              onChange={(next) => {
                if (saving) {
                  return;
                }
                onLocale(next);
              }}
            />
          </div>
          <div className="border-b border-stone-300 py-4">
            <button
              type="button"
              className="w-fit rounded-lg border border-stone-300 bg-white px-3 py-2.5 transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20"
              onClick={onChangePassword}
            >
              {text.changePassword}
            </button>
          </div>
          <div className="py-4">
            {error ? (
              <p
                className="mb-3 text-red-600"
                role="alert"
                lang={error === text.connectionError ? htmlLang[locale] : 'zh-Hans'}
              >
                {error}
              </p>
            ) : null}
            <button
              type="button"
              className="w-fit rounded-lg border border-red-600 bg-white px-3 py-2.5 text-red-600 transition-colors duration-150 ease-out enabled:hover:bg-red-600/10 enabled:active:bg-red-600/20"
              onClick={onLogout}
            >
              {text.logOut}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
