import {readMessages} from '../api/messages.ts';
import {readPartialSafe} from '../api/partial.ts';
import type {PartialReply} from '../api/partial.ts';
import {translations} from '../i18n.ts';
import type {Message} from '../type/chat.ts';
import type {Locale} from '../type/locale.ts';

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
export async function loadThread(sessionId: string, locale: Locale): Promise<Thread> {
  const [messages, partial] = await Promise.all([
    readMessages(sessionId),
    readPartialSafe(sessionId),
  ]);
  return {messages: withFailureNotice(messages, locale), partial};
}

/**
 * 失败的回答在页面上是两块：半截回答，加上它下面那条「消息生成失败」。
 * 服务器只说这一轮失败了，那句话由页面按语言写。
 */
function withFailureNotice(messages: Message[], locale: Locale): Message[] {
  const copy = translations[locale].replyInterrupted;
  const result: Message[] = [];
  for (const message of messages) {
    result.push(message);
    if (message.failed === true) {
      result.push({
        id: `${message.id}-failed`,
        role: 'error',
        text: copy,
        locale,
        turnId: message.turnId,
      });
    }
  }
  return result;
}
