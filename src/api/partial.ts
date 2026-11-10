import {ApiError, isRecord, requestJson, UnexpectedResponseError} from './http.ts';

/**
 * 「还在写吗」的半截回答（GET /api/sessions/{id}/partial）。
 *
 * 接口只回答这一个问题：这一轮还在写才回 200（status 恒为 streaming），
 * 其余一切情况（写完了/失败/被停/键不存在）都是 404。结局语义不再从
 * 这个接口来：即时结局随流的 done 帧走，永久结局在数据库的消息上
 * （/messages 的 failed/aborted 标志）。
 */
export type PartialReply = {
  status: 'streaming';
  text: string;
  /** 当前这一轮的编号。 */
  turnId: string | null;
  /** 当前这一轮用户问的话。 */
  question: string | null;
};

/**
 * 问服务器「还在写吗」的四种结果。
 *
 * 「服务器明确说没在写」（idle，404）和「没问到服务器」（unreachable，
 * 网络错等）必须分开：前者可以安全地以数据库为准，后者什么都不知道，
 * 不能替服务器下结论。
 *
 * 401（unauthorized）同样不能归进 unreachable：401 是会话死了，服务器
 * 可以连通、也答了话，页面要走会话过期的处理（留在原页面的过期状态、
 * 带 reason 的重新登录入口），不是「连不上服务器」的连接横幅。error
 * 带上是为了调用方能读 reason。
 */
export type PartialProbe =
  | {kind: 'streaming'; partial: PartialReply}
  | {kind: 'idle'}
  | {kind: 'unauthorized'; error: ApiError}
  | {kind: 'unreachable'; error: unknown};

export async function readPartial(sessionId: string): Promise<PartialReply> {
  const body = await requestJson(`/api/sessions/${sessionId}/partial`);
  if (!isPartialReply(body)) {
    throw new UnexpectedResponseError();
  }
  return {
    status: body.status,
    text: body.text,
    turnId: body.turn_id,
    question: body.question,
  };
}

/** 不抛错的 readPartial：把结果分成四种，调用方按 kind 分支。 */
export async function probePartial(sessionId: string): Promise<PartialProbe> {
  try {
    return {kind: 'streaming', partial: await readPartial(sessionId)};
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // 会话死了：单列一种结果，由调用方走会话过期的处理。
      return {kind: 'unauthorized', error};
    }
    if (error instanceof ApiError && error.status === 404) {
      // 服务器明确说：这一轮没在写。
      return {kind: 'idle'};
    }
    return {kind: 'unreachable', error};
  }
}

function isPartialReply(value: unknown): value is {
  status: 'streaming';
  text: string;
  turn_id: string | null;
  question: string | null;
} {
  return (
    isRecord(value) &&
    value.status === 'streaming' &&
    typeof value.text === 'string' &&
    (value.turn_id === null || typeof value.turn_id === 'string') &&
    (value.question === null || typeof value.question === 'string')
  );
}
