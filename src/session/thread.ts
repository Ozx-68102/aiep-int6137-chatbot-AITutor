import {readMessages} from '../api/messages.ts';
import type {HistoryPage} from '../api/messages.ts';
import {readPartial} from '../api/partial.ts';
import type {PartialReply} from '../api/partial.ts';
import type {Message} from '../type/chat.ts';

const historyPageSize = 20;

export async function loadThread(sessionId: string): Promise<Message[]> {
  const [records, partial] = await Promise.all([
    readEveryMessage(sessionId),
    readPartial(sessionId),
  ]);
  return withPartial(records, partial);
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
  if (partial.status === null || partial.text === '') {
    return messages;
  }
  const last = messages.at(-1);
  if (last?.role === 'assistant') {
    if (last.text === partial.text || last.text.startsWith(partial.text)) {
      return messages;
    }
    if (partial.text.startsWith(last.text)) {
      return [...messages.slice(0, -1), {...last, text: partial.text}];
    }
  }
  return [
    ...messages,
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: partial.text,
    },
  ];
}
