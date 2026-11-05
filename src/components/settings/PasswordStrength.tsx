import {useEffect, useState} from 'react';
import {translations} from '../../i18n/index.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {
  loadPasswordStrength,
  passwordStrength,
  passwordStrengthReady,
} from './password-strength.ts';

// 每档的配色走 daisyUI 语义色（aiep 主题下 error=red-600、success=emerald-600、
// primary=emerald-900，跟原值一致）：太弱用报错的红，弱是中性灰，
// 一般和强用深浅两档 emerald。
const segmentClasses = ['bg-error', 'bg-stone-400', 'bg-success', 'bg-primary'];
const labelClasses = ['text-error', 'text-stone-500', 'text-success', 'text-primary'];

/**
 * 密码强度表：4 格条 + 档位标签，亮起 score + 1 格。
 * 只是建议，不拦提交；密码为空、或字典还在加载时不渲染。
 *
 * zxcvbn 的字典有好几 MB，弹窗一打开就后台拉（组件一挂载就触发），
 * 拉完 setReady 重画。加载完之前不画表，免得先闪一个不准的档位。
 */
export function PasswordStrength({
  locale,
  password,
  username,
}: {
  locale: Locale;
  password: string;
  username: string | null;
}) {
  const text = translations[locale];
  const [ready, setReady] = useState(passwordStrengthReady);

  useEffect(() => {
    if (passwordStrengthReady()) {
      return;
    }
    let cancelled = false;
    loadPasswordStrength()
      .then(() => {
        if (!cancelled) {
          setReady(true);
        }
      })
      .catch(() => {
        // 字典加载失败就不显示强度表；改密码本身不受影响，
        // 后端那道硬门槛还在。下次打开弹窗会再试。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (password === '') {
    return null;
  }
  const score = ready ? passwordStrength(password, username) : null;
  if (score === null) {
    return null;
  }
  const labels = [text.strengthTooWeak, text.strengthWeak, text.strengthFair, text.strengthStrong];
  const filled = `h-1.5 w-full rounded-full transition-colors duration-150 ease-out motion-reduce:transition-none ${segmentClasses[score]}`;
  const empty =
    'h-1.5 w-full rounded-full bg-base-300 transition-colors duration-150 ease-out motion-reduce:transition-none';

  return (
    <div className="flex items-center gap-2" role="status">
      <div className="flex w-40 gap-1" aria-hidden="true">
        <span className={filled} />
        <span className={score >= 1 ? filled : empty} />
        <span className={score >= 2 ? filled : empty} />
        <span className={score >= 3 ? filled : empty} />
      </div>
      <span className={`text-xs ${labelClasses[score]}`} lang={htmlLang[locale]}>
        {labels[score]}
      </span>
    </div>
  );
}
