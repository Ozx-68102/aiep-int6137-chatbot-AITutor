import {CircleAlert} from 'lucide-react';
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
    <main className="flex h-full items-center justify-center bg-base-200 px-4">
      <form
        className="card w-full max-w-sm border border-base-300 bg-base-100"
        onSubmit={(event) => {
          event.preventDefault();
          // busy 时按钮已经禁用，这里再挡一道，防双击。
          if (blocked) {
            return;
          }
          onSubmit(username.trim(), password);
        }}
      >
        <div className="card-body gap-4">
          <h1 className="card-title" lang={htmlLang[locale]}>
            {text.adminConsole}
          </h1>
          <label className="fieldset">
            <span className="fieldset-label">{text.username}</span>
            <input
              className="input w-full"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="fieldset">
            <span className="fieldset-label">{text.password}</span>
            <input
              className="input w-full"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
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
          <button type="submit" className="btn btn-primary btn-block" disabled={blocked}>
            {text.logIn}
          </button>
        </div>
      </form>
    </main>
  );
}
