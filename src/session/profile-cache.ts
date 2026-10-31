import {isLocale, type Locale} from '../type/locale.ts';

const key = 'h2bot-profile';

export type CachedProfile = {username: string; locale: Locale};

/**
 * 把用户名和语言记在本地：接口服务连不上的时候，页面上还是知道「我是谁、
 * 我用哪种语言」，不用等服务器回来。
 */
export function readCachedProfile(): CachedProfile | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as {username?: unknown; locale?: unknown};
    const username = typeof parsed.username === 'string' ? parsed.username : null;
    const locale = typeof parsed.locale === 'string' ? parsed.locale : null;
    if (username === null || username === '' || !isLocale(locale)) {
      return null;
    }
    return {username, locale};
  } catch {
    return null;
  }
}

export function saveCachedProfile(profile: CachedProfile): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(profile));
  } catch {
    return;
  }
}

export function clearCachedProfile(): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}
