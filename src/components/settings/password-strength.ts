/**
 * 密码强度检测：只是给用户的建议，不拦提交（前端是提示，后端是门槛）。
 * 注册和改密两个表单共用。
 *
 * 这个文件同时放着两件跟强度无关、但同样要两边共用的事：输入过滤
 *（allowedChars）和提交前的硬门槛（passwordRejected）。它们跟后端的
 * check_password_policy 对齐，聊天侧的改密页和控制台的改密弹窗都用这一份。
 *
 * 评分用 zxcvbn-ts（Dropbox zxcvbn 的 TypeScript 移植）：像破解工具那样
 * 拿字典（泄露密码榜、词、姓名、拼音）加模式（键盘序、连续、重复、日期、
 * l33t）估猜测次数，score 0–4，映射到我们的四档（0→太弱、1→弱、2→一般、
 * 3 和 4→强）。不按长度分档：6 位的好密码不该被判弱，长而好记的口令该得高分。
 *
 * 字典有好几 MB，动态 import 懒加载：打开改密弹窗才开始拉取，不进首屏包。
 *
 * 三条显示规则跟后端硬门槛对齐（后端会拒的，提示不能误导用户）：
 * 不足 6 位、包含用户名、命中弱口令拒绝名单，直接「太弱」。
 */

import type {ZxcvbnFactory} from '@zxcvbn-ts/core';

export type StrengthScore = 0 | 1 | 2 | 3;

/**
 * 弱口令拒绝名单：命中直接「太弱」，改密页提交前也拿它做硬拦截。
 * 跟 server/src/server/passwords.py 的 _WEAK_PASSWORDS 保持一致，改一处必须改两处。
 */
const WEAK_PASSWORDS: ReadonlySet<string> = new Set([
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  '111111',
  '000000',
  '666666',
  '888888',
  'password',
  'passw0rd',
  'abc123',
  'a123456',
  '123abc',
  'qwerty',
  'qwertyuiop',
  '123123',
  '112233',
  'admin123',
  'iloveyou',
]);

/** 是不是命中弱口令拒绝名单（大小写不敏感，跟后端同一套比法）。 */
export function isWeakPassword(password: string): boolean {
  return WEAK_PASSWORDS.has(password.toLowerCase());
}

/**
 * 密码框只收英文键盘上打得出来的连续字符（可打印 ASCII，不含空格）：
 * 空格、中文、emoji、全角符号在输入时直接滤掉，不报错。中文多半是粘贴
 * 或输入法误触带进来的，静默丢掉比弹一句红字友好。
 * 后端 check_password_policy 有同一条硬门槛。
 *
 * 旧密码框也过滤：数据库里的密码都是经过策略存进去的，不含空格和非 ASCII，
 * 过滤不会把人锁在外面。登录页的密码框才是真不能过滤的那个——它要能
 * 原样对上任何历史密码，所以那边不动。
 */
export function allowedChars(value: string): string {
  return value.replace(/[^\x21-\x7E]/g, '');
}

/** 密码最大长度：跟后端 check_password_policy 同一道门槛。 */
export const MAX_PASSWORD_LENGTH = 128;

/** 客户端硬门槛的拒绝原因；显示文案按语言本地化（auth 域的两个键）。 */
export type PasswordRejection = 'tooShort' | 'tooCommon';

/**
 * 客户端硬门槛，提交前拦截：门槛语义跟后端 check_password_policy 一字不差
 *（分工见 docs/ACCOUNT_MANAGEMENT.md，前端是提示、后端是门槛；能在本地
 * 判定的提前拦掉，省一个来回，后端仍然会再拦一道）。空格和非 ASCII 在输入
 * 时就被 allowedChars 滤掉了，到不了这里；含用户名由后端拦，它的消息经
 * error 原样显示。弱口令拒绝名单就在本文件里，不再写第二份。
 *
 * 最小长度按账号角色分：学生（chat）6 位，管理员（admin）8 位，跟后端
 * min_length_for_role 同一道门槛，由调用方传进来。
 *
 * 返回的是拒绝原因，不是现成文案：文案在 i18n 的 auth 域里三语齐
 *（passwordTooShort / passwordTooCommon），简中文案仍与后端拒绝消息
 * 逐字一致，{min}/{max} 占位符由 format 填。
 */
