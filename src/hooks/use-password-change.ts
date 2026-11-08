import {useEffect, useRef, useState} from 'react';
import {connectionFailure, explain} from '../api/failure.ts';
import {ApiError} from '../api/http.ts';
import {changePassword} from '../api/profile.ts';
import {translations} from '../i18n/index.ts';
import type {Locale} from '../type/locale.ts';

/** 改密成功后就地亮提示、再收尾跳登录的间隔：给用户留点时间读到「成了」。 */
const FINISH_DELAY_MS = 600;

type PasswordChangeDeps = {
  locale: Locale;
  /**
   * 改密成功（页面已就地亮出「密码已修改」提示）：收尾——回「记下的来路」
   * （/chat/:id 或根路径）就地渲染登录屏，登录屏上带同句提示。收尾不走
   * enterLoginGuarded：那道「留在原页面的过期状态」守卫会吞掉成功路径——
   * 推送帧先到时（服务器吊销令牌后先推帧再回 204），守卫一吞，页面就
   * 「点修改毫无反应」地卡死在原地（2026-11 修正的正是这条）。
   */
  onFinish: () => void;
  /**
   * 提交收到 401（会话已死：被吊销/过期）。表单错误已由本 hook 设成统一
   * 文案；这里带同句文案回登录页。同样不走守卫：闸门下和自助页上都要直达。
   */
  onSessionExpired: (message: string) => void;
  onConnectionWarning: () => void;
};

/**
 * 改密页的控制器逻辑：busy、错误与成功状态，加上提交这一个动作。
 * 页面本体是 ChangePasswordPage，这里只管提交之后发生的事。
 */
export function usePasswordChange(deps: PasswordChangeDeps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 成功标记：改密已生效、页面正显示成功提示等收尾。期间提交按钮保持
  // 禁用加转圈（blocked 把它算进去），避免收尾被第二次提交打断——那会
  // 撞上已吊销的旧会话，得到一个莫名其妙的 401。
  const [changed, setChanged] = useState(false);
  // 提交是异步流程，可能跨渲染：回调放进 ref，永远拿最新的一份。
  // 镜像放在效果里做：渲染期间写 ref 是被禁止的（react/refs）。
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  async function submit(oldPassword: string, newPassword: string, confirmPassword: string) {
    if (busy || changed) {
      return;
    }
    const current = depsRef.current;
    const text = translations[current.locale];
    setBusy(true);
    setError(null);
    try {
      await changePassword(oldPassword, newPassword, confirmPassword);
      // 成功：先就地亮出提示（「密码已修改，请用新密码重新登录」），再让
      // App 收尾跳登录——成功的反馈不再只寄希望于「跳转一定发生」；跳转
      // 本身由 onFinish 负责，不再被任何守卫拦下。
      setChanged(true);
      window.setTimeout(() => {
        depsRef.current.onFinish();
      }, FINISH_DELAY_MS);
      return;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // 会话已死：凭证注销的统一文案，不透出后端 401 的 detail
        // （「未登录」是内部口径，2026-11 维护者决定不对用户显示）。
        setError(text.sessionExpired);
        current.onSessionExpired(text.sessionExpired);
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

  /** 回登录界面时整体复位：错误、成功标记一起清。 */
  function reset() {
    setBusy(false);
    setError(null);
    setChanged(false);
  }

  return {busy, error, setError, changed, reset, submit};
}
