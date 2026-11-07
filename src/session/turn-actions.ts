import type {PartialReply} from '../api/partial.ts';
import type {Message} from '../type/chat.ts';
import type {Locale} from '../type/locale.ts';
import {visibleText} from './text.ts';

/**
 * 轮次问答的消息变换：全部是纯函数，消息数组进、新数组（或查找结果）出，
 * 不碰任何组件状态。写回会话状态由调用方（use-turn-engine、use-reply-recovery）
 * 包一层 updateSession 完成。这些函数从 use-turn-engine.ts 拆出来，逻辑原样保留。
 */

/** 把流式增量拼进气泡文本；拼完还没有可见文字时 waiting 保持为真。 */
export function applyStreamText(messages: Message[], messageId: string, chunk: string): Message[] {
  return messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }
    const text = message.text + chunk;
    return {...message, text, waiting: visibleText(message.role, text) === ''};
  });
}

/**
 * 把服务器问回来的半截文字写进气泡。没有任何可改的地方时返回原数组
 * （同一份引用），调用方据此保持 session 对象不变。
 */
export function applyPartialText(
  messages: Message[],
  turnId: string,
  partial: PartialReply,
  locale: Locale,
  fallbackKey: string,
): Message[] {
  let index = messages.findIndex((message) => message.turnId === turnId);
  if (index === -1 && fallbackKey !== '') {
    // 按轮次编号找不到气泡：用消息 id 保底，只认还在等待中的那条。
    index = messages.findIndex((message) => message.id === fallbackKey && message.waiting === true);
  }
  if (index === -1) {
    if (turnId === '') {
      // 没有轮次编号、保底也没找到：不补气泡，等下一个周期。
      return messages;
    }
    // 这一轮还没进到页面里（比如刚刷新完），先补一个气泡。
    // 走到这里的一定是「还在写」的 partial（接口 200 只回 streaming）。
    const message: Message = {
      id: turnId,
      role: 'assistant',
      text: partial.text,
      locale,
      turnId,
      waiting: true,
    };
    return [...messages, message];
  }
  const message = messages[index];
  if (message === undefined) {
    // index 来自 findIndex 且已排除 -1，元素必然存在，这里只是类型上的保底处理
    return messages;
  }
  if (!partial.text.startsWith(message.text)) {
    return messages;
  }
  const waiting = visibleText(message.role, partial.text) === '';
  const next = [...messages];
  next[index] = {...message, text: partial.text, waiting};
  return next;
}

/** 把这一轮的回答气泡去掉，提问留着。 */
export function removeTurnAnswer(messages: Message[], turnId: string): Message[] {
  return messages.filter((message) => !(message.turnId === turnId && message.role === 'assistant'));
}

/** 把这一轮的提问和气泡一起去掉（这一轮根本没发出去）。 */
export function removeTurn(messages: Message[], turnId: string): Message[] {
  return messages.filter((message) => message.turnId !== turnId);
}

/**
 * 把这一轮的回答标成失败/被停：脚注里的常驻状态提示和重试按钮由消息
 * 自身的标志驱动（docs/MESSAGE_ACTIONS.md），实时流程里就打上标记，不只靠
 * 刷新后的服务器标志。waiting 一并清掉，零文字的轮次不再显示三个点；
 * 气泡不去掉——没有文字时只渲染脚注。
 */
export function markTurnStatus(
  messages: Message[],
  turnId: string,
  status: 'failed' | 'aborted',
): Message[] {
  const mark = status === 'failed' ? {failed: true} : {aborted: true};
  return messages.map((message) =>
    message.turnId === turnId && message.role === 'assistant'
      ? {...message, waiting: false, ...mark}
      : message,
  );
}

/**
 * 发送没成功：把这一轮恢复成重发之前的样子（提问文字、回答、状态标志都在内）。
 * snapshot 为空时由调用方直接不调用（连 updateSession 都不触发），这里只管拼接。
 */
export function restoreTurn(
  messages: Message[],
  turnId: string,
  indexStart: number,
  snapshot: Message[],
): Message[] {
  const existing = messages.findIndex((message) => message.turnId === turnId);
  const without = messages.filter((message) => message.turnId !== turnId);
  const at = Math.min(existing === -1 ? indexStart : existing, without.length);
  return [...without.slice(0, at), ...snapshot, ...without.slice(at)];
}

/**
 * 某一轮问的是什么。
 *
 * 先按轮次编号认提问那条。提问不一定带这一轮的编号：刷新以后看到的
 * 提问是上游的记录，上游不知道我们的编号。那就按位置找 —— 这一轮的
 * 回答前面最近的一条提问。
 */
export function questionOfTurn(messages: Message[], turnId: string): string | null {
  const own = messages.find((message) => message.role === 'user' && message.turnId === turnId);
  if (own !== undefined) {
    return own.text;
  }
  const answer = messages.findIndex(
    (message) => message.role === 'assistant' && message.turnId === turnId,
  );
  for (let index = answer - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === 'user') {
      return message.text;
    }
  }
  return null;
}
