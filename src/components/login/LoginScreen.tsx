import {CircleAlert} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import type {LoginOutcome} from '../../api/failure.ts';
import logoUrl from '../../assets/H-Squared_Bot_Vector.svg';
import {useTurnstile} from '../../hooks/use-turnstile.ts';
import {translations} from '../../i18n/index.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {LanguageMenu} from '../language/LanguageMenu.tsx';

export function LoginScreen({
  locale,
  error,
  notice,
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
  submitting: boolean;
  /** Modal 里的就地重新登录：去掉整页外壳和卡片描边，只留内容（同款卡片进弹窗）。 */
  embedded?: boolean;
  /** embedded 时给标题加 id，供 Modal 的 aria-labelledby 指。 */
  headingId?: string;
  onLocale: (locale: Locale) => void;
  /** 人机验证通过后带着一次性令牌调用。返回值决定按钮下一步：'failure'
   * 锁按钮直到改动用户名或密码；'connection' 保持可点、直接重试；
   * 'ok' 整页即将切走。 */
  onSubmit: (username: string, password: string, turnstileToken: string) => Promise<LoginOutcome>;
}) {
  const text = translations[locale];
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // 点「登录」之后的转圈期：等脚本、人机验证、登录请求三段全覆盖，按钮
  // 禁用并持续转圈，落到终态（成功或任何一种失败）才停。
  const [working, setWorking] = useState(false);
  // 失败锁：服务器拒绝（密码不对等）或验证没通过后禁用按钮，直到改动
  // 用户名或密码。
  const [locked, setLocked] = useState(false);
  // 点击后等脚本超时（连不上 Cloudflare）：本地的连接提示，不锁按钮。
  const [scriptGone, setScriptGone] = useState(false);
  // Turnstile widget：点「登录」才渲染；失败/成功现场原地保留，改动
  // 用户名或密码才移除。容器 ref 建在组件里传给 hook，不混进 hook 的
  // 返回值（渲染中不读 ref）。
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const turnstile = useTurnstile('login', turnstileRef);
  // 提交在验证通过的回调里触发，时刻可能晚于点击：输入值走 ref 镜像读，
  // 用户在等验证期间改过字段也用最新的。镜像放在效果里做：渲染期间写
  // ref 是被禁止的（react/refs）。
  const usernameRef = useRef(username);
  const passwordRef = useRef(password);
  useEffect(() => {
    usernameRef.current = username;
    passwordRef.current = password;
  });
  const blocked = submitting || working || locked || username.trim() === '' || password === '';
  // 本地的连接提示优先：它是最近一次点击的结果。connectionError 是三语
  // 本地化文案，lang 按界面语言标（与 ChangePasswordPage 同一裁决）。
  const shownError = scriptGone ? text.connectionError : error;

  // 用户名或密码的任何改动都算「重来」：解锁按钮、清本地连接提示、移除
  // widget（失败/成功现场只保留到这一刻）。进行中的验证/提交（working）
  // 不打断。
  function dismissFailure() {
    if (working) {
      return;
    }
    setLocked(false);
    setScriptGone(false);
    turnstile.hide();
  }

  // 点「登录」：立刻开始转圈，然后等脚本 → 渲染 widget → 验证通过后带
  // 令牌提交。每一段都有确定的终点（脚本等待有上限、挑战有 widget 自己的
  // 回调、请求有 15 秒超时），转圈不会无限转。
  function startLogin() {
    setWorking(true);
    setScriptGone(false);
    turnstile.start({
      onToken: (token) => {
        void (async () => {
          const outcome = await onSubmit(usernameRef.current.trim(), passwordRef.current, token);
          setWorking(false);
          if (outcome === 'failure') {
            setLocked(true);
          }
        })();
      },
      onFailed: (reason) => {
        setWorking(false);
        if (reason === 'script') {
          // 连不上 Cloudflare：与输入内容无关，不锁按钮，再点直接重试。
          setScriptGone(true);
          return;
        }
        setLocked(true);
      },
    });
  }

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
          // blocked 时按钮已经禁用，这里再挡一道，防双击和回车绕过。
          if (blocked) {
            return;
          }
          startLogin();
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
              onChange={(event) => {
                setUsername(event.target.value);
                dismissFailure();
              }}
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
              onChange={(event) => {
                setPassword(event.target.value);
                dismissFailure();
              }}
            />
          </label>
          {/* 忘记密码的静态提示：没有自助找回通道，把路指到管理员那里。 */}
          <p className="m-0 text-xs text-stone-500" lang={htmlLang[locale]}>
            {text.forgotPasswordHint}
          </p>
          {/* Turnstile 人机验证 widget：点「登录」才渲染；现场保留到改动输入为止。 */}
          <div ref={turnstileRef} className="flex justify-center" />
          {shownError ? (
            <p
              className="m-0 flex items-center gap-1.5"
              role="alert"
              lang={shownError === text.connectionError ? htmlLang[locale] : 'zh-Hans'}
            >
              <CircleAlert className="size-4 shrink-0 text-error" aria-hidden="true" />
              <span>{shownError}</span>
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
            aria-busy={working || submitting}
          >
            {working || submitting ? (
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
