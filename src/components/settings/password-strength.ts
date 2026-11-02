/**
 * 密码强度检测：只是给用户的建议，不拦提交（前端是提示，后端是门槛）。
 * 注册和改密两个表单共用。
 *
 * 打分思路参照 zxcvbn 和 NIST SP 800-63B：**不按长度分档卡人**。
 * 先估「猜到这个密码要花多大功夫」——长度 × 用到的字符集大小，换算成
 * 比特数；再用破解工具实际会先试的模式把分压下来：常见密码（含 leet
 * 变体）、键盘序列、连续/重复字符、年份结尾、纯数字（生日、电话号）。
 * 这样 8 位的合格密码能拿到「一般」，长而好记的口令（词组、带空格）
 * 能拿到「强」——对小学生和他们的记性友好，也符合 NIST 不强制字符
 * 组合的建议。分数 0–3 对应 太弱/弱/一般/强。
 */

export type StrengthScore = 0 | 1 | 2 | 3;

// 常见弱密码。整个密码小写后精确比对，leet 归一化之后再比一遍。
const COMMON_PASSWORDS = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345',
  '123123', '121212', '112233', '654321', '666666', '888888', '88888888',
  '000000', '111111', '11111111',
  'password', 'password1', 'password123', 'passw0rd', 'pass123',
  'qwerty', 'qwerty123', 'qwertyui', 'qwertyuiop', 'qazwsx',
  'abc123', 'abc1234', 'abc12345', 'abc123456', 'abcd1234',
  'a123456', 'a1234567', 'a12345678', 'aa123456',
  'admin', 'admin123', 'admin888', 'letmein', 'welcome', 'welcome1',
  'monkey', 'dragon', 'sunshine', 'princess', 'starwars',
  'superman', 'batman', 'spiderman', 'pokemon', 'pikachu',
  'hello123', 'hellokitty', 'iloveyou', 'iloveu',
  '520520', '1314520', '5201314', 'woaini', 'woaini1314', 'woaini520',
  'wodemima', 'mima123', 'test', 'test123', 'test1234',
  'minecraft', 'roblox', 'fortnite',
]);

// 键盘上挨着的序列：破解字典里排得最靠前的那几条。
const KEYBOARD_RUNS = [
  'qwerty', 'asdfgh', 'zxcvbn', 'qazwsx', '1qaz2wsx', 'qwer', 'asdf', 'zxcv', '1q2w3e',
];

// leet 归一化的两套映射：1 既可能当 i 也可能当 l。
const LEET_TO_I: Record<string, string> = {
  '@': 'a', '4': 'a', '0': 'o', '1': 'i', '$': 's', '5': 's', '7': 't', '!': 'i',
};
const LEET_TO_L: Record<string, string> = {...LEET_TO_I, '1': 'l'};

export function passwordStrength(password: string, username: string | null): StrengthScore {
  if (password === '') {
    return 0;
  }
  const lower = password.toLowerCase();
  if (username !== null && username !== '' && lower.includes(username.toLowerCase())) {
    return 0;
  }
  // 不足 8 位过不了后端的硬门槛，直接「太弱」。
  if (password.length < 8) {
    return 0;
  }
  if (isCommon(lower)) {
    return 0;
  }

  let bits = password.length * Math.log2(charsetSize(password));
  // 带年份（生日、入学年）：这类结尾是猜密码的第一批候选。
  if (/(?:19|20)\d\d/.test(password)) {
    bits -= 10;
  }
  const run = longestRun(password);
  if (run >= 4) {
    bits -= 25;
  } else if (run === 3) {
    bits -= 12;
  }
  if (KEYBOARD_RUNS.some((sequence) => lower.includes(sequence))) {
    bits -= 25;
  }
  // 纯数字封顶：生日和电话号在社工字典里，再长也不算强。
  if (/^[0-9]+$/.test(password)) {
    bits = Math.min(bits, 30);
  }

  if (bits < 28) {
    return 0;
  }
  if (bits < 40) {
    return 1;
  }
  if (bits < 60) {
    return 2;
  }
  return 3;
}

/** 是不是常见密码：原样比一遍，两套 leet 归一化之后各比一遍。 */
function isCommon(lower: string): boolean {
  if (COMMON_PASSWORDS.has(lower)) {
    return true;
  }
  return (
    COMMON_PASSWORDS.has(normalizeLeet(lower, LEET_TO_I)) ||
    COMMON_PASSWORDS.has(normalizeLeet(lower, LEET_TO_L))
  );
}

/** leet 归一化：替换形近字符，丢掉装饰符号（password! 和 password 算同一个）。 */
function normalizeLeet(lower: string, map: Record<string, string>): string {
  let out = '';
  for (const char of lower) {
    const mapped = map[char];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    if ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) {
      out += char;
    }
  }
  return out;
}

/**
 * 用到的字符集有多大：数字 10、小写 26、大写 26、ASCII 符号 33。
 * 中日韩文字单独算一大类（常用字上千，不能按 ASCII 的几十算，
 * 不然一个 8 位的中文密码会被严重低估）；其他非 ASCII 文字给 100。
 */
function charsetSize(password: string): number {
  let size = 0;
  if (/[0-9]/.test(password)) {
    size += 10;
  }
  if (/[a-z]/.test(password)) {
    size += 26;
  }
  if (/[A-Z]/.test(password)) {
    size += 26;
  }
  if (/[!-/:-@[-`{-~]/.test(password)) {
    size += 33;
  }
  if (/[\u3400-\u9FFF\uF900-\uFAFF]/.test(password)) {
    size += 1000;
  } else if (/[\u0080-\uFFFF]/.test(password)) {
    size += 100;
  }
  return size === 0 ? 10 : size;
}

/** 最长的连续（升序或降序）或重复字符段有多长。 */
function longestRun(password: string): number {
  const lower = password.toLowerCase();
  let longest = 1;
  let ascending = 1;
  let descending = 1;
  let repeated = 1;
  for (let i = 1; i < lower.length; i += 1) {
    const previous = lower.charCodeAt(i - 1);
    const current = lower.charCodeAt(i);
    ascending = current === previous + 1 ? ascending + 1 : 1;
    descending = current === previous - 1 ? descending + 1 : 1;
    repeated = current === previous ? repeated + 1 : 1;
    longest = Math.max(longest, ascending, descending, repeated);
  }
  return longest;
}
