import {CircleAlert} from 'lucide-react';
import {useState} from 'react';
import logoUrl from '../../assets/H-Squared_Bot_Vector.svg';
import {useTurnstile} from '../../hooks/use-turnstile.ts';
import {translations} from '../../i18n/index.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {LanguageMenu} from '../language/LanguageMenu.tsx';

export function LoginScreen({
  locale,
  error,
  notice,
  offline,
  submitting,
  embedded = false,
  headingId,
  onLocale,
  onSubmit,
}: {
  locale: Locale;
  error: string | null;
  /** 中性的提示（比如「密码已修改，请重新登录」），石头色，不当错误处理。 */
  notice?: string | null;
  offline: boolean;
  submitting: boolean;
  /** Modal 里的就地重新登录：去掉整页外壳和卡片描边，只留内容（同款卡片进弹窗）。 */
  embedded?: boolean;
  /** embedded 时给标题加 id，供 Modal 的 aria-labelledby 指。 */
  headingId?: string;
  onLocale: (locale: Locale) => void;
  /** 返回的 promise settling 后表单会 reset Turnstile widget（令牌一次性）。 */
  onSubmit: (username: string, password: string, turnstileToken: string) => Promise<void>;
}) {
  const text = translations[locale];
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Turnstile widget：令牌就绪前禁用按钮；每次登录尝试结束后 reset 换新令牌。
  const turnstile = useTurnstile('login');
  const blocked =
    offline || submitting || username.trim() === '' || password === '' || turnstile.token === null;

  return (
    <main
      className={embedded ? 'contents' : 'flex h-full items-center justify-center bg-base-200 px-4'}
    >
      <form
        className={
          embedded ? 'card w-full' : 'card w-full max-w-sm border border-base-300 bg-base-100'
        }
        onSubmit={(event) => {
          event.preventDefault();
          const turnstileToken = turnstile.token;
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
          <div className="flex items-center gap-2">
            <img src={logoUrl} alt="" className="h-12 w-auto" />
            <p lang="en" className="min-w-0 text-xs leading-tight text-stone-600">
              Help × Higher Understanding
            </p>
            <LanguageMenu locale={locale} onChange={onLocale} />
          </div>
          <h1 id={headingId} className="card-title" lang={htmlLang[locale]}>
            {text.logIn}
          </h1>
          <label className="fieldset">
            <span className="fieldset-label">{text.username}</span>
            <input
              className="input w-full"
              name="username"
              autoComplete="username"
              autoFocus
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
          {/* 忘记密码的静态提示：没有自助找回通道，把路指到管理员那里。 */}
          <p className="m-0 text-xs text-stone-500" lang={htmlLang[locale]}>
            {text.forgotPasswordHint}
          </p>
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
            aria-busy={submitting}
          >
            {submitting ? (
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
