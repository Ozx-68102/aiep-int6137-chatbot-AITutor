import {CircleAlert, RotateCw} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
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
import {useDocumentMeta} from '../../hooks/use-document-meta.ts';
import {translations} from '../../i18n/index.ts';
import {readCachedProfile} from '../../session/profile-cache.ts';
import {htmlLang, localeFromSystem, type Locale} from '../../type/locale.ts';
import {AdminLoginForm} from './AdminLoginForm.tsx';
import {ConfirmAdminLogout} from './ConfirmAdminLogout.tsx';
import {ConfirmResetPassword} from './ConfirmResetPassword.tsx';
import {NewPasswordPanel} from './NewPasswordPanel.tsx';

/**
 * 管理员控制台：地址是 /admin 时整页渲染，跟聊天侧完全无关——
 * 不拉取 /api/profile、不进聊天视图，登录态是 admin_login cookie 自己的。
 *
 * 挂载时先拉取一次账号列表：cookie 还有效就直接进列表，401 就显示登录表单。
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
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // lang 和标签页标题走 useDocumentMeta（O8：与 ChatApp 的同款效果去重）；
  // 控制台整页独立，标题带上页面名（N11）。
  useDocumentMeta(locale, text.adminConsole);

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
        setLoginError(explain(error, locale, translations[locale].connectionError));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [locale]);

  /** 手动刷新：重新拉取账号表，出错就显示在表格上方的警示行里。 */
  async function refreshAccounts() {
    if (refreshBusy) {
      return;
    }
    setRefreshBusy(true);
    setRefreshError(null);
    try {
      setAccounts(await fetchAdminAccounts());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // 登录过期：带着服务器给的说法回登录表单。
        enterLoginForm(error.detail);
        return;
      }
      setRefreshError(explain(error, locale, text.connectionError));
    } finally {
      setRefreshBusy(false);
    }
  }

  // 轮询的每个周期要读到最新的对话框与手动刷新状态：渲染期间写 ref 被禁止，
  // 所以放进效果里镜像（和 use-session-actions 的 depsRef 同一做法）。
  const pollSkipRef = useRef({dialogOpen: false, refreshBusy: false});
  useEffect(() => {
    pollSkipRef.current = {
      dialogOpen: confirmLogout || resetUsername !== null || resetResult !== null,
      refreshBusy,
    };
  });

  // 自动轮询：账号列表打开（即已登录）时，每 30 秒静默重新拉取一次。
  // 以下情况跳过这个周期，且都不动管理员的本地交互态：
  // - document.hidden：页面没人看，刷新没有意义；恢复可见后下一个周期自然继续；
  // - 任何对话框/面板开着（退出确认、重置密码确认、新密码面板）：
  //   别把管理员正在做的事刷掉，等全部关上再说；
  // - 手动刷新正在进行：避免两个请求并发互相覆盖。
  // 静默合并：成功就整表替换数据，不弹提示；失败（包括 401）什么都不做，
  // 等下一个周期或手动刷新——登录态真过期了，会由管理员下一次显式操作接住。
  const accountsOpen = accounts !== null;
  useEffect(() => {
    if (!accountsOpen) {
      return;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      const {dialogOpen, refreshBusy: manualBusy} = pollSkipRef.current;
      if (dialogOpen || manualBusy) {
        return;
      }
      fetchAdminAccounts().then(
        (items) => {
          if (!cancelled) {
            setAccounts(items);
          }
        },
        () => {
          // 静默轮询：失败不打扰管理员。
        },
      );
    }, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accountsOpen]);

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
      // 401（密码不对）、403（这个账号不是管理员）都带着中文 detail：简中
      // 原样显示，英文/繁中优先按状态码映射（裁决规则见 src/api/failure.ts）。
      setLoginError(explain(error, locale, text.connectionError));
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
      setLogoutError(explain(error, locale, text.connectionError));
    } finally {
      setLogoutBusy(false);
    }
  }

  function enterLoginForm(detail: string | null) {
    setAccounts(null);
    setRefreshError(null);
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
      setResetError(explain(error, locale, text.connectionError));
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={text.refreshAccounts}
            title={text.refreshAccounts}
            disabled={refreshBusy}
            aria-busy={refreshBusy}
            onClick={() => {
              void refreshAccounts();
            }}
          >
            {refreshBusy ? (
              <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            ) : (
              <RotateCw aria-hidden="true" className="size-4" />
            )}
          </button>
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
        </div>
      </header>
      {refreshError !== null ? (
        <p
          className="m-0 flex items-center gap-1.5"
          role="alert"
          lang={refreshError === text.connectionError ? htmlLang[locale] : 'zh-Hans'}
        >
          <CircleAlert className="size-4 shrink-0 text-error" aria-hidden="true" />
          <span>{refreshError}</span>
        </p>
      ) : null}
      {/* 账号表全量渲染，不做分页：账号数上百再考虑后端分页。 */}
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
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-8 text-center text-stone-500" lang={htmlLang[locale]}>
                  {text.noAccounts}
                </td>
              </tr>
            ) : null}
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
