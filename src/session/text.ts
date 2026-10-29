import type {Message} from '../type/chat.ts';

export function visibleText(role: Message['role'], text: string): string {
  if (role !== 'assistant') {
    return text;
  }
  return text.replace(/^\n+/, '');
}

export function waitingForText(message: Message): boolean {
  return message.waiting === true && visibleText(message.role, message.text) === '';
}
