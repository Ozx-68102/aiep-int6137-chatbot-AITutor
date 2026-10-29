import type {Session} from '../type/chat.ts';
import {isLocale, type Locale} from '../type/locale.ts';
import {ApiError, isRecord, requestEmpty, requestJson} from './http.ts';

export type SessionItem = {
  id: string;
  title: string | null;
  title_locale: string | null;
  pinned: boolean;
  pinned_at: string | null;
  created_at: string;
};

export type LoginResult = {
  locale: string;
  sessions: SessionItem[];
};

export async function login(username: string, password: string): Promise<LoginResult> {
  const body = await requestJson('/api/login', {
    method: 'POST',
    body: JSON.stringify({username, password}),
  });
  if (!isLoginResult(body)) {
    throw new ApiError(0, null);
  }
  return body;
}

export async function listSessions(): Promise<SessionItem[]> {
  const body = await requestJson('/api/sessions');
  if (!isSessionList(body)) {
    throw new ApiError(0, null);
  }
  return body;
}

export async function renameSession(
  sessionId: string,
  title: string,
  titleLocale: Locale | null = null,
): Promise<SessionItem> {
  const body = await requestJson(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({title, title_locale: titleLocale}),
  });
  if (!isSessionItem(body)) {
    throw new ApiError(0, null);
  }
  return body;
}

export async function pinSession(
  sessionId: string,
  pinned: boolean,
  pinnedAt: string | null,
): Promise<SessionItem> {
  const body = await requestJson(`/api/sessions/${sessionId}/pin`, {
    method: 'PATCH',
    body: JSON.stringify({pinned, pinned_at: pinnedAt}),
  });
  if (!isSessionItem(body)) {
    throw new ApiError(0, null);
  }
  return body;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await requestEmpty(`/api/sessions/${sessionId}`, {method: 'DELETE'});
}

export async function createSession(
  title: string | null = null,
  titleLocale: Locale | null = null,
): Promise<SessionItem> {
  const body = await requestJson('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({title, title_locale: titleLocale}),
  });
  if (!isSessionItem(body)) {
    throw new ApiError(0, null);
  }
  return body;
}

export function sessionsFromList(items: SessionItem[]): Session[] {
  return items.map((item) => sessionFromItem(item, false)).reverse();
}

export function emptySession(item: SessionItem): Session {
  return sessionFromItem(item, true);
}

function sessionFromItem(item: SessionItem, messagesKnown: boolean): Session {
  return {
    id: item.id,
    title: item.title,
    titleLocale: isLocale(item.title_locale) ? item.title_locale : null,
    pinned: item.pinned,
    pinnedAt: item.pinned_at,
    messages: [],
    messagesKnown,
  };
}

function isLoginResult(value: unknown): value is LoginResult {
  return isRecord(value)
    && typeof value.locale === 'string'
    && isSessionList(value.sessions);
}

function isSessionList(value: unknown): value is SessionItem[] {
  return Array.isArray(value) && value.every(isSessionItem);
}

function isSessionItem(value: unknown): value is SessionItem {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.title === null || typeof value.title === 'string')
    && (value.title_locale === null || typeof value.title_locale === 'string')
    && typeof value.pinned === 'boolean'
    && (value.pinned_at === null || typeof value.pinned_at === 'string')
    && typeof value.created_at === 'string';
}
