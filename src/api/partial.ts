import {ApiError, isRecord, requestJson} from './http.ts';

export type PartialReply = {
  status: string | null;
  text: string;
};

export async function readPartial(sessionId: string): Promise<PartialReply> {
  const body = await requestJson(`/api/sessions/${sessionId}/partial`);
  if (!isPartialReply(body)) {
    throw new ApiError(0, null);
  }
  return body;
}

export async function readPartialSafe(sessionId: string): Promise<PartialReply> {
  try {
    return await readPartial(sessionId);
  } catch {
    return {status: null, text: ''};
  }
}

function isPartialReply(value: unknown): value is PartialReply {
  return (
    isRecord(value) &&
    (value.status === null || typeof value.status === 'string') &&
    typeof value.text === 'string'
  );
}
