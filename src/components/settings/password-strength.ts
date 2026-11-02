/**
 * 密码强度检测：只是给用户的建议，不拦提交（前端是提示，后端是门槛）。
 * 注册和改密两个表单共用。
 *
 * 评分规则（0–3 对应 太弱/弱/一般/强）：
 * - 基础分按长度分档：<8 得 0，8–11 得 1，12–15 得 2，≥16 得 3。
 * - 字符多样性加分：小写/大写/数字/符号四类里占三类 +1，四类全占 +2。
 * - 常见模式扣分：出现长度 ≥3 的连续字符（abc、123，升序降序都算）
 *   或重复字符（aaa）扣 1 分。
 * - 密码里包含用户名（不分大小写）直接压到 0。
 * - 总分截在 0–3；空串返回 0（组件层面没输入时不显示强度表）。
 */

export type StrengthScore = 0 | 1 | 2 | 3;

export function passwordStrength(password: string, username: string | null): StrengthScore {
  if (password === '') {
    return 0;
  }
  if (
    username !== null &&
    username !== '' &&
    password.toLowerCase().includes(username.toLowerCase())
  ) {
    return 0;
  }

  // 不足 8 位过不了后端的硬门槛：直接按「太弱」算，
  // 不让字符多样性的加分把它抬上去。
  if (password.length < 8) {
    return 0;
  }

  let score = 1;
  if (password.length >= 12) {
    score = 2;
  }
  if (password.length >= 16) {
    score = 3;
  }

  const kinds = varietyKinds(password);
  if (kinds >= 4) {
    score += 2;
  } else if (kinds >= 3) {
    score += 1;
  }

  if (hasCommonRun(password)) {
    score -= 1;
  }

  if (score <= 0) {
    return 0;
  }
  if (score === 1) {
    return 1;
  }
  if (score === 2) {
    return 2;
  }
  return 3;
}

/** 小写/大写/数字/符号四类里，这个密码占了几类。 */
function varietyKinds(password: string): number {
  let kinds = 0;
  if (/[a-z]/.test(password)) {
    kinds += 1;
  }
  if (/[A-Z]/.test(password)) {
    kinds += 1;
  }
  if (/[0-9]/.test(password)) {
    kinds += 1;
  }
  if (/[^a-zA-Z0-9]/.test(password)) {
    kinds += 1;
  }
  return kinds;
}

/** 有没有长度 ≥3 的连续字符（升序或降序）或重复字符。 */
function hasCommonRun(password: string): boolean {
  let ascending = 1;
  let descending = 1;
  let repeated = 1;
  for (let i = 1; i < password.length; i += 1) {
    const previous = password.charCodeAt(i - 1);
    const current = password.charCodeAt(i);
    ascending = current === previous + 1 ? ascending + 1 : 1;
    descending = current === previous - 1 ? descending + 1 : 1;
    repeated = current === previous ? repeated + 1 : 1;
    if (ascending >= 3 || descending >= 3 || repeated >= 3) {
      return true;
    }
  }
  return false;
}
