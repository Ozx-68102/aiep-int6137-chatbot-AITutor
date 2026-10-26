import type {Session} from '../type/chat.ts';

const pinTimesKey = 'h2bot-pin-times';

function readPinTimes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(pinTimesKey);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const times: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'number') {
        times[id] = value;
      }
    }
    return times;
  } catch {
    return {};
  }
}

function writePinTimes(times: Record<string, number>) {
  try {
    localStorage.setItem(pinTimesKey, JSON.stringify(times));
  } catch {
    return;
  }
}

export function rememberPinTime(id: string) {
  const times = readPinTimes();
  times[id] = Date.now();
  writePinTimes(times);
}

export function forgetPinTime(id: string) {
  const times = readPinTimes();
  delete times[id];
  writePinTimes(times);
}

export function orderSessions(sessions: Session[]): Session[] {
  const times = readPinTimes();
  const pinned = sessions.filter((session) => session.pinned);
  const rest = sessions.filter((session) => !session.pinned);
  pinned.sort((left, right) => {
    const leftTime = times[left.id];
    const rightTime = times[right.id];
    if (leftTime === undefined && rightTime === undefined) {
      return 0;
    }
    if (leftTime === undefined) {
      return 1;
    }
    if (rightTime === undefined) {
      return -1;
    }
    return leftTime - rightTime;
  });
  return [...pinned, ...rest];
}
