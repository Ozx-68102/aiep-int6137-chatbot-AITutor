import type {Session} from '../type/chat.ts';

export function orderSessions(sessions: Session[]): Session[] {
  const pinned = sessions.filter((session) => session.pinned);
  const rest = sessions.filter((session) => !session.pinned);
  pinned.sort((left, right) => comparePinTime(left.pinnedAt, right.pinnedAt));
  return [...pinned, ...rest];
}

function comparePinTime(left: string | null, right: string | null): number {
  const leftTime = pinTime(left);
  const rightTime = pinTime(right);
  if (leftTime === null && rightTime === null) {
    return 0;
  }
  if (leftTime === null) {
    return 1;
  }
  if (rightTime === null) {
    return -1;
  }
  return leftTime - rightTime;
}

function pinTime(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return null;
  }
  return time;
}
