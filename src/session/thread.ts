import {readMessages} from '../api/messages.ts';
import {readPartialSafe} from '../api/partial.ts';
import type {PartialReply} from '../api/partial.ts';
import type {Message} from '../type/chat.ts';

export type Thread = {
  messages: Message[];
  partial: PartialReply;
};

/**
 * 读一场会话的线程。
 *
 * 服务器已经把「正在写的那一轮」接在历史后面了：用户提问、三个点和半截回答
 * 都在里面。所以这里不用再靠文字去猜哪条消息属于当前这一轮。
 */
export async function loadThread(sessionId: string): Promise<Thread> {
  const [messages, partial] = await Promise.all([
    readMessages(sessionId),
    readPartialSafe(sessionId),
  ]);
  return {messages, partial};
}
