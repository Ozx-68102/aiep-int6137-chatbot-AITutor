import {useState} from 'react';
import logoUrl from '../../assets/H-Squared_Bot_Vector.svg';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {LanguageMenu} from '../language/LanguageMenu.tsx';

export function LoginScreen({
  locale,
  error,
  offline,
  submitting,
  onLocale,
  onSubmit,
}: {
  locale: Locale;
  error: string | null;
  offline: boolean;
  submitting: boolean;
  onLocale: (locale: Locale) => void;
  onSubmit: (username: string, password: string) => void;
}) {
  const text = translations[locale];
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const blocked = offline || submitting || username.trim() === '' || password === '';

  return (
    <main className="flex h-full items-center justify-center bg-stone-100 px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-stone-300 bg-white p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (blocked) {
            return;
          }
          onSubmit(username.trim(), password);
        }}
      >
        <div className="flex items-center gap-2">
          <img src={logoUrl} alt="" className="h-12 w-auto"/>
          <p lang="en" className="min-w-0 text-xs leading-tight text-stone-600">
            Help × Higher Understanding
          </p>
          <LanguageMenu locale={locale} onChange={onLocale}/>
        </div>
        <h1 className="m-0 text-lg" lang={htmlLang[locale]}>{text.logIn}</h1>
        <label className="flex flex-col gap-1">
          {text.username}
          <input
            className="rounded-lg border border-stone-300 px-3 py-2.5"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          {text.password}
          <input
            className="rounded-lg border border-stone-300 px-3 py-2.5"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
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
          type="submit"
          className={
            blocked
              ? 'rounded-lg border border-stone-300 bg-white px-3 py-2.5 opacity-50'
              : 'rounded-lg border border-emerald-900 bg-emerald-900 px-3 py-2.5 text-white transition-[filter] duration-150 ease-out enabled:hover:brightness-95 enabled:active:brightness-90'
          }
          disabled={blocked}
        >
          {text.logIn}
        </button>
      </form>
    </main>
  );
}
