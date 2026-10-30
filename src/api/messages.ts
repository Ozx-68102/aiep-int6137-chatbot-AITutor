import {ApiError, isRecord, requestJson} from './http.ts';
import type {Message} from '../type/chat.ts';

export type HistoryMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  turn_id: string | null;
  waiting: boolean;
};

/** 一场会话的完整线程。服务器已经把正在写的那一轮接在历史后面了。 */
export async function readMessages(sessionId: string): Promise<Message[]> {
  const body = await requestJson(`/api/sessions/${sessionId}/messages`);
  if (!isHistoryPage(body)) {
    throw new ApiError(0, null);
  }
  return body.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turn_id ?? undefined,
    waiting: message.waiting,
  }));
}

function isHistoryPage(value: unknown): value is {messages: HistoryMessage[]} {
  return isRecord(value) && Array.isArray(value.messages) && value.messages.every(isHistoryMessage);
}

function isHistoryMessage(value: unknown): value is HistoryMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.text === 'string' &&
    (value.turn_id === null || typeof value.turn_id === 'string') &&
    typeof value.waiting === 'boolean'
  );
}
