export type Locale = 'zh-CN' | 'zh-TW' | 'en';

export function isLocale(value: string | null): value is Locale {
  return value === 'zh-CN' || value === 'zh-TW' || value === 'en';
}

export function localeFromSystem(): Locale {
  const tags = navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    const match = localeFromTag(tag);
    if (match) {
      return match;
    }
  }
  return 'en';
}

function localeFromTag(tag: string): Locale | null {
  if (tag.trim() === '') {
    return null;
  }
  let parsed: Intl.Locale;
  try {
    parsed = new Intl.Locale(tag).maximize();
  } catch {
    return null;
  }
  if (parsed.language === 'en') {
    return 'en';
  }
  if (parsed.language !== 'zh') {
    return null;
  }
  if (parsed.script === 'Hant' || parsed.region === 'TW' || parsed.region === 'HK' || parsed.region === 'MO') {
    return 'zh-TW';
  }
  return 'zh-CN';
}
