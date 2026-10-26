import {useEffect} from 'react';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';
import {LanguageMenu} from '../language/LanguageMenu.tsx';
import {accountLine} from './account-line.ts';

export function SettingsModal({
  locale,
  username,
  error,
  saving,
  onLocale,
  onLogout,
  onClose,
}: {
  locale: Locale;
  username: string | null;
  error: string | null;
  saving: boolean;
  onLocale: (locale: Locale) => void;
  onLogout: () => void;
  onClose: () => void;
}) {
  const text = translations[locale];

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex min-h-80 w-full max-w-2xl flex-col gap-8 rounded-xl border border-stone-300 bg-white p-8 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <CloseButton label={text.close} onClick={onClose}/>
        <h2 id="settings-title" className="m-0 pr-10 text-2xl" lang={htmlLang[locale]}>{text.profile}</h2>
        {username ? <p className="m-0 text-lg" lang={htmlLang[locale]}>{accountLine(locale, username)}</p> : null}
        <div className="flex items-center justify-between gap-4">
          <p className="m-0" lang={htmlLang[locale]}>{text.language}</p>
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
        {error ? (
          <p
            className="m-0 text-red-600"
            role="alert"
            lang={error === text.connectionError ? htmlLang[locale] : 'zh-Hans'}
          >
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="mt-auto w-fit rounded-lg border border-red-600 bg-white px-3 py-2.5 text-red-600"
          onClick={onLogout}
        >
          {text.logOut}
        </button>
      </div>
    </div>
  );
}
