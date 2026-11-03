import {useState} from 'react';
import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';

/**
 * 管理员控制台的登录表单，样子照学生端的登录页：整页居中一张卡片，
 * 服务器给的中文错误显示成表单红字。不带语言切换——控制台的语言
 * 进来就定好（本地记过就用记的，没有就随系统），架子上够用。
 */
export function AdminLoginForm({
  locale,
  error,
  busy,
  onSubmit,
}: {
  locale: Locale;
  error: string | null;
  busy: boolean;
  onSubmit: (username: string, password: string) => void;
}) {
  const text = translations[locale];
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const blocked = busy || username.trim() === '' || password === '';

  return (
    <main className="flex h-full items-center justify-center bg-stone-100 px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-stone-300 bg-white p-6"
        onSubmit={(event) => {
          event.preventDefault();
          // busy 时按钮已经禁用，这里再挡一道，防双击。
          if (blocked) {
            return;
          }
          onSubmit(username.trim(), password);
        }}
      >
        <h1 className="m-0 text-lg" lang={htmlLang[locale]}>
          {text.adminConsole}
        </h1>
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
