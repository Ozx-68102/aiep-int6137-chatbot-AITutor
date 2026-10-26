import {isLocale} from '../type/locale.ts';
import type {Session} from '../type/chat.ts';
import {ApiError, isRecord, requestJson} from './http.ts';

export type SessionItem = {
  id: string;
  title: string | null;
  title_locale: string | null;
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

export async function createSession(): Promise<SessionItem> {
  const body = await requestJson('/api/sessions', {method: 'POST'});
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
    && typeof value.created_at === 'string';
}
