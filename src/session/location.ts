const parameter = 'session';

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

function writeSessionToUrl(sessionId: string | null, mode: 'push' | 'replace'): void {
  const url = new URL(window.location.href);
  if (sessionId === null) {
    url.searchParams.delete(parameter);
  } else {
    url.searchParams.set(parameter, sessionId);
  }
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
