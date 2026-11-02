import {translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {passwordStrength} from './password-strength.ts';

// 每档的配色跟着仓库的 stone/emerald 体系走：太弱用报错的红，弱是中性灰，
// 一般和强用深浅两档 emerald。
const segmentClasses = ['bg-red-600', 'bg-stone-400', 'bg-emerald-600', 'bg-emerald-900'];
const labelClasses = ['text-red-600', 'text-stone-500', 'text-emerald-600', 'text-emerald-900'];

/**
 * 密码强度表：4 格条 + 档位标签，亮起 score + 1 格。
 * 只是建议，不拦提交；密码为空时不渲染（还没东西可评）。
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
  if (password === '') {
    return null;
  }
  const score = passwordStrength(password, username);
  const labels = [text.strengthTooWeak, text.strengthWeak, text.strengthFair, text.strengthStrong];
  const filled = `h-1.5 w-full rounded-full transition-colors duration-150 ease-out motion-reduce:transition-none ${segmentClasses[score]}`;
  const empty =
    'h-1.5 w-full rounded-full bg-stone-200 transition-colors duration-150 ease-out motion-reduce:transition-none';

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