export function passwordRejected(password: string, minLength: number): PasswordRejection | null {
  if (password.length < minLength || password.length > MAX_PASSWORD_LENGTH) {
    return 'tooShort';
  }
  if (isWeakPassword(password)) {
    return 'tooCommon';
  }
  return null;
}

/**
 * 拼音常见密码的小字典，补官方字典的盲区：language-zh 的词条是带声调的
 * 拼音（wǒ、nǐ），匹配不上用户实际输入的无声调连写——实测不加这份的话
 * woaini1314 会被评成「强」。按常见程度排，越靠前猜测数越低。
 * 词条来源：中文网站泄露密码榜的常见项、密码研究的拼音词表
 * （woaini/mima/baobei/haha 这类）、这个年龄段小孩爱用的词。
 */
const PINYIN_COMMON = [
  'woaini',
  'woaini1314',
  'woaini520',
  '5201314',
  '1314520',
  '5211314',
  '520',
  '1314',
  '7758521',
  'aini',
  'woai',
  'mima',
  'wodemima',
  'wodemingzi',
  'mingzi',
  'woshishui',
  'baobei',
  'qinai',
  'qinaide',
  'laopo',
  'laogong',
  'nihao',
  'haha',
  'hahaha',
  'hehe',
  'xixi',
  '2333',
  '666',
  '886',
  '9494',
  'xiaoming',
  'xiaohong',
  'xiaogang',
  'xiaoli',
  'xiaohua',
  'xiaobai',
  'xiaohuang',
  'dahuang',
  'gougou',
  'maomi',
  'xiaomao',
  'xiongmao',
  'meinv',
  'shuaige',
  'baba',
  'mama',
  'yeye',
  'nainai',
  'gege',
  'jiejie',
  'didi',
  'meimei',
  'laoshi',
  'tongxue',
  'pengyou',
  'zuoye',
  'kaoshi',
  'xuexi',
  'shangxue',
  'youxi',
  'wangzhe',
  'rongyao',
  'wangzherongyao',
  'hepingjingying',
  'jingying',
  'kuaile',
  'kaixin',
  'gaoxing',
  'keai',
  'xihuan',
  'shengri',
  'xinnian',
  'shengrikuaile',
  'xinniankuaile',
  'zhongguo',
  'beijing',
  'shanghai',
  'guangzhou',
  'xianggang',
  'chifan',
  'shuijiao',
];

let checker: ZxcvbnFactory | null = null;
let loading: Promise<void> | null = null;

/** 加载字典、建检查器。幂等：并发和重复调用共享同一次加载。 */
export function loadPasswordStrength(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        const [core, common, en, zh] = await Promise.all([
          import('@zxcvbn-ts/core'),
          import('@zxcvbn-ts/language-common'),
          import('@zxcvbn-ts/language-en'),
          import('@zxcvbn-ts/language-zh'),
        ]);
        checker = new core.ZxcvbnFactory({
          dictionary: {
            ...common.dictionary,
            ...en.dictionary,
            ...zh.dictionary,
            'pinyin-common': PINYIN_COMMON,
          },
          graphs: common.adjacencyGraphs,
        });
      } catch (error) {
        // 加载失败（比如切包瞬间网络断了）就把状态还原，下次打开弹窗再试。
        loading = null;
        throw error;
      }
    })();
  }
  return loading;
}

/** 字典好了没有。组件拿它做初始状态：第二次打开弹窗不用再等加载。 */
export function passwordStrengthReady(): boolean {
  return checker !== null;
}

/**
 * 给一个密码打分。字典还没加载完返回 null（组件先不画表，加载完再画）。
 * 用户名同时传给 zxcvbn 的 userInputs：含用户名的密码猜测数会大降。
 */
export function passwordStrength(password: string, username: string | null): StrengthScore | null {
  if (password === '') {
    return 0;
  }
  // 后端硬门槛之下，直接「太弱」：不用等字典，也不能让字典把它抬上去。
  if (password.length < 6) {
    return 0;
  }
  const named = username !== null && username !== '';
  if (named && password.toLowerCase().includes((username ?? '').toLowerCase())) {
    return 0;
  }
  if (isWeakPassword(password)) {
    return 0;
  }
  if (checker === null) {
    return null;
  }
  const score = checker.check(password, named ? [username ?? ''] : []).score;
  if (score >= 3) {
    return 3;
  }
  if (score === 2) {
    return 2;
  }
  if (score === 1) {
    return 1;
  }
  return 0;
}
