import {useEffect, useRef, useState} from 'react';
import type {ResetPasswordResult} from '../../api/admin.ts';
import {translations} from '../../i18n/index.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {CloseButton} from '../close-button/CloseButton.tsx';
import {Modal} from '../shell/Modal.tsx';

/**
 * 重置成功的面板：新密码只回显这一次，关掉之后就再也拿不到，
 * 所以面板上明说「先抄下来」。关闭要先播退出动画，动画期间
 * 用记住的上一份内容，别当场清空。
 *
 * 这个面板点背景、按 Esc 都不能关：新密码还没抄下来就误触关掉的话，
 * 得把整个重置流程重走一遍。Modal 对背景/Esc 是无条件调 onClose 的，
 * 所以这里给 Modal 传一个空函数占位，两个显式关闭按钮直接调 onClose。
 */
export function NewPasswordPanel({
  locale,
  result,
  onClose,
}: {
  locale: Locale;
  result: ResetPasswordResult | null;
  onClose: () => void;
}) {
  const text = translations[locale];
  const [shown, setShown] = useState<ResetPasswordResult | null>(result);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  if (result !== null && result !== shown) {
    setShown(result);
  }

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
      }
    },
    [],
  );

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(shown?.password ?? '');
      setCopied(true);
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
      }
      copiedTimer.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimer.current = null;
      }, 2000);
    } catch {
      // 剪贴板 API 不可用（非安全上下文、被拒权限等）：静默不提示，
      // 密码框本身有 select-all，还能手动选中复制。
    }
  }

  return (
    <Modal
      open={result !== null}
      titleId="admin-new-password-title"
      panelClass="w-full max-w-md p-8"
      onClose={() => {
        // 故意留空：点背景和 Esc 都不关闭，只能走面板上的显式按钮。
      }}
    >
      <div className="flex flex-col gap-6">
        <CloseButton label={text.close} onClick={onClose} />
        <h2 id="admin-new-password-title" className="m-0 pr-10 text-xl" lang={htmlLang[locale]}>
          {text.resetPassword}
        </h2>
        <div className="flex flex-col gap-1">
          <p className="m-0 text-sm text-stone-600" lang={htmlLang[locale]}>
            {text.username}
          </p>
          <p className="m-0 break-all">{shown?.username}</p>
        </div>
        <div className="flex flex-col gap-1">
          <p className="m-0 text-sm text-stone-600" lang={htmlLang[locale]}>
            {text.newPassword}
          </p>
          <div className="flex items-stretch gap-2">
            <p
              className="m-0 flex-1 rounded-field border border-base-300 bg-base-200 px-3 py-2.5 font-mono text-lg break-all select-all"
              lang="en"
            >
              {shown?.password}
            </p>
            <button
              type="button"
              className="btn btn-outline btn-sm shrink-0"
              onClick={() => {
                void copyPassword();
              }}
            >
              <span lang={htmlLang[locale]}>{copied ? text.copied : text.copy}</span>
            </button>
          </div>
        </div>
        <p className="m-0 text-sm text-stone-600" lang={htmlLang[locale]}>
          {text.passwordShownOnce}
        </p>
        <div className="flex justify-end">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {text.close}
          </button>
        </div>
      </div>
    </Modal>
  );
}
