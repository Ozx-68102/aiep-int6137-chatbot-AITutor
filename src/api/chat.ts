import type {Locale} from '../type/locale.ts';
import {ApiError, isRecord, readDetail} from './http.ts';

export async function streamReply(
  chatId: string,
  message: string,
  locale: Locale,
  onDelta: (text: string) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message, chatId, locale}),
    });
  } catch {
    throw new ApiError(0, null);
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readDetail(response));
  }

  let delivered = false;
  try {
    await readStream(response, (text) => {
      delivered = true;
      onDelta(text);
    });
  } catch {
    if (delivered) {
      return;
    }
    throw new ApiError(0, null);
  }
}

async function readStream(response: Response, onDelta: (text: string) => void): Promise<void> {
  const body = response.body;
  if (!body) {
    return;
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
          return;
        }
        if (piece?.kind === 'text') {
          onDelta(piece.text);
        }
      }
      if (done) {
        return;
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
