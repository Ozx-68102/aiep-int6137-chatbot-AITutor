import {translations} from '../../i18n.ts';
import type {Locale} from '../../type/locale.ts';

export function accountLine(locale: Locale, name: string): string {
  if (locale === 'en') {
    return `${translations.en.username}: ${name}`;
  }
  return `${translations[locale].username}：${name}`;
}
