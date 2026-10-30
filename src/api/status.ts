import {ApiError, isRecord, requestJson} from './http.ts';

export type BackendStatus = {
  database: 'ok' | 'unavailable';
  reply_store: 'ok' | 'unavailable';
};

export async function readStatus(): Promise<BackendStatus> {
  const body = await requestJson('/api/status');
  if (!isBackendStatus(body)) {
    throw new ApiError(0, null);
  }
  return body;
}

function isBackendStatus(value: unknown): value is BackendStatus {
  return (
    isRecord(value) &&
    (value.database === 'ok' || value.database === 'unavailable') &&
    (value.reply_store === 'ok' || value.reply_store === 'unavailable')
  );
}
