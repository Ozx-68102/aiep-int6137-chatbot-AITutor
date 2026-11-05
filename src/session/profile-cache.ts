import {isLocale, type Locale} from '../type/locale.ts';

/** 用户名与语言的本地缓存键：多标签页同步（App 的 storage 监听）认它。 */
export const profileCacheKey = 'h2bot-profile';
// 头像缓存单独一个 key：dataURL 化以后可能有几 MB，混进 h2bot-profile 里
// 一旦超配额，会连用户名带语言一起写不进去。分开存，一边失败不牵连另一边。
export const avatarCacheKey = 'h2bot-avatar';
// 主动登出标记（P7）：登出成功的标签页写入时间戳值，其他标签页听到
// storage 事件立即回登录界面，不等下一次 401。服务器侧吊销（会话过期、
// 账号停用）不写这个标记，仍由 401 兜底——两者分工不同。
export const logoutMarkerKey = 'h2bot-logout';

export type CachedProfile = {username: string; locale: Locale};

/**
 * 把用户名和语言记在本地：接口服务连不上的时候，页面上还是知道「我是谁、
 * 我用哪种语言」，不用等服务器回来。
 */
export function readCachedProfile(): CachedProfile | null {
  try {
    const raw = window.localStorage.getItem(profileCacheKey);
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
    window.localStorage.setItem(profileCacheKey, JSON.stringify(profile));
  } catch {
    return;
  }
}

export function clearCachedProfile(): void {
  try {
    window.localStorage.removeItem(profileCacheKey);
    // 退出登录把头像缓存连同资料一起清掉，维持「退出即清」的设计。
    window.localStorage.removeItem(avatarCacheKey);
  } catch {
    return;
  }
}

type CachedAvatar = {url: string; dataUrl: string};

function readAvatarEntry(): CachedAvatar | null {
  try {
    const raw = window.localStorage.getItem(avatarCacheKey);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as {url?: unknown; dataUrl?: unknown};
    if (typeof parsed.url !== 'string' || typeof parsed.dataUrl !== 'string') {
      return null;
    }
    return {url: parsed.url, dataUrl: parsed.dataUrl};
  } catch {
    return null;
  }
}

/** 本地缓存的头像 dataURL，没有就 null。离线启动时先用它顶住「我长什么样」。 */
export function readCachedAvatarData(): string | null {
  const entry = readAvatarEntry();
  return entry !== null && entry.dataUrl !== '' ? entry.dataUrl : null;
}

/**
 * 把真头像抓成 dataURL 存进本地：离线启动时优先显示它，不闪默认图。
 *
 * 头像地址是本仓库接口服务发出的同源相对路径，fetch 默认的 same-origin
 * 凭证模式会带上 login cookie，不算绕开 http.ts 裸调接口。同一个地址已经
 * 缓存过就跳过，不重复抓。超过 5MB（与上传门槛一致）不存：dataURL 编码
 * 还要再胀大约三分之一，太大写不进配额也没有意义。离线、抓取失败、配额
 * 不够（QuotaExceededError）都静默放弃，界面退回现状（离线启动显示默认
 * 头像），不弹任何提示。
 */
export async function cacheAvatarData(url: string): Promise<void> {
  try {
    if (readAvatarEntry()?.url === url) {
      return;
    }
    const response = await fetch(url);
    if (!response.ok) {
      return;
    }
    const blob = await response.blob();
    if (blob.size > 5 * 1024 * 1024) {
      return;
    }
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(typeof reader.result === 'string' ? reader.result : null);
      };
      reader.onerror = () => {
        resolve(null);
      };
      reader.readAsDataURL(blob);
    });
    if (dataUrl === null) {
      return;
    }
    const entry: CachedAvatar = {url, dataUrl};
    window.localStorage.setItem(avatarCacheKey, JSON.stringify(entry));
  } catch {
    return;
  }
}

/**
 * 写入主动登出标记（P7）：值是写入时刻的时间戳，只用来区分「新标记」，
 * 数值本身没有业务含义。storage 事件不派发给写入方标签页，所以写完标记
 * 的登出方不会被自己二次触发。
 */
export function writeLogoutMarker(): void {
  try {
    window.localStorage.setItem(logoutMarkerKey, String(Date.now()));
  } catch {
    return;
  }
}

/**
 * 登录后清掉登出标记：事件只认写入瞬间，墓碑不必留着。清除同样会广播
 * 一次 newValue 为 null 的 storage 事件，消费方只认 newValue 非 null 的
 * 写入，不会被误踢。
 */
export function clearLogoutMarker(): void {
  try {
    window.localStorage.removeItem(logoutMarkerKey);
  } catch {
    return;
  }
}
