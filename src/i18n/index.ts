import type {Locale} from '../type/locale.ts';
import {admin} from './admin.ts';
import {auth} from './auth.ts';
import {chat} from './chat.ts';
import {common} from './common.ts';
import {errors} from './errors.ts';

/**
 * 界面文案按功能域拆成五个文件（common/chat/auth/admin/errors），每个文件里
 * 三语放在一起，方便一屏核对三语齐不齐。这个文件把它们合并成一张
 * translations 表，消费者照旧 translations[locale] 取当前语言的词条。
 */

/** 语言菜单里的可选项：label 是语言自己的名字，不随界面语言翻译。 */
export const locales = [
  {id: 'zh-CN', label: '简体中文'},
  {id: 'zh-TW', label: '繁體中文'},
  {id: 'en', label: 'English'},
] as const satisfies readonly {id: Locale; label: string}[];

// 简中的合并结果是全部文案形状的唯一事实来源：Messages 类型从它推导。
// 每个域文件里繁中/英文已经按各自的基准显式标注过，这里再对合并结果
// 标注一次 Messages——任何一键在任何一种语言里缺失都是 tsc 编译错误，
// 不会留到运行时变成 undefined、渲染成空白。
const zhCN = {
  ...common['zh-CN'],
  ...chat['zh-CN'],
  ...auth['zh-CN'],
  ...admin['zh-CN'],
  ...errors['zh-CN'],
};

/** 全部界面文案的形状（由简中对象推导；缺键、拼错键都是编译错误）。 */
export type Messages = typeof zhCN;

const zhTW: Messages = {
  ...common['zh-TW'],
  ...chat['zh-TW'],
  ...auth['zh-TW'],
  ...admin['zh-TW'],
  ...errors['zh-TW'],
};

const en: Messages = {
  ...common.en,
  ...chat.en,
  ...auth.en,
  ...admin.en,
  ...errors.en,
};

export const translations: Record<Locale, Messages> = {'zh-CN': zhCN, 'zh-TW': zhTW, en};
