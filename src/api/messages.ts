import {ApiError, isRecord, requestJson} from './http.ts';

export type HistoryPage = {
  total: number;
  messages: {
    id: string;
    role: 'user' | 'assistant';
    text: string;
  }[];
};

export async function readMessages(
  sessionId: string,
  offset: number,
  pageSize: number,
): Promise<HistoryPage> {
  const query = new URLSearchParams({
    offset: String(offset),
    page_size: String(pageSize),
  });
  const body = await requestJson(`/api/sessions/${sessionId}/messages?${query.toString()}`);
  if (!isHistoryPage(body)) {
    throw new ApiError(0, null);
  }
  return body;
}

function isHistoryPage(value: unknown): value is HistoryPage {
  return (
    isRecord(value) &&
    typeof value.total === 'number' &&
    Array.isArray(value.messages) &&
    value.messages.every(isHistoryMessage)
  );
}

function isHistoryMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.text === 'string'
  );
}
