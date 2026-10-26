import {isLocale, type Locale} from '../type/locale.ts';
import {ApiError, isRecord, requestEmpty, requestJson} from './http.ts';

export type Profile = {
  id: string;
  username: string;
  locale: Locale;
};

export async function readProfile(): Promise<Profile> {
  return parseProfile(await requestJson('/api/profile'));
}

export async function updateProfile(locale: Locale): Promise<Profile> {
  return parseProfile(await requestJson('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify({locale}),
  }));
}

export async function logout(): Promise<void> {
  await requestEmpty('/api/logout', {method: 'POST'});
}

function parseProfile(value: unknown): Profile {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.username !== 'string' || typeof value.locale !== 'string' || !isLocale(value.locale)) {
    throw new ApiError(0, null);
  }
  return {id: value.id, username: value.username, locale: value.locale};
}
