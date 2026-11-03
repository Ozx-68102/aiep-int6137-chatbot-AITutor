const parameter = 'session';
const pageParameter = 'page';

export function readSessionFromUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get(parameter);
  if (value === null || value === '') {
    return null;
  }
  return value;
}

export function pushSessionToUrl(sessionId: string | null): void {
  writeSessionToUrl(sessionId, 'push');
}

export function replaceSessionToUrl(sessionId: string | null): void {
  writeSessionToUrl(sessionId, 'replace');
}

/** 地址里的页面参数。目前有 'password'（修改密码页）和 'admin'（管理员控制台）两个取值。 */
export function readPageFromUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get(pageParameter);
  if (value === null || value === '') {
    return null;
  }
  return value;
}

/** 进入独立页面：压一条历史，浏览器后退能回到原来的聊天。 */
export function pushPageToUrl(page: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(pageParameter, page);
  applyUrl(url, 'push');
}

/** 把页面参数从地址里拿掉（session 等其它参数保留），本来就没有则什么也不做。 */
export function replacePageOutOfUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(pageParameter)) {
    return;
  }
  url.searchParams.delete(pageParameter);
  applyUrl(url, 'replace');
}

function writeSessionToUrl(sessionId: string | null, mode: 'push' | 'replace'): void {
  const url = new URL(window.location.href);
  if (sessionId === null) {
    url.searchParams.delete(parameter);
  } else {
    url.searchParams.set(parameter, sessionId);
  }
  applyUrl(url, mode);
}

function applyUrl(url: URL, mode: 'push' | 'replace'): void {
  const target = `${url.pathname}${url.search}${url.hash}`;
  if (target === currentTarget()) {
    return;
  }
  if (mode === 'push') {
    window.history.pushState(null, '', target);
  } else {
    window.history.replaceState(null, '', target);
  }
}

function currentTarget(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}
