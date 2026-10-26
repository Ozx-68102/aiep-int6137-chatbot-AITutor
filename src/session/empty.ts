import type {Session} from '../type/chat.ts';

export function sessionTitle(session: Session, fallback: string): string {
  return session.title ?? fallback;
}
