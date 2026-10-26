import {readMessages} from '../api/messages.ts';
import {ApiError} from '../api/http.ts';
import type {Session} from '../type/chat.ts';

const probePageSize = 1;

export async function markEmptySessions(sessions: Session[]): Promise<Session[]> {
  return Promise.all(sessions.map(markEmptySession));
}

async function markEmptySession(session: Session): Promise<Session> {
  if (session.messagesKnown) {
    return session;
  }
  try {
    const page = await readMessages(session.id, 0, probePageSize);
    if (page.total === 0) {
      return {...session, messagesKnown: true};
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw error;
    }
  }
  return session;
}
