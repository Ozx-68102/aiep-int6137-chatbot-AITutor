import {CircleAlert} from 'lucide-react';
import {useState} from 'react';
import {useTurnstile} from '../../hooks/use-turnstile.ts';
import {translations} from '../../i18n/index.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';

/**
 * 管理员控制台的登录表单，样子照学生端的登录页：整页居中一张卡片，
 * 服务器给的中文错误显示成表单红字。不带语言切换——控制台的语言
 * 进来就定好（本地记过就用记的，没有就随系统），这样就够用。
 */
export function AdminLoginForm({
  locale,
  error,
  notice,
  busy,
  onSubmit,
}: {
  locale: Locale;
  error: string | null;
  /** 登录表单上方的中性提示（比如「密码已修改，请用新密码重新登录」）。 */
  notice?: string | null;
  busy: boolean;
  /** 返回的 promise settling 后表单会 reset Turnstile widget（令牌一次性）。 */
  onSubmit: (username: string, password: string, turnstileToken: string) => Promise<void>;
}) {
  const text = translations[locale];
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Turnstile widget：令牌就绪前禁用按钮；每次登录尝试结束后 reset 换新令牌。
  const turnstile = useTurnstile('admin_login');
  const blocked = busy || username.trim() === '' || password === '' || turnstile.token === null;

  return (
    <main className="flex h-full items-center justify-center bg-base-200 px-4">
      <form
        className="card w-full max-w-sm border border-base-300 bg-base-100"
        onSubmit={(event) => {
          event.preventDefault();
          const turnstileToken = turnstile.token;
          // busy 时按钮已经禁用，这里再挡一道，防双击。
          if (blocked || turnstileToken === null) {
            return;
          }
          // 令牌一次性：不管登录成功还是失败，都 reset widget 换一个新令牌，
          // 再允许下一次尝试。
          void onSubmit(username.trim(), password, turnstileToken).finally(() => {
            turnstile.reset();
          });
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
          {/* Turnstile 人机验证 widget：由 use-turnstile 显式渲染；令牌没就绪时按钮禁用。 */}
          <div ref={turnstile.containerRef} className="flex justify-center" />
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
          {notice ? (
            <p className="m-0 text-info" lang={htmlLang[locale]}>
              {notice}
            </p>
          ) : null}
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={blocked}
            aria-busy={busy}
          >
            {busy ? (
              <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            ) : (
              text.logIn
            )}
          </button>
        </div>
      </form>
    </main>
  );
}
