import type {Session} from '../type/chat.ts';

export function isEmptySession(session: Session): boolean {
  return session.messagesKnown && session.messages.length === 0;
}

export function sessionTitle(session: Session, fallback: string): string {
  return session.title ?? fallback;
}
