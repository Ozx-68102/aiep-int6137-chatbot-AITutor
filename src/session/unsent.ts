const key = 'h2bot-unsent';

export function readUnsent(): string {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function saveUnsent(text: string): void {
  try {
    sessionStorage.setItem(key, text);
  } catch {
    return;
  }
}

export function clearUnsent(): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    return;
  }
}
