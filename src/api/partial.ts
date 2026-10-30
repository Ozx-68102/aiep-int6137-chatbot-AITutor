import {ApiError, isRecord, requestJson} from './http.ts';

export type PartialReply = {
  status: string | null;
  text: string;
  /** 当前这一轮的编号。 */
  turnId: string | null;
  /** 当前这一轮用户问的话。 */
  question: string | null;
};

export async function readPartial(sessionId: string): Promise<PartialReply> {
  const body = await requestJson(`/api/sessions/${sessionId}/partial`);
  if (!isPartialReply(body)) {
    throw new ApiError(0, null);
  }
  return {
    status: body.status,
    text: body.text,
    turnId: body.turn_id,
    question: body.question,
  };
}

export async function readPartialSafe(sessionId: string): Promise<PartialReply> {
  try {
    return await readPartial(sessionId);
  } catch {
    return {status: null, text: '', turnId: null, question: null};
  }
}

function isPartialReply(value: unknown): value is {
  status: string | null;
  text: string;
  turn_id: string | null;
  question: string | null;
} {
  return (
    isRecord(value) &&
    (value.status === null || typeof value.status === 'string') &&
    typeof value.text === 'string' &&
    (value.turn_id === null || typeof value.turn_id === 'string') &&
    (value.question === null || typeof value.question === 'string')
  );
}
