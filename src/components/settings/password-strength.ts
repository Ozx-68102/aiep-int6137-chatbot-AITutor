/**
 * 密码强度检测：只是给用户的建议，不拦提交（前端是提示，后端是门槛）。
 * 注册和改密两个表单共用。
 *
 * 评分用 zxcvbn-ts（Dropbox zxcvbn 的 TypeScript 移植）：像破解工具那样
 * 拿字典（泄露密码榜、词、姓名、拼音）加模式（键盘序、连续、重复、日期、
 * l33t）估猜测次数，score 0–4，映射到我们的四档（0→太弱、1→弱、2→一般、
 * 3 和 4→强）。不按长度分档：6 位的好密码不该被判弱，长而好记的口令该得高分。
 *
 * 字典有好几 MB，动态 import 懒加载：打开改密弹窗才开始拉取，不进首屏包。
 *
 * 三条显示规则跟后端硬门槛对齐（后端会拒的，提示不能骗人）：
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
