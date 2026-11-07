import {readMessages} from '../api/messages.ts';
import {probePartial} from '../api/partial.ts';
import type {PartialProbe} from '../api/partial.ts';
import type {Message} from '../type/chat.ts';

export type Thread = {
  messages: Message[];
  /**
   * 服务器还在不在写当前这一轮。404（idle，明确说没在写）和网络错
   * （unreachable，没问到服务器）是两种结果，调用方按 kind 分支。
   * unauthorized（401，会话死了）不会出现在这里：loadThread 直接把它抛给
   * 调用方的 401 出口。
   */
  partial: PartialProbe;
};

/**
 * 读一场会话的线程。
 *
 * 服务器已经把「正在写的那一轮」接在历史后面了：用户提问、三个点和半截回答
 * 都在里面。所以这里不用再靠文字去猜哪条消息属于当前这一轮。
 *
 * 失败/被停的轮次由服务器在消息上标好（failed / aborted），页面按标志
 * 渲染气泡下方脚注里的状态提示（docs/MESSAGE_ACTIONS.md），不再往消息流里
 * 合成 role:'error' 的错误消息。
 */
export async function loadThread(sessionId: string): Promise<Thread> {
  const [messages, partial] = await Promise.all([readMessages(sessionId), probePartial(sessionId)]);
  if (partial.kind === 'unauthorized') {
    // 会话死了（401）：抛给调用方。引擎里两个调用点（线程历史加载和
    // refreshThread）的 catch 都已有 ApiError 401 的出口（onAuthError，
    // 统一处理），这里抛上去就接上了。并发时如果 readMessages 先抛 401，
    // Promise.all 本来就会拒绝，走的也是同一个出口，不用在这里重复处理。
    throw partial.error;
  }
  return {messages, partial};
}
