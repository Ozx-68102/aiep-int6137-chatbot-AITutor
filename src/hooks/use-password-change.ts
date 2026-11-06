import {useEffect, useRef, useState} from 'react';
import {connectionFailure, explain} from '../api/failure.ts';
import {ApiError} from '../api/http.ts';
import {changePassword} from '../api/profile.ts';
import {translations} from '../i18n/index.ts';
import type {Locale} from '../type/locale.ts';

type PasswordChangeDeps = {
  locale: Locale;
  /** 改密成功：服务端已吊销所有设备的登录，主控制器要带提示回登录页。 */
  onPasswordChanged: () => void;
  onEnterLogin: (detail: string | null) => void;
  onConnectionWarning: () => void;
};

/**
 * 改密页的控制器逻辑：busy 和错误状态，加上提交这一个动作。
 * 页面本体是 ChangePasswordPage，这里只管提交之后发生的事。
 */
export function usePasswordChange(deps: PasswordChangeDeps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 提交是异步流程，可能跨渲染：回调放进 ref，永远拿最新的一份。
  // 镜像放在效果里做：渲染期间写 ref 是被禁止的（react/refs）。
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  async function submit(oldPassword: string, newPassword: string, confirmPassword: string) {
    if (busy) {
      return;
    }
    const current = depsRef.current;
    const text = translations[current.locale];
    setBusy(true);
    setError(null);
    try {
      await changePassword(oldPassword, newPassword, confirmPassword);
      // 成功：服务端已经清掉本设备的 login cookie、吊销了这个账号所有设备的登录，
      // 不用再调 logout，直接带着提示回登录页。
      current.onPasswordChanged();
      current.onEnterLogin(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        current.onEnterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        current.onConnectionWarning();
        return;
      }
      setError(explain(error, current.locale, text.connectionError));
    } finally {
      setBusy(false);
    }
  }

  return {busy, error, setError, submit};
}
