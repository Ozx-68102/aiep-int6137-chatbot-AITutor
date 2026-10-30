import type {Locale} from '../type/locale.ts';
import {ApiError, isRecord, readDetail} from './http.ts';
import {readPartial} from './partial.ts';

export type ReplyOutcome =
  /** 收到了 [DONE]，这一轮写完了。 */
  | 'completed'
  /** 连接断了，服务器那边可能还在写，页面要接着等。 */
  | 'interrupted'
  /** 请求没有落地，服务器那边根本没有这一轮，可以安全重发。 */
  | 'not-started';

export async function streamReply(
  chatId: string,
  message: string,
  locale: Locale,
  onDelta: (text: string) => void,
): Promise<ReplyOutcome> {
  const outcome = await deliverReply(chatId, message, locale, onDelta);
  if (outcome !== 'not-started') {
    return outcome;
  }
  // 服务器说没有这一轮，说明请求没落地，重发一次不会生成两遍。
  return deliverReply(chatId, message, locale, onDelta);
}

async function deliverReply(
  chatId: string,
  message: string,
  locale: Locale,
  onDelta: (text: string) => void,
): Promise<ReplyOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message, chatId, locale}),
    });
  } catch {
    return await outcomeAfterFailure(chatId);
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readDetail(response));
  }

  let delivered = false;
  try {
    const completed = await readStream(response, (text) => {
      delivered = true;
      onDelta(text);
    });
    return completed ? 'completed' : 'interrupted';
  } catch {
    if (delivered) {
      return 'interrupted';
    }
    return await outcomeAfterFailure(chatId);
  }
}

/**
 * 连接断了的时候问服务器：这一轮到底有没有在生成。
 * 服务器说有 → 它还在写，页面去接着等；说没有 → 请求没落地，可以重发；
 * 问不到 → 不知道，就不重发，免得生成两遍。
 */
async function outcomeAfterFailure(chatId: string): Promise<ReplyOutcome> {
  try {
    const partial = await readPartial(chatId);
    if (partial.status === null) {
      return 'not-started';
    }
  } catch {
    return 'interrupted';
  }
  return 'interrupted';
}

async function readStream(response: Response, onDelta: (text: string) => void): Promise<boolean> {
  const body = response.body;
  if (!body) {
    return false;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      buffer += decoder.decode(value, {stream: !done});
      const parts = buffer.split('\n\n');
      if (done) {
        buffer = '';
      } else {
        buffer = parts.pop() ?? '';
      }
      for (const part of parts) {
        const piece = pieceFromEvent(part);
        if (piece?.kind === 'done') {
          return true;
        }
        if (piece?.kind === 'text') {
          onDelta(piece.text);
        }
      }
      if (done) {
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function pieceFromEvent(event: string): {kind: 'text'; text: string} | {kind: 'done'} | null {
  for (const rawLine of event.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) {
      continue;
    }
    const data = line.slice('data:'.length).trim();
    if (data === '[DONE]') {
      return {kind: 'done'};
    }
    try {
      const content = contentFromPayload(JSON.parse(data));
      if (content) {
        return {kind: 'text', text: content};
      }
    } catch {
      return null;
    }
  }
  return null;
}

function contentFromPayload(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    return null;
  }
  const first: unknown = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.delta)) {
    return null;
  }
  const content = first.delta.content;
  if (typeof content !== 'string' || content === '') {
    return null;
  }
  return content;
}
