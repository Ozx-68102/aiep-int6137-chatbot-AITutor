import type {Locale} from '../type/locale.ts';
import {ApiError, isRecord, readDetail} from './http.ts';
import {readPartial} from './partial.ts';

export type ReplyOutcome =
  /** 收到了 [DONE]，这一轮写完了。 */
  | 'completed'
  /** 连接断了，服务器那边可能还在写，页面要接着等。 */
  | 'interrupted'
  /** 请求没有落地，服务器那边根本没有这一轮，可以安全重发。 */
  | 'not-started'
  /** 用户按了停止，这一轮就此打住。 */
  | 'aborted'
  /** 这场会话已经有一轮在写，这一次没发出去。 */
  | 'busy';

export async function streamReply(
  chatId: string,
  message: string,
  locale: Locale,
  turnId: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  retryOf?: string,
): Promise<ReplyOutcome> {
  const outcome = await deliverReply(chatId, message, locale, turnId, onDelta, signal, retryOf);
  if (outcome !== 'not-started') {
    return outcome;
  }
  // 服务器说没有这一轮，说明请求没落地，重发一次不会生成两遍。
  return deliverReply(chatId, message, locale, turnId, onDelta, signal, retryOf);
}

async function deliverReply(
  chatId: string,
  message: string,
  locale: Locale,
  turnId: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  retryOf?: string,
): Promise<ReplyOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message, chatId, locale, turnId, retryOf}),
      signal,
    });
  } catch {
    if (signal?.aborted) {
      return 'aborted';
    }
    return await outcomeAfterFailure(chatId);
  }

  if (response.status === 409) {
    // 同一场会话已经有一轮在写。这一次没发出去，页面把问题放回输入框。
    return 'busy';
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
    if (signal?.aborted) {
      return 'aborted';
    }
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
    if (partial.status === 'aborted') {
      return 'aborted';
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
      // 事件边界同时认 \n\n 和 \r\n\r\n。
      const parts = buffer.split(/\r?\n\r?\n/);
      if (done) {
        buffer = '';
      } else {
        buffer = parts.pop() ?? '';
      }
      for (const part of parts) {
        for (const piece of piecesFromEvent(part)) {
          if (piece.kind === 'done') {
            return true;
          }
          if (piece.kind === 'text') {
            onDelta(piece.text);
          }
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

type StreamPiece = {kind: 'text'; text: string} | {kind: 'done'};

/**
 * 把一个事件拆成片段列表。按 SSE 规范，同一事件里多条 data 行先用 \n 连成
 * 一帧再解析；连起来解析不出来时退回逐行认：坏的行丢掉，其余的行（可能
 * 有 [DONE]）照常处理——一帧坏 JSON 只拖累它自己。`event: xxx` 这样的
 * 命名事件行整个忽略，只认 data（为将来后端加命名事件做准备）。
 */
function piecesFromEvent(event: string): StreamPiece[] {
  const dataLines: string[] = [];
  for (const rawLine of event.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) {
      continue;
    }
    dataLines.push(line.slice('data:'.length).trim());
  }
  if (dataLines.length === 0) {
    return [];
  }
  if (dataLines.length === 1) {
    const piece = pieceFromData(dataLines[0]);
    return piece === null ? [] : [piece];
  }
  const joined = pieceFromData(dataLines.join('\n'));
  if (joined !== null) {
    return [joined];
  }
  const pieces: StreamPiece[] = [];
  for (const data of dataLines) {
    const piece = pieceFromData(data);
    if (piece !== null) {
      pieces.push(piece);
    }
  }
  return pieces;
}

/** 认一帧 data：[DONE] 是收尾，JSON 是一段增量；解析失败就丢掉这一帧。 */
function pieceFromData(data: string): StreamPiece | null {
  if (data === '[DONE]') {
    return {kind: 'done'};
  }
  try {
    const content = contentFromPayload(JSON.parse(data));
    if (content) {
      return {kind: 'text', text: content};
    }
  } catch {
    // 这一帧的 JSON 是坏的，丢掉。
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
