import {requestEmpty} from './http.ts';

/** 一轮的好坏反馈：good=点赞，bad=点踩，null=取消之前的反馈。 */
export type FeedbackValue = 'good' | 'bad' | null;

/**
 * 把这一轮的点赞/点踩送给后端代理（POST /api/sessions/:id/feedback），
 * 后端转给上游 FastGPT 的 updateUserFeedback（docs/FASTGPT_API.md
 * 「点赞与点踩」）：轮次编号就是上游那条回答记录的 dataId。
 *
 * 走 requestEmpty：POST 默认不自动重试——反馈是有副作用的写请求，
 * 断线时盲目重发不值得，失败交给调用方提示。
 */
export async function sendFeedback(
  sessionId: string,
  turnId: string,
  feedback: FeedbackValue,
): Promise<void> {
  await requestEmpty(`/api/sessions/${sessionId}/feedback`, {
    method: 'POST',
    body: JSON.stringify({turnId, feedback}),
  });
}
