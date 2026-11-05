import {useEffect, useState} from 'react';
import {
  adminLogin,
  adminLogout,
  adminResetPassword,
  fetchAdminAccounts,
  type AdminAccount,
  type ResetPasswordResult,
} from '../../api/admin.ts';
import {explain} from '../../api/failure.ts';
import {ApiError} from '../../api/http.ts';
import {translations} from '../../i18n/index.ts';
import {readCachedProfile} from '../../session/profile-cache.ts';
import {htmlLang, localeFromSystem, type Locale} from '../../type/locale.ts';
import {AdminLoginForm} from './AdminLoginForm.tsx';
import {ConfirmAdminLogout} from './ConfirmAdminLogout.tsx';
import {ConfirmResetPassword} from './ConfirmResetPassword.tsx';
import {NewPasswordPanel} from './NewPasswordPanel.tsx';

/**
 * 管理员控制台：地址是 /admin 时整页渲染，跟聊天侧完全无关——
 * 不拉 /api/profile、不进聊天视图，登录态是 admin_login cookie 自己的。
 *
 * 挂载时先拉一次账号列表：cookie 还有效就直接进列表，401 就显示登录表单。
 * 语言照登录页在没有账号信息时的做法：本地记过就用记的，没有就随系统。
 */
export function AdminConsole() {
  const [locale] = useState<Locale>(() => readCachedProfile()?.locale ?? localeFromSystem());
  const text = translations[locale];
  const [checking, setChecking] = useState(true);
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [resetUsername, setResetUsername] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<ResetPasswordResult | null>(null);

  useEffect(() => {
    document.documentElement.lang = htmlLang[locale];
    document.title = 'H^2 Bot';
  }, [locale]);

  useEffect(() => {
    let cancelled = false;
    fetchAdminAccounts().then(
      (items) => {
        if (cancelled) {
          return;
        }
        setAccounts(items);
        setChecking(false);
      },
      (error: unknown) => {
        if (cancelled) {
          return;
        }
        setChecking(false);
        if (error instanceof ApiError && error.status === 401) {
          // 没登录：显示登录表单，不算错误。
          return;
        }
        setLoginError(explain(error, translations[locale].connectionError));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [locale]);

  async function submitLogin(username: string, password: string) {
    if (loginBusy) {
      return;
    }
    setLoginBusy(true);
    setLoginError(null);
    try {
      await adminLogin(username, password);
      setAccounts(await fetchAdminAccounts());
    } catch (error) {
      // 401（密码不对）、403（这个账号不是管理员）都带着中文 detail，照实显示。
      setLoginError(explain(error, text.connectionError));
    } finally {
      setLoginBusy(false);
    }
  }

  /** 退出登录留在控制台的登录表单，不回聊天页。 */
  async function signOut() {
    if (logoutBusy) {
      return;
    }
    setLogoutBusy(true);
    setLogoutError(null);
    try {
      await adminLogout();
      enterLoginForm(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // cookie 已经无效：本来就没登录，直接当作退出了。
        enterLoginForm(null);
        return;
      }
      setLogoutError(explain(error, text.connectionError));
    } finally {
      setLogoutBusy(false);
    }
  }

  function enterLoginForm(detail: string | null) {
    setAccounts(null);
    setConfirmLogout(false);
    setLogoutError(null);
    setResetUsername(null);
    setResetError(null);
    setResetResult(null);
    setLoginError(detail);
  }

  /** 确认弹窗里点「重置密码」。返回 true 表示弹窗可以关了。 */
  async function confirmReset(): Promise<boolean> {
    if (resetUsername === null) {
      return false;
    }
    try {
      const result = await adminResetPassword(resetUsername);
      setResetUsername(null);
      setResetError(null);
      setResetResult(result);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // 登录过期：关掉弹窗，带着服务器给的说法回登录表单。
        enterLoginForm(error.detail);
        return true;
      }
      // 404「找不到这个账号」这类错误显示在弹窗里，名单原样留着。
      setResetError(explain(error, text.connectionError));
      return false;
    }
  }

  if (checking) {
    return <div className="h-full bg-base-200" />;
  }

  if (accounts === null) {
    return (
      <AdminLoginForm
        locale={locale}
        error={loginError}
        busy={loginBusy}
        onSubmit={(username, password) => {
          void submitLogin(username, password);
        }}
      />
    );
  }

  return (
    <main className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between gap-2">
        <h1 className="m-0 text-lg" lang={htmlLang[locale]}>
          {text.adminConsole}
        </h1>
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => {
            setLogoutError(null);
            setConfirmLogout(true);
          }}
        >
          <span lang={htmlLang[locale]}>{text.logOut}</span>
        </button>
      </header>
      <div className="card overflow-x-auto border border-base-300 bg-base-100">
        <table className="table table-zebra">
          <thead>
            <tr lang={htmlLang[locale]}>
              <th>{text.username}</th>
              <th>{text.role}</th>
              <th>
                <span className="sr-only">{text.resetPassword}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.username}>
                <td className="break-all">{account.username}</td>
                <td lang={htmlLang[locale]}>
                  {account.role === 'admin' ? text.roleAdmin : text.roleChat}
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    onClick={() => {
                      setResetError(null);
                      setResetUsername(account.username);
                    }}
                  >
                    <span lang={htmlLang[locale]}>{text.resetPassword}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmResetPassword
        locale={locale}
        open={resetUsername !== null}
        username={resetUsername}
        error={resetError}
        onCancel={() => {
          setResetError(null);
          setResetUsername(null);
        }}
        onConfirm={confirmReset}
      />
      <NewPasswordPanel
        locale={locale}
        result={resetResult}
        onClose={() => {
          setResetResult(null);
        }}
      />
      <ConfirmAdminLogout
        locale={locale}
        open={confirmLogout}
        error={logoutError}
        loggingOut={logoutBusy}
        onCancel={() => {
          setLogoutError(null);
          setConfirmLogout(false);
        }}
        onConfirm={() => {
          void signOut();
        }}
      />
    </main>
  );
}
