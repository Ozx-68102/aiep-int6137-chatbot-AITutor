import {CircleAlert, TriangleAlert} from 'lucide-react';
import {useState} from 'react';
import {explain} from '../../api/failure.ts';
import {ApiError} from '../../api/http.ts';
import {changePassword} from '../../api/profile.ts';
import {format, translations} from '../../i18n/index.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';
import {
  allowedChars,
  MAX_PASSWORD_LENGTH,
  passwordRejected,
} from '../settings/password-strength.ts';
import {PasswordStrength} from '../settings/PasswordStrength.tsx';
import {Modal} from '../shell/Modal.tsx';

/** 管理员账号的密码最小长度：跟后端 min_length_for_role('admin') 同一道门槛。 */
const MIN_PASSWORD_LENGTH_ADMIN = 8;

/**
 * 控制台的「修改我的密码」弹窗：管理员改自己的密码，跟聊天侧共用后端
 * /api/password 这一个端点（server/src/server/routes/auth.py 的注释明写
 * 「聊天页和控制台共用这一个端点」），提交走 src/api/profile.ts 里现成的
 * changePassword 封装。成功即吊销该账号全部登录——控制台自己的登录也会
 * 失效，回登录界面用新密码重新登录。
 *
 * 纯自助入口：服务器端不对控制台做强制改密（维护者的永久决定），这里
 * 也没有任何强制逻辑。输入过滤、提交前的硬门槛和密码强度表都复用聊天侧
 * 改密页的现成模块（settings/password-strength），最小长度换成管理员的
 * 8 位。弹窗里事先写明「修改成功后所有设备下线」，别等成功了才发现。
 */
export function ChangeMyPasswordDialog({
  locale,
  open,
  username,
  onClose,
  onSuccess,
  onReLogin,
}: {
  locale: Locale;
  open: boolean;
  /** 当前登录的管理员用户名（密码不能包含它）；这一页拿不到就 null。 */
  username: string | null;
  onClose: () => void;
  /** 改密成功：服务器已吊销全部登录，控制台回登录界面并给一条提示。 */
  onSuccess: () => void;
  /** 提交收到 401：登录态已失效，带着服务器给的说法回登录界面。 */
  onReLogin: (detail: string | null) => void;
}) {
  const text = translations[locale];
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // 门槛错误优先于可能残留的服务端错误：它是最近一次提交尝试的结果。
  const [gateError, setGateError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = busy || oldPassword === '' || newPassword === '' || confirmPassword === '';
  const shownError = gateError ?? error;
  // 门槛错误和连接保底文案都是本地三语文案，按界面语言标注；其余的服务端
  // 消息（detail）固定是简体中文，标 zh-Hans 让浏览器按中文字体渲染。
  const localizedError = shownError === gateError || shownError === text.connectionError;
  const shownErrorLang = localizedError ? htmlLang[locale] : 'zh-Hans';

  // 每次打开都是干净的一张表单：上一次输的密码和错误提示都不留。open 变了
  // 就在渲染里把状态调过来（Modal.tsx 同款做法），不用效果，避免级联渲染。
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setGateError(null);
      setError(null);
      setBusy(false);
    }
  }

  async function submit() {
    if (blocked) {
      return;
    }
    // 客户端硬门槛：跟聊天侧改密页同一套（长度、弱口令名单），最小长度用
    // 管理员这道（8 位）。能在本地判定的提前拦掉，后端仍然会再拦一道。
    const rejected = passwordRejected(newPassword, MIN_PASSWORD_LENGTH_ADMIN);
    if (rejected === 'tooShort') {
      setGateError(
        format(text.passwordTooShort, {min: MIN_PASSWORD_LENGTH_ADMIN, max: MAX_PASSWORD_LENGTH}),
      );
      return;
    }
    if (rejected === 'tooCommon') {
      setGateError(text.passwordTooCommon);
      return;
    }
    setGateError(null);
    setBusy(true);
    setError(null);
    try {
      await changePassword(oldPassword, newPassword, confirmPassword);
      // 成功：服务器已吊销该账号全部登录、清掉两边的 cookie，不用再调
      // 退出登录，直接回控制台的登录界面。
      onSuccess();
    } catch (submitError) {
      if (submitError instanceof ApiError && submitError.status === 401) {
        // 登录态已失效：回登录界面，带上服务器给的说法。
        onReLogin(submitError.detail);
        return;
      }
      // 旧密码不对、两次不一致、太频繁（429）、连不上：都显示在弹窗里。
      setError(explain(submitError, locale, text.connectionError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      titleId="admin-change-password-title"
      panelClass="w-full max-w-md p-8"
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          // busy 时按钮已经禁用，这里再挡一道，防双击。
          void submit();
        }}
      >
        <CloseButton label={text.close} onClick={onClose} />
        <h2 id="admin-change-password-title" className="m-0 pr-10 text-xl" lang={htmlLang[locale]}>
          {text.changeMyPassword}
        </h2>
        {/* 事先写明后果：改密成功即吊销该账号全部登录，含控制台自己这条。 */}
        <div className="alert bg-base-100" role="status">
          <TriangleAlert className="size-5 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1 wrap-break-word" lang={htmlLang[locale]}>
            {text.changeMyPasswordWarning}
          </span>
        </div>
        <label className="fieldset">
          <span className="fieldset-label">{text.oldPassword}</span>
          <input
            className="input w-full"
            name="old-password"
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={(event) => setOldPassword(allowedChars(event.target.value))}
          />
        </label>
        <fieldset className="fieldset gap-2">
          <label className="fieldset">
            <span className="fieldset-label">{text.newPassword}</span>
            <input
              className="input w-full"
              name="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(allowedChars(event.target.value))}
            />
          </label>
          <p className="m-0 text-xs text-stone-500" lang={htmlLang[locale]}>
            {text.passwordHintAdmin}
          </p>
          <PasswordStrength locale={locale} password={newPassword} username={username} />
        </fieldset>
        <label className="fieldset">
          <span className="fieldset-label">{text.confirmPassword}</span>
          <input
            className="input w-full"
            name="new-password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(allowedChars(event.target.value))}
          />
        </label>
        {shownError ? (
          <p className="m-0 flex items-center gap-1.5" role="alert" lang={shownErrorLang}>
            <CircleAlert className="size-4 shrink-0 text-error" aria-hidden="true" />
            <span>{shownError}</span>
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            {text.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={blocked} aria-busy={busy}>
            {busy ? (
              <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            ) : (
              text.changePassword
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
