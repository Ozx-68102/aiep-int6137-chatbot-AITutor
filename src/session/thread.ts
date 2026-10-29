import {readMessages} from '../api/messages.ts';
import type {HistoryPage} from '../api/messages.ts';
import {readPartialSafe} from '../api/partial.ts';
import type {PartialReply} from '../api/partial.ts';
import type {Message} from '../type/chat.ts';

const historyPageSize = 20;

export type Thread = {
  messages: Message[];
  partial: PartialReply;
};

export async function loadThread(sessionId: string): Promise<Thread> {
  const [records, partial] = await Promise.all([
    readEveryMessage(sessionId),
    readPartialSafe(sessionId),
  ]);
  return {messages: withPartial(records, partial), partial};
}

async function readEveryMessage(sessionId: string): Promise<HistoryPage['messages']> {
  const collected: HistoryPage['messages'] = [];
  let offset = 0;
  let total = 0;
  do {
    const page = await readMessages(sessionId, offset, historyPageSize);
    total = page.total;
    collected.push(...page.messages);
    offset += historyPageSize;
  } while (offset < total);
  return collected;
}

function withPartial(records: HistoryPage['messages'], partial: PartialReply): Message[] {
  const messages: Message[] = records.map((record) => ({
    id: record.id,
    role: record.role,
    text: record.text,
  }));
  if (partial.status === null) {
    return messages;
  }
  const waiting = partial.status === 'streaming';
  const last = messages.at(-1);
  if (last?.role === 'assistant') {
    if (last.text === partial.text || last.text.startsWith(partial.text)) {
      return waiting ? withWaiting(messages) : messages;
    }
    if (partial.text.startsWith(last.text)) {
      const merged = [...messages.slice(0, -1), {...last, text: partial.text}];
      return waiting ? withWaiting(merged) : merged;
    }
  }
  return [
    ...messages,
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: partial.text,
      waiting,
    },
  ];
}

function withWaiting(messages: Message[]): Message[] {
  const last = messages.at(-1);
  if (last === undefined || last.role !== 'assistant') {
    return messages;
  }
  return [...messages.slice(0, -1), {...last, waiting: true}];
}
