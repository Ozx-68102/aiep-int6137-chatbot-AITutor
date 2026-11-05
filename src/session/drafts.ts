// 草稿按会话各存各的（N3）：sessionStorage，键名风格对齐 h2bot-unsent
// （src/session/unsent.ts）。刷新不丢、切会话不互相清。
//
// 草稿和 unsent 是两回事：unsent 管「已提交但没送达」（被踢存回、登录放回，
// 恢复时优先于草稿）；草稿只管「输入框里正打着的字」。
const prefix = 'h2bot-draft:';

/** 会话 id 对应的草稿键；「新对话」还没有会话 id，用固定后缀 new。 */
export function draftKey(sessionId: string | null): string {
  return prefix + (sessionId ?? 'new');
}

export function readDraft(sessionId: string | null): string {
  try {
    return sessionStorage.getItem(draftKey(sessionId)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(sessionId: string | null, text: string): void {
  try {
    if (text.trim() === '') {
      sessionStorage.removeItem(draftKey(sessionId));
    } else {
      sessionStorage.setItem(draftKey(sessionId), text);
    }
  } catch {
    // 存不下（隐私模式、配额满）就算了：草稿丢了不阻塞输入。
    return;
  }
}

export function clearDraft(sessionId: string | null): void {
  try {
    sessionStorage.removeItem(draftKey(sessionId));
  } catch {
    return;
  }
}

/** 清空所有会话的草稿：主动退出登录时调用（共用电脑不留半截字）。被踢不清。 */
export function clearAllDrafts(): void {
  try {
    const doomed: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key !== null && key.startsWith(prefix)) {
        doomed.push(key);
      }
    }
    for (const key of doomed) {
      sessionStorage.removeItem(key);
    }
  } catch {
    return;
  }
}
